#!/usr/bin/env python3
"""One conditionally authorized same-runner materialization and capability observation."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.dont_write_bytecode = True
BASE = '34bf2ed064a93c709a2f6d00caa70ca444abca55'
PRODUCT = '2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a'
SCOPE = 'issue34-private-qemu-capability-orchestration'
RECIPE = 'r3-capability-v1'
REPOSITORY = 'season-framework/reviewops-local'
REF = 'refs/heads/codex/issue34-installed-linux-combined-qa'
WORKFLOW = '.github/workflows/private-qemu-capability.yml'
WORKFLOW_REF = REPOSITORY + '/' + WORKFLOW + '@' + REF
ARTIFACT = 13310680337
ORIGIN_RUN = 41806165323
API = 'https://api.github.com/repos/' + REPOSITORY + '/actions/artifacts/' + str(ARTIFACT) + '/zip'
BLOB_HOST = 'productionresultssa13.blob.core.windows.net'
ZIP_BYTES = 1024957312
ZIP_SHA = '5f260806475c71e0eddd5909bd640f023bb3a22baa801506087bc979f9e7c4d5'
WHOLE_BYTES = 3336
WHOLE_SHA = '22d6acbec72a1da9e253a9bd5f52f1dc1b40beab52fbf515335a2f44b5613d95'
REPORT_BYTES = 156378
REPORT_SHA = 'f445374990057f8c27c66716582c658014f44048c801e51b7eb6029ec0f37365'
REPORT_MEMBER = 'installed-linux-supply/prepared-supply.json'
PATHS = frozenset({WORKFLOW, 'scripts/diagnostics/private-qemu-capability.py',
    'scripts/diagnostics/private-qemu-runtime.py', 'scripts/diagnostics/private_qemu_runtime_guards.py',
    'tests/private_qemu_runtime_test.py', 'docs/diagnostics/private-qemu-runtime.md',
    'scripts/diagnostics/installed-linux-permission-combined.py',
    'scripts/diagnostics/installed-linux-permission-vm.mjs', 'scripts/diagnostics/installed-linux-vm-guards.mjs',
    'tests/installed-linux-vm-guards.test.mjs', 'docs/diagnostics/installed-linux-permission-vm.md'})
PARENT_KEYS = frozenset({'schema', 'approved', 'scope', 'recipe', 'controlID',
    'expectedRepository', 'expectedActorID', 'expectedRef', 'expectedHarnessSource',
    'expectedWorkflowSource', 'expectedWorkflowRef', 'expectedJob', 'expectedRunNumber',
    'sourceBaseline', 'sourcePins', 'wholeSupplySHA256', 'maximumAdapterCalls',
    'allowAdapterInvocation', 'allowVM', 'allowSSH', 'allowApp', 'allowAPIWrites'})


def need(value, reason):
    if not value:
        raise ValueError(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def admit(parent, env, system, machine):
    """No filesystem, credentials, transport or child creation in this guard."""
    need(set(parent) == PARENT_KEYS and parent.get('schema') == 1
         and parent.get('approved') is True and parent.get('scope') == SCOPE
         and parent.get('recipe') == RECIPE and re.fullmatch('[a-f0-9]{32}', parent.get('controlID') or ''),
         'conditional-parent-authority')
    need(parent.get('maximumAdapterCalls') == 1 and parent.get('allowAdapterInvocation') is True
         and all(parent.get(k) is False for k in ('allowVM', 'allowSSH', 'allowApp', 'allowAPIWrites')),
         'phase-effects')
    head = parent.get('expectedHarnessSource')
    need(isinstance(head, str) and re.fullmatch('[a-f0-9]{40}', head)
         and parent.get('expectedWorkflowSource') == head and parent.get('sourceBaseline') == BASE
         and parent.get('wholeSupplySHA256') == WHOLE_SHA, 'reviewed-source')
    need(system == 'darwin' and machine == 'arm64', 'arm-macos-only')
    fixed = {'expectedRepository': REPOSITORY, 'expectedActorID': '351100875',
             'expectedRef': REF, 'expectedWorkflowRef': WORKFLOW_REF, 'expectedJob': 'capability'}
    need(all(parent.get(k) == v for k, v in fixed.items()), 'reviewed-job')
    number = parent.get('expectedRunNumber')
    need(type(number) is int and number > 0, 'unbound-run-number')
    expected = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_ACTOR_ID': '351100875',
                'GITHUB_REF': REF, 'GITHUB_SHA': head, 'GITHUB_WORKFLOW_SHA': head,
                'GITHUB_WORKFLOW_REF': WORKFLOW_REF, 'GITHUB_JOB': 'capability',
                'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_RUN_NUMBER': str(number)}
    # Numeric actor ID is authoritative. The triggering login is recorded, not guessed.
    need(all(env.get(k) == v for k, v in expected.items())
         and re.fullmatch('[1-9][0-9]*', env.get('GITHUB_RUN_ID') or ''), 'ci-identity')
    pins = parent.get('sourcePins')
    need(isinstance(pins, dict) and set(pins) == PATHS and all(
         isinstance(p, dict) and set(p) == {'bytes', 'sha256'}
         and type(p['bytes']) is int and 0 < p['bytes'] <= 1024**2
         and re.fullmatch('[a-f0-9]{64}', p['sha256'] or '') for p in pins.values()), 'eleven-source-pins')
    return {k: env[k] for k in expected} | {'GITHUB_RUN_ID': env['GITHUB_RUN_ID'],
             'GITHUB_TRIGGERING_ACTOR': env.get('GITHUB_TRIGGERING_ACTOR')}


def blob_location(value):
    need(isinstance(value, str) and 0 < len(value) <= 16384
         and not re.search(r'[\x00-\x20\x7f\\]', value), 'redirect-location')
    parts = urllib.parse.urlsplit(value)
    need(parts.scheme == 'https' and parts.hostname == BLOB_HOST and parts.port in (None, 443)
         and parts.username is None and parts.password is None and not parts.fragment
         and parts.netloc in (BLOB_HOST, BLOB_HOST + ':443') and parts.path.startswith('/'),
         'redirect-host')
    return value


def headers(role, token=None):
    common = {'User-Agent': 'reviewops-private-qemu-capability', 'Accept-Encoding': 'identity'}
    if role == 'api':
        need(isinstance(token, str) and 0 < len(token) <= 8192
             and not re.search(r'[\x00-\x20\x7f]', token), 'dedicated-actions-read-token')
        return {**common, 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2026-03-10'}
    need(role == 'blob' and token is None, 'blob-auth-forbidden')
    return common


def copy_exact(response, sink, expected_bytes, expected_sha, deadline, progress=None):
    """One response, bounded reads, actual EOF, no retry or hidden decompression."""
    h, count, written = hashlib.sha256(), 0, 0
    progress = {} if progress is None else progress
    progress['bodyEOF'] = False
    try:
        while True:
            need(time.monotonic() <= deadline, 'transfer-deadline')
            block = response.read(min(1024**2, expected_bytes + 1 - count))
            if not block:
                progress['bodyEOF'] = True
                break
            count += len(block)
            need(count <= expected_bytes, 'transfer-byte-cap')
            need(sink.write(block) == len(block), 'transfer-short-write')
            written += len(block)
            h.update(block)
        need(count == expected_bytes and h.hexdigest() == expected_sha, 'transfer-exact-seal')
        return progress
    finally:
        progress.update({'observedBytes': count, 'writtenBytes': written, 'sha256': h.hexdigest()})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, response_headers, newurl):
        return None


def read_regular(path, cap):
    path = Path(path)
    before = path.lstat()
    need(path.is_absolute() and stat.S_ISREG(before.st_mode) and 0 < before.st_size <= cap,
         'bounded-regular-input')
    with path.open('rb') as stream:
        raw = stream.read(cap + 1)
    after = path.lstat()
    need(len(raw) == before.st_size and len(raw) <= cap
         and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'input-changed')
    return raw


def file_pin(path):
    path = Path(path)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 512 * 1024**2, 'regular-tool-or-record')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            h.update(block)
    after = path.lstat()
    need((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'pinned-file-changed')
    return {'path': str(path), 'bytes': info.st_size, 'sha256': h.hexdigest()}


def write(path, value):
    with path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, ensure_ascii=True, indent=2) + '\n')


def load_adapter(source):
    spec = importlib.util.spec_from_file_location('private_qemu_runtime_entry',
        source / 'scripts/diagnostics/private-qemu-runtime.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def source_guard(source, parent, tools, git, label):
    def run(suffix, *argv):
        return tools.run(label + suffix, [str(git), '-c', 'core.hooksPath=/dev/null',
            '-c', 'core.fsmonitor=false', '-C', str(source), *argv])
    need(run('-head', 'rev-parse', 'HEAD').decode().strip() == parent['expectedHarnessSource']
         and not run('-clean', 'status', '--porcelain=v1', '--untracked-files=all'), 'clean-harness')
    def table(raw):
        return {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].decode()
                for row in raw.split(b'\0') if row}
    old = table(run('-base', 'ls-tree', '-rz', BASE))
    current = table(run('-tree', 'ls-tree', '-rz', 'HEAD'))
    need(len(old) == 438 and all(current.get(n) == v for n, v in old.items())
         and set(current) - set(old) == PATHS, 'old438-plus-exact-eleven')
    for name, entry in current.items():
        mode, kind, oid = entry.split(' ')
        path = source / name
        need(kind == 'blob' and mode in ('100644', '100755')
             and path.resolve(strict=True) == path and stat.S_ISREG(path.lstat().st_mode), 'source-file-type')
        raw = read_regular(path, 32 * 1024**2)
        need(hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == oid
             and bool(path.stat().st_mode & 0o111) == (mode == '100755'), 'live-git-bytes-modes')


def acquire(destination, output, token):
    """Exactly API 302 then the observed unauthenticated blob 200; no URL persistence."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    receipt = {'startedAt': stamp(), 'artifactID': ARTIFACT, 'originRunID': ORIGIN_RUN,
               'attempts': {'api': 0, 'blob': 0}, 'automaticRetries': 0, 'signedURLRetained': False,
               'proxyHandlerEmpty': True, 'cookieHandler': False, 'apiResponseClosed': False,
               'blobResponseClosed': False, 'outputClosed': False, 'ok': False}
    api_response = blob_response = sink = None
    try:
        receipt['attempts']['api'] = 1
        try:
            api_response = opener.open(urllib.request.Request(API, headers=headers('api', token)), timeout=45)
        except urllib.error.HTTPError as error:
            api_response = error
        need(api_response.status == 302, 'api-must-return-302')
        receipt['apiStatus'] = 302
        location = blob_location(api_response.headers.get('Location'))
        body = api_response.read(65537)
        need(len(body) <= 65536 and api_response.read(1) == b'', 'api-body-cap-or-eof')
        receipt['apiBodyBytes'], receipt['apiBodyEOF'] = len(body), True
        api_response.close()
        receipt['apiResponseClosed'] = api_response.closed
        need(receipt['apiResponseClosed'], 'api-response-not-closed')
        token = None
        receipt['attempts']['blob'] = 1
        try:
            blob_response = opener.open(urllib.request.Request(location, headers=headers('blob')), timeout=45)
        except urllib.error.HTTPError as error:
            blob_response = error
        location = None
        need(blob_response.status == 200 and blob_response.headers.get('Content-Encoding', 'identity') == 'identity',
             'blob-must-return-unencoded-200')
        length = blob_response.headers.get('Content-Length')
        need(length is not None and length.isdigit() and int(length) == ZIP_BYTES, 'blob-content-length')
        receipt.update({'blobHost': BLOB_HOST, 'blobStatus': 200, 'blobAuthorization': False})
        sink = destination.open('xb')
        receipt['body'] = {}
        copy_exact(blob_response, sink, ZIP_BYTES, ZIP_SHA, time.monotonic() + 1800, receipt['body'])
        sink.flush()
        receipt['bodySealed'] = True
    except Exception as error:
        receipt['failureType'] = type(error).__name__
        # Exception text may contain a signed URL. Never retain it.
        raise ValueError('artifact-acquisition-failed') from None
    finally:
        if api_response is not None:
            api_response.close()
            receipt['apiResponseClosed'] = api_response.closed
        if blob_response is not None:
            blob_response.close()
            receipt['blobResponseClosed'] = blob_response.closed
        if sink is not None:
            sink.close()
            receipt['outputClosed'] = sink.closed
        receipt['ok'] = (receipt.get('bodySealed') is True and 'failureType' not in receipt
                         and receipt['apiResponseClosed'] and receipt['blobResponseClosed']
                         and receipt['outputClosed'])
        receipt['completedAt'] = stamp()
        write(output / 'artifact-transfer.receipt.json', receipt)
    need(receipt['apiResponseClosed'] and receipt['blobResponseClosed'] and receipt['outputClosed'], 'transport-closure')


def blueprint(report):
    bottles = report.get('qemu', {}).get('bottles')
    need(report.get('ok') is True and report.get('status') == 'prepared-supply-only'
         and report.get('source') == PRODUCT and isinstance(bottles, list) and len(bottles) == 30, 'r3-report-schema')
    rows = []
    for i, row in enumerate(bottles):
        item = {'name': row['name'], 'pkgVersion': row['pkgVersion']}
        for kind, suffix in [('archive', '.tar.gz'), ('inventory', '.inventory.json')]:
            p = row[kind + 'Pin']
            member = 'installed-linux-supply/bottle-' + str(i) + suffix
            need(isinstance(p, dict) and str(p.get('path', '')).endswith('/' + member)
                 and type(p.get('bytes')) is int and p['bytes'] > 0
                 and re.fullmatch('[a-f0-9]{64}', p.get('sha256') or ''), 'r3-bottle-producer-pin')
            item.update({kind + 'Member': member, kind + 'Bytes': p['bytes'], kind + 'SHA256': p['sha256']})
        rows.append(item)
    need(len({r['name'] for r in rows}) == 30 and rows[0]['name'] == 'qemu', 'r3-ordered-thirty')
    return {'schema': 1, 'artifactSHA256': ZIP_SHA, 'bottles': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent', type=Path, required=True)
    parser.add_argument('--whole-proof', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result, output, stage = {'schema': 1, 'ok': False, 'acceptedRuntime': False,
        'VMStarted': False, 'SSHStarted': False, 'applicationLaunched': False,
        'adapterCalls': 0, 'startedAt': stamp()}, None, 'parent-admission'
    try:
        parent_raw = read_regular(args.parent, 65536)
        parent = json.loads(parent_raw)
        identity = admit(parent, os.environ, sys.platform, platform.machine())
        whole_raw = read_regular(args.whole_proof, WHOLE_BYTES)
        need(len(whole_raw) == WHOLE_BYTES and digest(whole_raw) == WHOLE_SHA, 'original-whole-proof-bytes')
        whole = json.loads(whole_raw)
        need(whole.get('accepted') is True and whole.get('wholeSupplyAccepted') is True
             and whole.get('productSource') == PRODUCT and whole.get('runID') == ORIGIN_RUN
             and whole.get('artifactID') == ARTIFACT and whole.get('preparedSupplyMember') == REPORT_MEMBER
             and whole.get('supplyZIPPin', {}).get('sha256') == ZIP_SHA
             and whole.get('supplyZIPPin', {}).get('bytes') == ZIP_BYTES
             and whole.get('preparedSupplyPin', {}).get('sha256') == REPORT_SHA
             and whole.get('preparedSupplyPin', {}).get('bytes') == REPORT_BYTES, 'r3-whole-proof')
        source = Path(__file__).resolve().parents[2]
        for name, expected in parent['sourcePins'].items():
            raw = read_regular(source / name, 1024**2)
            need(len(raw) == expected['bytes'] and digest(raw) == expected['sha256'], 'reviewed-source-file')
        need(os.environ.get('GITHUB_WORKSPACE') == str(source), 'checkout-root')
        proposed_output = args.output.absolute()
        results = source / 'test-results'
        need(results.is_dir() and not results.is_symlink() and proposed_output.parent == results
             and proposed_output.name == 'private-qemu-capability-orchestrator'
             and not os.path.lexists(proposed_output), 'fresh-output')
        proposed_output.mkdir(mode=0o700)
        output = proposed_output
        with (output / 'once.claim').open('x', encoding='ascii') as stream:
            stream.write(parent['controlID'] + '\n')
        stage = 'same-runner-observation'
        observed = {'schema': 1, 'identity': identity, 'parentControlPin': file_pin(args.parent),
                    'wholeSupplyOriginalPin': file_pin(args.whole_proof),
                    'recipeSourcePin': file_pin(Path(__file__).resolve()),
                    'codesignPin': file_pin(Path('/usr/bin/codesign')),
                    'gitPin': file_pin(Path('/usr/bin/git')), 'pythonPin': file_pin(Path(sys.executable).resolve()),
                    'system': sys.platform, 'machine': platform.machine(), 'observedAt': stamp()}
        write(output / 'same-runner-observation.json', observed)
        adapter = load_adapter(source)
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
        tools = adapter.OriginalTools(output, env, source)
        stage = 'source-preflight'
        source_guard(source, parent, tools, Path('/usr/bin/git'), 'before')
        stage = 'artifact-acquisition'
        temporary = Path(os.environ.get('RUNNER_TEMP', ''))
        need(temporary.is_absolute() and temporary.is_dir() and not temporary.is_symlink(), 'runner-temporary-root')
        private = temporary / ('r34cap-' + parent['controlID'])
        private.mkdir(mode=0o700)
        token = os.environ.pop('REVIEWOPS_ARTIFACT_TOKEN', None)
        artifact = private / 'R3-artifact.zip'
        acquire(artifact, output, token)
        token = None
        stage = 'verbatim-report-materialization'
        with zipfile.ZipFile(artifact) as archive:
            matches = [i for i in archive.infolist() if i.filename == REPORT_MEMBER]
            need(len(matches) == 1 and not matches[0].is_dir() and matches[0].file_size == REPORT_BYTES,
                 'sole-bounded-report-member')
            with archive.open(matches[0]) as stream:
                report_raw = stream.read(REPORT_BYTES + 1)
                need(stream.read(1) == b'', 'report-member-eof')
            need(len(report_raw) == REPORT_BYTES and digest(report_raw) == REPORT_SHA, 'verbatim-report-seal')
        report_path, proof_path = output / 'prepared-supply.original.json', output / 'whole-supply.original.json'
        for path, raw in [(report_path, report_raw), (proof_path, whole_raw)]:
            with path.open('xb') as stream:
                stream.write(raw)
        write(output / 'blueprint30.json', blueprint(json.loads(report_raw)))
        staged_artifact_pin = {'path': str(artifact), 'bytes': ZIP_BYTES, 'sha256': ZIP_SHA}
        materialized = {'schema': 1, 'wholeProofOriginPin': file_pin(args.whole_proof),
            'wholeProofStagedPin': file_pin(proof_path), 'preparedReportOriginPin': whole['preparedSupplyPin'],
            'preparedReportStagedPin': file_pin(report_path), 'artifactOriginPin': whole['supplyZIPPin'],
            'artifactStagedPin': staged_artifact_pin, 'preparedReportPreservedVerbatim': True,
            'artifactGETs': 1, 'originRunID': ORIGIN_RUN, 'originArtifactID': ARTIFACT}
        write(output / 'materialization.json', materialized)
        runtime_output = results / ('private-qemu-runtime-' + identity['GITHUB_RUN_ID'] + '-1')
        need(not os.path.lexists(runtime_output), 'fresh-adapter-output')
        binding = {'schema': 1, 'phase': adapter.PHASE, 'productSource': PRODUCT, 'sourceBaseline': BASE,
            'harnessSource': parent['expectedHarnessSource'], 'logicalPrefix': '/tmp/r34' + parent['controlID'][:4],
            'output': str(runtime_output), 'wholeSupplyAcceptancePin': file_pin(proof_path),
            'acceptedPreparedReportPin': file_pin(report_path), 'artifactZIPPin': staged_artifact_pin,
            'subsetBlueprintPin': file_pin(output / 'blueprint30.json'),
            'codesignPin': observed['codesignPin'], 'gitPin': observed['gitPin']}
        write(output / 'binding.derived.json', binding)
        approval = {'schema': 1, 'approved': True, 'scope': adapter.PHASE,
            'bindingSHA256': file_pin(output / 'binding.derived.json')['sha256'],
            'derivation': RECIPE, 'parentControlPin': observed['parentControlPin'],
            'sameRunnerObservationPin': file_pin(output / 'same-runner-observation.json'),
            'materializationPin': file_pin(output / 'materialization.json'),
            'recipeSourcePin': observed['recipeSourcePin'], 'maximumAdapterCalls': 1,
            'runIdentity': identity, 'standaloneRootRuntimeAcceptance': False}
        write(output / 'approval.derived.json', approval)
        # Recheck after transport/materialization, before the sole adapter invocation.
        source_guard(source, parent, tools, Path('/usr/bin/git'), 'pre-adapter')
        need(file_pin(Path('/usr/bin/codesign')) == observed['codesignPin']
             and file_pin(Path('/usr/bin/git')) == observed['gitPin'], 'same-runner-tool-drift')
        stage = 'one-adapter-original'
        result['adapterCalls'] = 1  # An attempted launch is never retried, including pre-handle failure.
        tools.run('adapter', [str(Path(sys.executable).resolve()), '-I', '-B',
            str(source / 'scripts/diagnostics/private-qemu-runtime.py'), '--binding',
            str(output / 'binding.derived.json'), '--approval', str(output / 'approval.derived.json')], seconds=1500)
        runtime = json.loads(read_regular(runtime_output / 'result.json', 4 * 1024**2))
        need(runtime.get('ok') is True and runtime.get('harnessSource') == parent['expectedHarnessSource']
             and runtime.get('status') == 'private-qemu-capability-observed', 'adapter-observation')
        source_guard(source, parent, tools, Path('/usr/bin/git'), 'after')
        result.update({'ok': True, 'status': 'capability-observation-awaits-Root-acceptance',
                       'runtimeResultPin': file_pin(runtime_output / 'result.json'),
                       'sameRunnerObservationPin': file_pin(output / 'same-runner-observation.json'),
                       'materializationPin': file_pin(output / 'materialization.json'),
                       'runIdentity': identity})
    except Exception as error:
        result.update({'failedStage': stage, 'failureType': type(error).__name__,
                       'failureReason': 'Controlled stage failed; inspect sanitized retained records.'})
    finally:
        result['completedAt'] = stamp()
        if output is not None and output.is_dir():
            write(output / 'result.json', result)
        print(json.dumps({'ok': result['ok'], 'acceptedRuntime': False,
                          'stage': result.get('failedStage', 'complete'), 'adapterCalls': result['adapterCalls']}))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
