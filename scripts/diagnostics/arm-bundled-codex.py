#!/usr/bin/env python3
"""One manual, source-bound ARM vendor-bundle diagnostic. No work on import."""
from pathlib import Path
import datetime
import hashlib
import http.client
import json
import os
import plistlib
import re
import selectors
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, urljoin

BASE = '9e8b599f5756e5b0747ec049b61ff59d89058c2f'
BRANCH = 'refs/heads/codex/issue52-arm-bundled-cli-diagnostic'
REPOSITORY = 'season-framework/reviewops-local'
EXTRA = {
    '.github/workflows/arm-bundled-codex-diagnostic.yml',
    'scripts/diagnostics/arm-bundled-codex.py',
    'scripts/diagnostics/arm-bundled-codex-probe.mjs',
    'scripts/diagnostics/arm-bundled-codex-source.json',
    'docs/diagnostics/arm-bundled-codex.md',
}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(file):
    result = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write(file, value):
    with Path(file).open('x') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def source_guard(root):
    pins = json.loads((root / 'scripts/diagnostics/arm-bundled-codex-source.json').read_text())
    require(pins['source'] == BASE and len(pins['files']) == 408, 'Wrong production source pins')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=root).decode().strip()
    source = git('rev-parse', 'HEAD')
    require(re.fullmatch('[a-f0-9]{40}', source) and source == os.environ.get('REVIEWED_COMMIT') == os.environ.get('GITHUB_SHA'), 'Wrong reviewed diagnostic source')
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Reruns are not admitted')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and os.environ.get('GITHUB_REF') == BRANCH, 'Manual diagnostic branch only')
    require(os.environ.get('GITHUB_WORKFLOW_REF') == REPOSITORY + '/.github/workflows/arm-bundled-codex-diagnostic.yml@' + BRANCH, 'Wrong manual workflow source')
    require(not git('status', '--porcelain=v1'), 'Diagnostic checkout is not clean')
    subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, source], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tracked = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().rstrip('\0').split('\0'))
    require(tracked == {row['path'] for row in pins['files']} | EXTRA, 'Unexpected diagnostic source set')
    for row in pins['files']:
        file = root / row['path']
        info = file.lstat()
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == row['mode'] and info.st_size == row['bytes'] and digest(file) == row['sha256'], 'Production source changed')
    return source, pins


def owned_mount_device(attachment, mountpoint):
    """Select only the device from this original attach's exact private mountpoint."""
    require(isinstance(mountpoint, str) and mountpoint.startswith('/'), 'Expected an absolute owned mountpoint')
    require(isinstance(attachment, dict) and isinstance(attachment.get('system-entities'), list), 'Unknown original attach metadata')
    owners = [row for row in attachment['system-entities'] if isinstance(row, dict) and row.get('mount-point') == mountpoint]
    require(len(owners) == 1, 'Unknown owned mount identity')
    device = owners[0].get('dev-entry')
    require(isinstance(device, str) and re.fullmatch('/dev/disk[0-9]+s[0-9]+', device), 'Unknown owned mount device')
    return device


def validate_readonly_mount(info, mountpoint, device):
    """Require the actual disk-image identity and explicit Boolean nonwritability."""
    require(isinstance(mountpoint, str) and mountpoint.startswith('/') and isinstance(device, str) and re.fullmatch('/dev/disk[0-9]+s[0-9]+', device), 'Expected the original owned mount identity')
    require(isinstance(info, dict) and info.get('MountPoint') == mountpoint and info.get('DeviceNode') == device and info.get('BusProtocol') == 'Disk Image', 'Owned disk-image identity changed')
    require(all(info.get(key) is False for key in ('Writable', 'WritableMedia', 'WritableVolume')), 'Owned mount is not explicitly non-writable')
    require('ReadOnlyVolume' not in info or info['ReadOnlyVolume'] is True, 'Conflicting read-only metadata')


def bounded_get(url, hosts, limit, seconds, destination=None, response_metadata=None):
    """One request chain; consume at most limit+1 bytes, retaining at most limit."""
    deadline = time.monotonic() + seconds
    hops = []
    for _ in range(5):
        parsed = urlsplit(url)
        require(parsed.scheme == 'https' and parsed.hostname in hosts and not parsed.username and not parsed.password and parsed.port in (None, 443) and not parsed.query and not parsed.fragment, 'Unapproved official URL')
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Official request deadline')
        raw = socket.create_connection((parsed.hostname, 443), timeout=remaining)
        tls = None
        response = None
        timer = None
        deadline_closed = threading.Event()
        try:
            tls = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
            tls.settimeout(max(0.001, deadline - time.monotonic()))
            def expire_owned_socket(owned_socket=tls, owned_event=deadline_closed):
                owned_event.set()
                try:
                    owned_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            timer = threading.Timer(max(0.001, deadline - time.monotonic()), expire_owned_socket)
            timer.daemon = True
            timer.start()
            request = 'GET ' + (parsed.path or '/') + ' HTTP/1.1\r\nHost: ' + parsed.hostname + '\r\nUser-Agent: ReviewOps-ARM-diagnostic/1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n'
            tls.sendall(request.encode('ascii'))
            response = http.client.HTTPResponse(tls)
            response.begin()
            hops.append({'url': url, 'status': response.status})
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                require(location, 'Missing official redirect')
                url = urljoin(url, location)
                continue  # Do not consume an unbounded redirect body.
            require(response.status == 200 and response.getheader('Content-Encoding') in (None, 'identity'), 'Unexpected official response')
            length = response.getheader('Content-Length')
            if response_metadata is not None:
                write(response_metadata, {
                    'status': response.status,
                    'declaredContentLength': int(length) if length is not None and length.isdigit() else length,
                    'ETag': response.getheader('ETag'),
                    'LastModified': response.getheader('Last-Modified'),
                    'maximumRetainedBytes': limit,
                    'EOF': False,
                })
            if length is not None:
                require(length.isdigit() and int(length) <= limit, 'Official response exceeds byte cap')
            observed = 0
            value = bytearray()
            hasher = hashlib.sha256()
            output = Path(destination).open('xb') if destination else None
            try:
                while True:
                    require(time.monotonic() < deadline, 'Official request deadline')
                    tls.settimeout(max(0.001, deadline - time.monotonic()))
                    block = response.read(min(65536, limit + 1 - observed))
                    observed += len(block)
                    if not block:
                        break
                    require(observed <= limit, 'Official response exceeds byte cap')
                    hasher.update(block)
                    if output:
                        output.write(block)
                    else:
                        value.extend(block)
                require(not deadline_closed.is_set() and time.monotonic() < deadline, 'Official request deadline')
                if length is not None:
                    require(observed == int(length), 'Incomplete official response')
            finally:
                if output:
                    output.close()
            return bytes(value), {'hops': hops, 'bytes': observed, 'sha256': hasher.hexdigest(), 'EOF': True, 'maximumRetainedBytes': limit, 'maximumConsumedBytes': limit + 1, 'overflowProbeBytes': 1, 'elapsedSeconds': time.monotonic() - (deadline - seconds), 'networkDeadlineCloseRequested': deadline_closed.is_set(), 'attempts': 1}
        finally:
            if timer:
                timer.cancel()
                timer.join(timeout=1)
            if response:
                response.close()
            if tls:
                tls.close()
            raw.close()
    raise RuntimeError('Official redirect limit')


def bundle_inventory(app):
    rows, total = [], 0
    for folder, directories, files in os.walk(app, followlinks=False):
        for name in sorted(directories + files):
            file = Path(folder) / name
            info = file.lstat()
            relative = file.relative_to(app).as_posix()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(file)
                resolved = file.resolve()
                require(resolved == app or app in resolved.parents, 'Vendor app has an external link')
                rows.append({'path': relative, 'kind': 'symlink', 'target': target, 'sha256': hashlib.sha256(os.fsencode(target)).hexdigest(), 'mode': stat.S_IMODE(info.st_mode)})
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                require(total <= 3 * 1024 ** 3, 'Vendor app byte cap')
                rows.append({'path': relative, 'kind': 'file', 'bytes': info.st_size, 'sha256': digest(file), 'mode': stat.S_IMODE(info.st_mode)})
            else:
                require(stat.S_ISDIR(info.st_mode), 'Unsupported vendor app entry')
            require(len(rows) <= 50000, 'Vendor app entry cap')
    return sorted(rows, key=lambda row: row['path'])


def main():
    root = Path(__file__).resolve().parents[2]
    source, _ = source_guard(root)  # Before output, mount, download or product import.
    require(sys.platform == 'darwin' and os.uname().machine == 'arm64', 'A real native ARM macOS host is required')
    custom = os.environ.get('ALLOW_CUSTOM_PATH_DIAGNOSTIC', 'false')
    require(custom in ('true', 'false'), 'Invalid custom diagnostic admission')
    node = Path(os.environ['DIAGNOSTIC_NODE']).resolve()
    require(node.is_file() and node.name == 'node', 'Expected explicit native Node')
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve()
    require(runner_temp.is_dir(), 'Missing owned runner temporary root')
    output = root / 'test-results/arm-bundled-codex'
    output.mkdir(parents=True, exist_ok=False)
    private = Path(tempfile.mkdtemp(prefix='reviewops-arm-cli-', dir=runner_temp)).resolve()
    home, code, cwd = private / 'home', private / 'codex', private / 'cwd'
    for directory in [home, code, cwd, home / 'Applications']:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    (code / 'config.toml').write_text('cli_auth_credentials_store = "file"\n')
    (code / 'config.toml').chmod(0o600)
    env = {'HOME': str(home), 'CODEX_HOME': str(code), 'TMPDIR': str(private), 'PATH': str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC'}
    require(set(env) == {'HOME', 'CODEX_HOME', 'TMPDIR', 'PATH', 'LANG', 'TZ'}, 'Unexpected supplied metadata environment names')
    tools, held, mounted = [], [], None
    mount_attempted = mount_detached = detach_attempted = False
    result = {'ok': False, 'source': source, 'productionSource': BASE, 'startedAt': stamp(), 'DMGDownloadAttempts': 0, 'versionLaunchMaximum': 1, 'actualDesktopAppStarts': 0, 'authModelLoginAppServerStarts': 0}

    def tool(label, command):
        require(re.fullmatch('[a-z0-9-]+', label), 'Unsafe metadata label')
        started, deadline = stamp(), time.monotonic() + 60
        stdout_file, stderr_file = output / (label + '.stdout'), output / (label + '.stderr')
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        selector = selectors.DefaultSelector()
        observed = {'stdout': 0, 'stderr': 0}
        eof = {'stdout': False, 'stderr': False}
        with stdout_file.open('xb') as stdout, stderr_file.open('xb') as stderr:
            sinks = {'stdout': stdout, 'stderr': stderr}
            for name, pipe in [('stdout', child.stdout), ('stderr', child.stderr)]:
                selector.register(pipe, selectors.EVENT_READ, name)
            try:
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, 'Original metadata deadline')
                    ready = selector.select(remaining)
                    require(ready, 'Original metadata deadline')
                    for key, _ in ready:
                        name = key.data
                        block = os.read(key.fd, min(65536, 4 * 1024 ** 2 + 1 - observed[name]))
                        observed[name] += len(block)
                        require(observed[name] <= 4 * 1024 ** 2, 'Metadata output cap exceeded')
                        if not block:
                            eof[name] = True
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        else:
                            sinks[name].write(block)
                exit_code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except Exception:
                # Keep this exact owner and its still-open pipes. No kill, new PID
                # lookup, replacement client, or unbounded output drain follows.
                held.append(child)
                receipt = {'label': label, 'argv': command, 'pid': child.pid, 'startedAt': started, 'exit': child.poll(), 'held': True, 'EOF': eof, 'observedBytes': observed, 'maximumReadPerStream': 4 * 1024 ** 2 + 1, 'signalsRequested': 0}
                tools.append(receipt)
                write(output / (label + '-held.json'), receipt)
                raise RuntimeError('Original metadata owner/streams are unconfirmed; no kill or retry')
            finally:
                selector.close()
        receipt = {'label': label, 'argv': command, 'pid': child.pid, 'startedAt': started, 'completedAt': stamp(), 'wait': exit_code, 'poll': child.poll(), 'stdoutEOF': eof['stdout'], 'stderrEOF': eof['stderr'], 'originalStdoutClosed': child.stdout.closed, 'originalStderrClosed': child.stderr.closed, 'stdoutFileClosed': stdout.closed, 'stderrFileClosed': stderr.closed, 'observedBytes': observed, 'signalsRequested': 0}
        tools.append(receipt)
        write(output / (label + '-receipt.json'), receipt)
        require(exit_code == 0 and child.poll() == 0, 'Original metadata command failed: ' + label)
        return stdout_file.read_bytes(), stderr_file.read_bytes()

    try:
        host, _ = tool('native-node-preflight', [str(node), '-e', 'if(process.platform!=="darwin"||process.arch!=="arm64"||process.versions.node!=="24.22.2"||process.versions.electron)throw new Error("Native pinned Node required");console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node,executable:process.execPath,home:require("node:os").homedir(),environmentNames:Object.keys(process.env).sort().slice(0,32).map(key=>key.slice(0,128)),environmentNamesTruncated:Object.keys(process.env).length>32||Object.keys(process.env).some(key=>key.length>128),environmentValuesRecorded:false}));'])
        host = json.loads(host)
        require(Path(host['executable']).resolve() == node and host['home'] == str(home), 'Unexpected native Node identity')
        write(output / 'native-node.json', {**host, 'sha256': digest(node)})
        require(host['environmentNamesTruncated'] is False and host['environmentValuesRecorded'] is False and set(host['environmentNames']) <= set(env) | {'__CF_USER_TEXT_ENCODING'}, 'Unexpected native Node environment names; values are not recorded')
        page, page_receipt = bounded_get('https://learn.chatgpt.com/docs/app', {'learn.chatgpt.com', 'developers.openai.com'}, 4 * 1024 ** 2, 30)
        links = set()
        for href, content in re.findall(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page.decode('utf-8'), re.S | re.I):
            label = ' '.join(re.sub('<[^>]+>', ' ', content).split())
            if label == 'Download for macOS (Apple Silicon)':
                links.add(href)
        require(len(links) == 1, 'Unknown official ARM download link')
        url = links.pop()
        parsed = urlsplit(url)
        require(parsed.hostname == 'persistent.oaistatic.com' and parsed.path.startswith('/codex-app-prod/') and parsed.path.endswith('.dmg') and not parsed.query, 'Unapproved official DMG location')
        write(output / 'official-page.json', {**page_receipt, 'AppleSiliconDownload': url})
        dmg = private / 'official.dmg'
        result['DMGDownloadAttempts'] = 1
        write(output / 'official-DMG-request.json', {'url': url, 'maximumBytes': 1024 ** 3, 'seconds': 180, 'attempt': 1})
        try:
            _, download = bounded_get(url, {'persistent.oaistatic.com'}, 1024 ** 3, 180, dmg, output / 'official-DMG-response.json')
        except Exception:
            write(output / 'official-DMG-failure.json', {'EOF': False, 'attempts': 1, 'partialBytes': dmg.stat().st_size if dmg.exists() else 0, 'partialSHA256': digest(dmg) if dmg.exists() else None})
            raise
        write(output / 'official-DMG.json', download)
        mount = private / 'mount'
        mount.mkdir(mode=0o700)
        mount_attempted = True
        attach, _ = tool('mount-readonly', ['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', str(mount), str(dmg)])
        mounted = owned_mount_device(plistlib.loads(attach), str(mount))
        write(output / 'owned-mount-identity.json', {'device': mounted, 'mountPoint': str(mount), 'originalAttachIdentityConfirmed': True})
        info, _ = tool('mount-readonly-info', ['/usr/sbin/diskutil', 'info', '-plist', str(mount)])
        info = plistlib.loads(info)
        validate_readonly_mount(info, str(mount), mounted)
        apps = [file for file in mount.iterdir() if file.name.endswith('.app')]
        require(len(apps) == 1 and apps[0].name in ('Codex.app', 'ChatGPT.app') and apps[0].is_dir() and not apps[0].is_symlink(), 'Unknown original app layout')
        app = home / 'Applications' / apps[0].name
        tool('copy-original-app', ['/usr/bin/ditto', '--rsrc', '--extattr', str(apps[0]), str(app)])
        source_inventory = bundle_inventory(apps[0])
        before = bundle_inventory(app)
        require(source_inventory == before, 'Resource-preserving app copy differs')
        write(output / 'vendor-bundle-before.json', before)
        detach_attempted = True
        tool('detach-owned-mount', ['/usr/bin/hdiutil', 'detach', mounted])
        mounted = None
        mount_detached = True
        plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        require(plist.get('CFBundleIdentifier') == 'com.openai.codex', 'Unknown actual vendor bundle identifier')
        minimum = plist.get('LSMinimumSystemVersion')
        require(isinstance(minimum, str) and re.fullmatch('[0-9]+(?:\.[0-9]+){0,2}', minimum), 'Missing actual minimum macOS')
        os_version, _ = tool('host-os-version', ['/usr/bin/sw_vers', '-productVersion'])
        version_tuple = lambda value: tuple((list(map(int, value.split('.'))) + [0, 0])[:3])
        require(version_tuple(os_version.decode().strip()) >= version_tuple(minimum), 'Vendor app requires a newer macOS')
        cli = (app / 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex').resolve(strict=True)
        require(app in cli.parents and cli.is_file() and os.access(cli, os.X_OK), 'Unknown nested CLI layout')
        architecture, _ = tool('CLI-architecture'.lower(), ['/usr/bin/lipo', '-archs', str(cli)])
        require('arm64' in architecture.decode().split(), 'Actual CLI lacks arm64')
        signatures = []
        for label, file in [('app', app), ('cli', cli)]:
            tool(label + '-strict-signature', ['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R', '=anchor apple generic', str(file)])
            _, metadata = tool(label + '-signature-metadata', ['/usr/bin/codesign', '-d', '--verbose=4', str(file)])
            text = metadata.decode('utf-8')
            team = re.search(r'^TeamIdentifier=([A-Z0-9]{10})$', text, re.M)
            require(team and re.search(r'^Authority=Developer ID Application: OpenAI(?:,|\s)', text, re.M) and 'Signature=adhoc' not in text, 'Unknown vendor signing authority')
            signatures.append({'kind': label, 'teamIdentifier': team.group(1)})
        require(signatures[0]['teamIdentifier'] == signatures[1]['teamIdentifier'], 'App and CLI signing teams differ')
        identity = {'originalName': app.name, 'identifier': plist['CFBundleIdentifier'], 'shortVersion': plist.get('CFBundleShortVersionString'), 'bundleVersion': plist.get('CFBundleVersion'), 'minimumOS': minimum, 'hostOS': os_version.decode().strip(), 'architectures': architecture.decode().split(), 'signatures': signatures, 'CLI': str(cli), 'CLIBytes': cli.stat().st_size, 'CLISHA256': digest(cli), 'currentMutableVendorCohort': True, 'reportedVersionStringMatches': '26.1027.30824' in (plist.get('CFBundleShortVersionString'), plist.get('CFBundleVersion')), 'exactReporterCohortConfirmed': False}
        write(output / 'vendor-identity.json', identity)
        binding = private / 'probe-binding.json'
        write(binding, {'root': str(root), 'home': str(home), 'codeHome': str(code), 'CLI': str(cli), 'CLISHA256': digest(cli), 'output': str(output), 'allowCustomPathDiagnostic': custom == 'true', 'maximumVersionLaunches': 1, 'source': source})
        tool('real-runtime-probe', [str(node), str(root / 'scripts/diagnostics/arm-bundled-codex-probe.mjs'), str(binding)])
        probe = json.loads((output / 'runtime-result.json').read_text())
        require(probe['ok'] and probe['versionLaunches'] == 1, 'Actual runtime probe failed')
        after = bundle_inventory(app)
        write(output / 'vendor-bundle-after.json', after)
        require(after == before and not (code / 'auth.json').exists(), 'Vendor bytes changed or unexpected private auth file')
        source_guard(root)
        result.update({'ok': True, 'lane': probe['lane'], 'defaultDiscoveryProven': probe['defaultDiscoveryProven'], 'version': probe['version'], 'versionLaunches': 1, 'vendorBytesUnchanged': True})
    except Exception as error:
        result['error'] = str(error)
    finally:
        if mounted and not held and not detach_attempted:
            try:
                detach_attempted = True
                tool('final-detach-owned-mount', ['/usr/bin/hdiutil', 'detach', mounted])
                mounted = None
                mount_detached = True
            except Exception:
                result['mountClosureUnconfirmed'] = True
        result.update({'completedAt': stamp(), 'metadataTools': tools, 'heldMetadataOwners': [child.pid for child in held if child.poll() is None], 'mountClosureUnconfirmed': mount_attempted and not mount_detached, 'harnessSignalsRequested': 0, 'retries': 0})
        write(output / 'diagnostic-result.json', result)
        print(json.dumps({'ok': result['ok'], 'lane': result.get('lane'), 'defaultDiscoveryProven': result.get('defaultDiscoveryProven', False)}))
        # An unconfirmed original owner is deliberately held, never killed/adopted.
        while any(child.poll() is None for child in held):
            time.sleep(0.2)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
