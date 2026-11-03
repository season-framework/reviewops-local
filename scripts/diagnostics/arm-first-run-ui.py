#!/usr/bin/env python3
"""Prepare a private public package and run one ARM missing-CLI first-launch UI check."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit, urljoin
import zipfile

BASE = '84042d8bb8d7d6f758d936d63f41fc325349550e'
REPOSITORY = 'season-framework/reviewops-local'
BRANCH = 'refs/heads/codex/issue52-arm-missing-cli-ui'
SCENARIO = 'missing-cli-first-run'
ADDITIONS = {
    '.github/workflows/arm-first-run-ui.yml',
    'scripts/diagnostics/arm-first-run-ui.py',
    'scripts/diagnostics/arm-first-run-ui.mjs',
    'scripts/diagnostics/arm-first-run-ui-package.json',
    'tests/arm-first-run-ui.test.mjs',
    'docs/diagnostics/arm-first-run-ui.md',
}


def need(value, message):
    if not value:
        raise RuntimeError(message)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            digest.update(block)
    return digest.hexdigest()


def pin(path):
    path = Path(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)}


def write(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def public_zip(url, destination, expected):
    """Anonymous, bounded request chain; signed CDN query values are never retained."""
    hops = []

    class Redirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, target):
            target = urljoin(request.full_url, target)
            check(target)
            need(len(hops) < 5, 'Public package redirect cap')
            hops.append({'host': urlsplit(request.full_url).hostname, 'status': code})
            return super().redirect_request(request, response, code, message, headers, target)

        def http_error_302(self, request, response, code, message, headers):
            try:
                target = headers.get('Location')
                need(isinstance(target, str) and target, 'Missing public package redirect')
                redirected = self.redirect_request(request, response, code, message, headers, target)
            finally:
                response.close()  # Never consume an unbounded redirect response body.
            return self.parent.open(redirected, timeout=request.timeout)

        http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    class Errors(urllib.request.HTTPDefaultErrorHandler):
        def http_error_default(self, request, response, code, message, headers):
            response.close()
            raise RuntimeError('Public package HTTP status ' + str(code))

    def check(value):
        parsed = urlsplit(value)
        need(parsed.scheme == 'https' and parsed.hostname in {'github.com', 'release-assets.githubusercontent.com'}
             and not parsed.username and not parsed.password and parsed.port in (None, 443) and not parsed.fragment,
             'Unexpected public package destination')
        need(parsed.hostname != 'github.com' or not parsed.query, 'Unexpected GitHub package query')

    check(url)
    started, observed = stamp(), 0
    opener = urllib.request.build_opener(Redirects(), Errors())
    request = urllib.request.Request(url, headers={'User-Agent': 'ReviewOps-first-run-QA/1', 'Accept-Encoding': 'identity'})
    with opener.open(request, timeout=45) as response, Path(destination).open('xb') as output:
        need(response.status == 200 and response.headers.get('Content-Encoding') in (None, 'identity'), 'Public package response')
        declared = response.headers.get('Content-Length')
        need(declared is None or declared.isdigit() and int(declared) == expected['bytes'], 'Public package declared size')
        while True:
            block = response.read(min(65536, expected['bytes'] + 1 - observed))
            if not block:
                break
            observed += len(block)
            need(observed <= expected['bytes'], 'Public package byte cap')
            output.write(block)
        hops.append({'host': urlsplit(response.url).hostname, 'status': response.status})
    need(response.closed and observed == expected['bytes'] and sha(destination) == expected['sha256'], 'Actual public package bytes differ')
    return {'startedAt': started, 'completedAt': stamp(), 'hops': hops, 'bytes': observed,
            'sha256': sha(destination), 'EOF': True, 'responseClosed': response.closed,
            'requestChains': 1, 'retry': 0, 'authorizationOrCookies': False,
            'perSocketTimeoutSeconds': 45, 'hardEndToEndNetworkDeadline': False}


def reconcile_original(owner, output):
    """After a failed stage, drain only its original pipes without retaining extra bytes."""
    child, selector, eof = owner['child'], owner['selector'], owner['eof']
    discarded = {'stdout': 0, 'stderr': 0}
    try:
        while selector.get_map() or child.poll() is None:
            if not selector.get_map():
                time.sleep(.2)
                continue
            for key, _ in selector.select(.2):
                block = os.read(key.fd, 65536)
                if block:
                    discarded[key.data] += len(block)
                else:
                    eof[key.data] = True
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
        code = child.wait()
        write(output / (owner['label'] + '-reconciled-after-failure.json'), {
            'pid': child.pid, 'wait': code, 'poll': child.poll(), 'originalPopenWaited': True,
            'stdoutEOF': eof['stdout'], 'stderrEOF': eof['stderr'],
            'originalStdoutClosed': child.stdout.closed, 'originalStderrClosed': child.stderr.closed,
            'additionalBytesDiscarded': discarded, 'originalFailureRemainsFailure': True,
            'signals': 0, 'retry': 0, 'completedAt': stamp(),
        })
        selector.close()
    except Exception as error:
        write(output / (owner['label'] + '-drain-unconfirmed.json'), {
            'pid': child.pid, 'poll': child.poll(), 'EOF': eof,
            'additionalBytesDiscarded': discarded, 'errorType': type(error).__name__,
            'originalFailureRemainsFailure': True, 'signals': 0, 'retry': 0,
        })
        # An unreadable pipe cannot be replaced with a fabricated EOF or PID lookup.
        while True:
            time.sleep(.2)


def main():
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64', 'A genuine ARM macOS runner is required')
    root = Path(__file__).resolve().parents[2]
    reviewed = os.environ.get('REVIEWED_COMMIT', '')
    need(re.fullmatch('[a-f0-9]{40}', reviewed) and reviewed == os.environ.get('GITHUB_SHA'), 'Exact reviewed harness commit required')
    need(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REF') == BRANCH
         and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Reviewed manual branch, first attempt only')
    need(os.environ.get('GITHUB_WORKFLOW_REF') == REPOSITORY + '/.github/workflows/arm-first-run-ui.yml@' + BRANCH, 'Unexpected workflow source')
    need(os.environ.get('DIAGNOSTIC_SCENARIO') == SCENARIO, 'Explicit reviewed missing-CLI scenario required')
    node = Path(os.environ['DIAGNOSTIC_NODE']).resolve(strict=True)
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    evidence = root / 'test-results/arm-first-run-ui'
    evidence.mkdir(parents=True, exist_ok=False)
    output = evidence / 'driver'
    output.mkdir()
    private = Path(tempfile.mkdtemp(prefix='reviewops-first-run-', dir=runner_temp)).resolve()
    home, code, cwd = private / 'home', private / 'home/.codex', private / 'cwd'
    for folder in (home / 'Applications', code, home / '.ssh', cwd):
        folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    home.chmod(0o700)
    (code / 'config.toml').write_text('cli_auth_credentials_store = "file"\n')
    (code / 'config.toml').chmod(0o600)
    ssh = home / '.ssh/config'
    ssh.write_text('')
    ssh.chmod(0o600)
    env = {'HOME': str(home), 'CODEX_HOME': str(code), 'TMPDIR': str(private),
           'RUNNER_TEMP': str(runner_temp),
           'PATH': str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC'}
    tools, held = [], []
    result = {'ok': False, 'source': BASE, 'harnessSource': reviewed, 'startedAt': stamp(),
              'scenario': SCENARIO, 'maximumAppLaunchRequests': 1, 'actualUIDriverInvocations': 0,
              'vendorPrepared': False, 'vendorDownloadRequests': 0, 'harnessSignalsRequested': 0, 'retries': 0}

    def tool(label, argv, seconds=60):
        started, deadline = stamp(), time.monotonic() + seconds
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        selector = selectors.DefaultSelector()
        owner_held = False
        eof, observed = {'stdout': False, 'stderr': False}, {'stdout': 0, 'stderr': 0}
        files = {name: output / (label + '.' + name) for name in eof}
        with files['stdout'].open('xb') as stdout, files['stderr'].open('xb') as stderr:
            sinks = {'stdout': stdout, 'stderr': stderr}
            for name, pipe in [('stdout', child.stdout), ('stderr', child.stderr)]:
                selector.register(pipe, selectors.EVENT_READ, name)
            try:
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    need(remaining > 0, 'Original tool observation deadline')
                    ready = selector.select(remaining)
                    need(ready, 'Original tool observation deadline')
                    for key, _ in ready:
                        name = key.data
                        block = os.read(key.fd, min(65536, 4 * 1024**2 + 1 - observed[name]))
                        observed[name] += len(block)
                        need(observed[name] <= 4 * 1024**2, 'Original tool output cap')
                        if block:
                            sinks[name].write(block)
                        else:
                            eof[name] = True
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                code_value = child.wait(timeout=max(.001, deadline - time.monotonic()))
            except Exception:
                owner_held = True
                held.append({'child': child, 'selector': selector, 'eof': eof, 'label': label})
                write(output / (label + '-held.json'), {'pid': child.pid, 'argv': argv, 'startedAt': started,
                      'poll': child.poll(), 'EOF': eof, 'observedBytes': observed, 'held': True, 'signals': 0, 'retry': 0})
                raise RuntimeError('Original tool or streams unconfirmed; no kill or retry')
            finally:
                if not owner_held:
                    selector.close()
        receipt = {'pid': child.pid, 'argv': argv, 'startedAt': started, 'completedAt': stamp(),
                   'wait': code_value, 'poll': child.poll(), 'stdoutEOF': eof['stdout'], 'stderrEOF': eof['stderr'],
                   'originalStdoutClosed': child.stdout.closed, 'originalStderrClosed': child.stderr.closed,
                   'stdoutFileClosed': stdout.closed, 'stderrFileClosed': stderr.closed, 'signals': 0, 'retry': 0}
        tools.append(receipt)
        write(output / (label + '-receipt.json'), receipt)
        need(code_value == 0 and child.poll() == 0, 'Original tool failed: ' + label)
        return files['stdout'].read_bytes(), files['stderr'].read_bytes()

    try:
        git = lambda label, *args: tool(label, ['/usr/bin/git', '-C', str(root), *args])[0]
        need(git('source-head', 'rev-parse', 'HEAD').decode().strip() == reviewed, 'Actual harness HEAD differs')
        need(not git('source-clean', 'status', '--porcelain=v1'), 'Harness checkout is not clean')
        old_rows = git('source-base-tree', 'ls-tree', '-rz', BASE).split(b'\0')
        new_rows = git('source-harness-tree', 'ls-tree', '-rz', 'HEAD').split(b'\0')
        table = lambda rows: {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0] for row in rows if row}
        old, current = table(old_rows), table(new_rows)
        added = set(current) - set(old)
        need(len(old) == 419 and all(current.get(name) == value for name, value in old.items())
             and added == ADDITIONS, 'Only the declared diagnostic additions may differ from stable source419')
        source_guard = {'baseSource': BASE, 'harnessSource': reviewed, 'baselineFiles': 419,
                        'oldFilesUnchanged': True, 'addedPaths': sorted(added)}
        write(output / 'source-guard.json', source_guard)
        native, _ = tool('native-node', [str(node), '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node,executable:process.execPath,home:require("node:os").homedir()}))'])
        native = json.loads(native)
        need(native['platform'] == 'darwin' and native['arch'] == 'arm64' and native['version'] == '24.22.2'
             and Path(native['executable']).resolve() == node and native['home'] == str(home), 'Actual native Node identity differs')
        native_identity = {**pin(node), 'version': native['version'], 'platform': native['platform'], 'arch': native['arch']}
        write(output / 'native-node.json', native_identity)
        reference = json.loads((root / 'scripts/diagnostics/arm-first-run-ui-package.json').read_bytes())
        need(reference['source'] == BASE and reference['sourceFiles'] == 419 and reference['version'] == '1.4.0', 'Accepted package source differs')
        package = reference['package']
        need(package['name'] == 'ReviewOps-1.4.0-arm64.zip' and package['url'] == 'https://github.com/season-framework/reviewops-local/releases/download/v1.4.0/' + package['name']
             and package['bytes'] == 133829932 and package['sha256'] == '5e188c626666ff132dabc15143452138fc4fa6597a7423aba5ed07216ab03e0c', 'Accepted public package differs')
        archive = private / package['name']
        write(output / 'public-package-download.json', public_zip(package['url'], archive, package))
        with zipfile.ZipFile(archive) as compressed:
            rows = compressed.infolist()
            names = [row.filename for row in rows]
            need(len(rows) <= 50000 and len(names) == len(set(names)) and sum(row.file_size for row in rows) <= 3 * 1024**3, 'Package archive cap or duplicate path')
            need(all(not name.startswith('/') and '\\' not in name and all(part not in ('.', '..') for part in name.rstrip('/').split('/')) for name in names), 'Unsafe package archive path')
        unpacked = private / 'package'
        unpacked.mkdir(mode=0o700)
        tool('extract-package', ['/usr/bin/ditto', '-xk', str(archive), str(unpacked)])
        app = unpacked / 'ReviewOps.app'
        need(app.is_dir() and not app.is_symlink(), 'Expected genuine ReviewOps app')
        asar = app / reference['asar']['relativePath']
        executable = app / reference['executable']['relativePath']
        for path, expected in [(asar, reference['asar']), (executable, reference['executable'])]:
            need(path.is_file() and not path.is_symlink() and path.stat().st_size == expected['bytes'] and sha(path) == expected['sha256'], 'Accepted package member differs')
        architecture, _ = tool('package-architecture', ['/usr/bin/lipo', '-archs', str(executable)])
        need(architecture.decode().split() == ['arm64'], 'Actual package executable is not native ARM')
        # This lane prepares no vendor app, DMG, CLI, mount or credentials.
        need(not any((home / 'Applications').iterdir()), 'Private Applications must be empty')
        binding = {'schema': 1, 'scenario': SCENARIO, 'approvedForOneMissingCLIUILaunch': True,
                   'allowNormalStartupMetadata': True,
                   'root': str(root), 'source': BASE, 'harnessSource': reviewed, 'sourceGuard': source_guard,
                   'privateRoot': str(private), 'home': str(home), 'codeHome': str(code), 'dataDir': str(private / 'data'),
                   'sshConfig': str(ssh), 'packageApp': str(app), 'packageZipPin': pin(archive), 'expectedASARPin': pin(asar),
                   'output': str(evidence / 'ui'), 'actualNodeIdentity': native_identity}
        binding_path = private / 'UI-binding.json'
        write(binding_path, binding)
        write(output / 'UI-binding.json', binding)
        result['actualUIDriverInvocations'] = 1
        tool('missing-cli-packaged-ui', [str(node), str(root / 'scripts/diagnostics/arm-first-run-ui.mjs'), '--run', str(binding_path)], seconds=240)
        need(not any((home / 'Applications').iterdir()) and not (code / 'auth.json').exists(),
             'Unexpected private vendor app or authentication')
        need(sha(asar) == reference['asar']['sha256'] and sha(executable) == reference['executable']['sha256'], 'ReviewOps package members changed')
        need(not git('source-final-clean', 'status', '--porcelain=v1'), 'Tracked source changed during diagnostic')
        result.update(ok=True, packageSHA256=sha(archive), privateApplicationsStillEmpty=True, packageMembersUnchanged=True)
    except Exception as error:
        result.update(errorType=type(error).__name__, error=str(error))
    finally:
        result.update(completedAt=stamp(), metadataTools=tools, heldOriginalOwners=[owner['child'].pid for owner in held],
                      vendorInternalChildClosureClaimed=False, externalTrafficAbsenceClaimed=False)
        write(output / 'driver-result.json', result)
        print(json.dumps({key: result[key] for key in ('ok', 'source', 'harnessSource', 'scenario', 'actualUIDriverInvocations')}))
        for owner in held:
            reconcile_original(owner, output)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
