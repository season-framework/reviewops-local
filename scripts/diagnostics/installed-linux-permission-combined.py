#!/usr/bin/env python3
"""Root-delegated same-runner capability, private app preparation and one VM owner."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import ssl
import zipfile

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('private_qemu_capability_recipe',
    Path(__file__).with_name('private-qemu-capability.py'))
c = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = c
_spec.loader.exec_module(c)
SCOPE = 'issue34-installed-linux-combined-qa'
CONTRACT = 'issue34-one-original-vm-conditional-ui-v1'
RECIPE = 'combined-same-runner-v1'
SETUP_NODE = '249970729cb0ef3589644e2896645e5dc5ba9c38'
NODE_VERSION = '24.22.2'
PUBLIC_SHA = 'c0260968484f65be27a15178b40cb4ff59c36b8e9babfe50395e34cf8a6d1241'
PUBLIC_BYTES = 6202
ASSET = 708388172
APP_BYTES = 133831763
APP_SHA = '2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead'
APP_HOST = 'release-assets.githubusercontent.com'
ASAR = {'path': 'Contents/Resources/app.asar', 'bytes': 34912856,
        'sha256': '4e54fe892916a60aebf90a507acf005dd368f4509beb13818960dd891c2665dd'}
EXECUTABLE = {'path': 'Contents/MacOS/ReviewOps', 'bytes': 53008,
              'sha256': '1caceb099acff47d9fd896aebc15f9b0615e88f385ae1fa0f47ca6471d88fe78'}
UI_SHA = '2fbf69b3535296aa3d89699641fc4284dec21fc98d55f1fe84df321e1d8f55b2'
BUILD = {'channel': 'test', 'version': '1.4.1', 'buildNumber': 41001, 'commit': c.PRODUCT,
         'builtAt': '2026-11-04T05:32:59.166Z', 'developmentNumber': 3}
EXTRA_KEYS = {'allowNodeDependencyAcquisition', 'nodeVersion', 'nodeArchitecture', 'nodeSetupActionSHA',
    'npmLockSHA256', 'npmRegistry', 'allowConditionalRuntimeAcceptance', 'allowPrivateAppPreparation',
    'allowOriginalVMAndGuest', 'allowConditionalUIApproval', 'maximumVMLaunches', 'maximumAppLaunches',
    'maximumPowerdownRequests', 'machineName', 'uiDriverSHA256', 'r41PublicProofSHA256'}
NPM_ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
CI_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'GITHUB_SHA']
CAP_CI_KEYS = ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY', 'GITHUB_ACTOR_ID',
    'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_JOB',
    'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ID', 'GITHUB_WORKSPACE', 'GITHUB_TRIGGERING_ACTOR']


def child_control(parent):
    c.need(parent.get('approved') is True and parent.get('scope') == SCOPE
        and parent.get('recipe') == RECIPE and parent.get('allowAdapterInvocation') is True,
        'combined-parent-not-approved')
    child = {key: parent[key] for key in c.PARENT_KEYS}
    child.update({'scope': c.SCOPE, 'recipe': c.RECIPE, 'allowVM': False, 'allowSSH': False, 'allowApp': False})
    return child


def admit(parent, env, system, machine):
    c.need(set(parent) == c.PARENT_KEYS | EXTRA_KEYS, 'combined-closed-parent')
    child = child_control(parent)
    identity = c.admit(child, env, system, machine)
    c.need(env.get('CI') == 'true', 'combined-ci')
    c.need(all(parent.get(k) is True for k in ['allowVM', 'allowSSH', 'allowApp',
        'allowNodeDependencyAcquisition', 'allowConditionalRuntimeAcceptance', 'allowPrivateAppPreparation',
        'allowOriginalVMAndGuest', 'allowConditionalUIApproval']) and
        all(type(parent.get(k)) is int and parent[k] == 1 for k in
            ['maximumVMLaunches', 'maximumAppLaunches', 'maximumPowerdownRequests']), 'combined-delegation')
    c.need(parent['nodeVersion'] == NODE_VERSION and parent['nodeArchitecture'] == 'arm64'
        and parent['nodeSetupActionSHA'] == SETUP_NODE and parent['npmRegistry'] == 'https://registry.npmjs.org'
        and re.fullmatch('[a-f0-9]{64}', parent.get('npmLockSHA256') or '')
        and parent['uiDriverSHA256'] == UI_SHA and parent['r41PublicProofSHA256'] == PUBLIC_SHA
        and re.fullmatch(r'pc-i440fx-\d+\.\d+', parent.get('machineName') or ''), 'combined-fixed-inputs')
    return child, identity


def minimal_env(home, temporary, ci=None):
    env = {'HOME': str(home), 'TMPDIR': str(temporary), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
        'LANG': 'en_US.UTF-8', 'TZ': 'UTC'}
    if ci is not None:
        c.need(all(isinstance(ci.get(k), str) and ci[k] for k in CI_KEYS), 'six-admitted-ci-fields')
        env.update({k: ci[k] for k in CI_KEYS})
    return env


def npm_environment(private, node):
    return {**minimal_env(private / 'home', private / 'tmp'),
        'PATH': str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin',
        'NPM_CONFIG_CACHE': str(private / 'npm-cache'), 'NPM_CONFIG_USERCONFIG': str(private / 'npm-userconfig'),
        'NPM_CONFIG_GLOBALCONFIG': str(private / 'npm-globalconfig'), 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org',
        'NPM_CONFIG_IGNORE_SCRIPTS': 'true', 'NPM_CONFIG_FETCH_RETRIES': '0',
        'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1', 'ELECTRON_SKIP_BINARY_DOWNLOAD': '1'}


def same_pin(actual, expected):
    return all(actual.get(k) == expected.get(k) for k in ('bytes', 'sha256'))


def sha_file(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''): h.update(block)
    return h.hexdigest()


def checked_pin(record, maximum):
    c.need(isinstance(record, dict) and isinstance(record.get('path'), str)
        and type(record.get('bytes')) is int and 0 < record['bytes'] <= maximum
        and re.fullmatch('[a-f0-9]{64}', record.get('sha256') or ''), 'bounded-regular-pin')
    file = Path(record['path']); before = file.lstat()
    c.need(file.is_absolute() and stat.S_ISREG(before.st_mode) and before.st_size == record['bytes'], 'pinned-regular-file')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd); c.need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'pin-open-identity')
        h, count = hashlib.sha256(), 0
        while True:
            block = os.read(fd, min(1024**2, maximum + 1 - count))
            if not block: break
            count += len(block); c.need(count <= maximum, 'pin-byte-cap'); h.update(block)
        after = os.fstat(fd); path_after = file.lstat()
        signature = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        c.need(signature(before) == signature(opened) == signature(after) == signature(path_after)
            and count == record['bytes'] and h.hexdigest() == record['sha256'], 'pin-bytes-identity')
    finally: os.close(fd)
    return file


def checked_json(record, maximum=8 * 1024**2):
    return json.loads(c.read_regular(checked_pin(record, maximum), maximum))


def evidence_bytes(record, maximum=4 * 1024**2):
    c.need(isinstance(record, dict) and type(record.get('bytes')) is int and 0 <= record['bytes'] <= maximum
        and re.fullmatch('[a-f0-9]{64}', record.get('sha256') or ''), 'bounded-output-evidence')
    file = Path(record['path']); st = file.lstat()
    c.need(file.is_absolute() and stat.S_ISREG(st.st_mode) and st.st_size == record['bytes'], 'regular-output-evidence')
    with file.open('rb') as stream: raw = stream.read(maximum + 1)
    c.need(len(raw) == record['bytes'] and c.digest(raw) == record['sha256'], 'output-evidence-seal')
    return raw


def private_identity(root):
    st = root.lstat()
    c.need(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700
        and root.resolve(strict=True) == root, 'owned-combined-private-root')
    return {'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid, 'mode': st.st_mode,
        'birthtime': getattr(st, 'st_birthtime', None)}


def source_context(args, creating=False):
    raw = c.read_regular(args.parent, 65536)
    parent = json.loads(raw)
    parent_pin = c.file_pin(args.parent)
    c.need(parent_pin['bytes'] == len(raw) and parent_pin['sha256'] == c.digest(raw), 'parent-read-pin-identity')
    child, identity = admit(parent, os.environ, sys.platform, os.uname().machine)
    source = Path(__file__).resolve().parents[2]
    c.need(os.environ.get('GITHUB_WORKSPACE') == str(source), 'reviewed-checkout-root')
    for name, expected in parent['sourcePins'].items():
        actual = c.read_regular(source / name, 1024**2)
        c.need(len(actual) == expected['bytes'] and c.digest(actual) == expected['sha256'], 'reviewed-eleven-source-pins')
    whole = c.read_regular(args.whole_proof, c.WHOLE_BYTES)
    public = c.read_regular(args.public_proof, PUBLIC_BYTES)
    c.need(len(whole) == c.WHOLE_BYTES and c.digest(whole) == c.WHOLE_SHA
        and len(public) == PUBLIC_BYTES and c.digest(public) == PUBLIC_SHA, 'original-root-proof-bytes')
    public_data = json.loads(public)
    c.need(public_data.get('accepted') is True and public_data.get('source') == c.PRODUCT
        and public_data.get('build', {}).get('buildNumber') == 41001 and public_data.get('run') == 41779906019,
        'accepted-r41-public-source')
    lock = c.read_regular(source / 'package-lock.json', 2 * 1024**2)
    c.need(c.digest(lock) == parent['npmLockSHA256'], 'reviewed-lockfile')
    c.need(not os.path.lexists(source / '.npmrc'), 'no-project-npm-config')
    for row in json.loads(lock).get('packages', {}).values():
        if 'resolved' in row:
            url = urllib.parse.urlsplit(row['resolved'])
            c.need(url.scheme == 'https' and url.hostname == 'registry.npmjs.org'
                and not url.username and not url.password and not url.fragment, 'fixed-npm-registry-only')
    output = source / 'test-results/installed-linux-combined'
    c.need(args.output.absolute() == output and not output.is_symlink(), 'combined-output')
    if creating:
        c.need(not os.path.lexists(output), 'fresh-combined-output')
        (source / 'test-results').mkdir(exist_ok=True)
        c.need(not (source / 'test-results').is_symlink() and (source / 'test-results').resolve() == source / 'test-results', 'owned-results-parent')
        output.mkdir(mode=0o700)
    else:
        c.need(output.is_dir(), 'preflight-required')
        prior = json.loads(c.read_regular(output / 'preflight.json', 65536))
        c.need(prior.get('ok') is True and prior.get('parentPin') == c.file_pin(args.parent)
            and prior.get('identity') == identity and prior.get('coordinatorPin') == c.file_pin(Path(__file__).resolve()),
            'same-original-preflight')
    private = Path('/private/tmp/r34v-' + parent['controlID'][:12])
    if not creating: c.need(private_identity(private) == prior['privateRootIdentity'], 'same-preflight-private-root')
    env = minimal_env(private / 'home', private / 'tmp')
    # Reviewed OriginalTools is definitions-only; no mutable Homebrew module is imported.
    tools = c.load_adapter(source).OriginalTools(output, {**env, 'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}, source)
    return {'parent': parent, 'child': child, 'identity': identity, 'source': source, 'output': output,
        'private': private, 'env': env, 'tools': tools, 'wholeRaw': whole, 'publicRaw': public,
        'parentPin': parent_pin, 'parentRaw': raw, 'args': args}


def preflight(ctx):
    p, out, private = ctx['parent'], ctx['output'], ctx['private']
    # Git has no user config and no credentials; no Node/dependency acquisition precedes this gate.
    c.source_guard(ctx['source'], p, ctx['tools'], Path('/usr/bin/git'), 'preflight')
    c.need(not os.path.lexists(private), 'fresh-combined-private-root')
    private.mkdir(mode=0o700)
    for relative in ['home', 'tmp', 'npm-cache', 'home/Applications', 'home/.codex', 'home/.ssh']:
        (private / relative).mkdir(mode=0o700)
    for relative, raw in [('home/.codex/config.toml', b'cli_auth_credentials_store = "file"\n'),
                          ('home/.ssh/config', b''), ('npm-userconfig', b''), ('npm-globalconfig', b'')]:
        with (private / relative).open('xb') as stream: stream.write(raw)
        (private / relative).chmod(0o600)
    for name, raw in [('parent.original.json', ctx['parentRaw']),
        ('whole-root.original.json', ctx['wholeRaw']), ('public-root.original.json', ctx['publicRaw'])]:
        with (out / name).open('xb') as stream: stream.write(raw)
    c.write(out / 'preflight.json', {'ok': True, 'identity': ctx['identity'], 'parentPin': ctx['parentPin'],
        'coordinatorPin': c.file_pin(Path(__file__).resolve()), 'privateRoot': str(private),
        'privateRootIdentity': private_identity(private),
        'preflightGitPin': c.file_pin(Path('/usr/bin/git')),
        'sourceProfile': 'old438-plus-exact11', 'NodeDependencyAcquisitionConditionallyAuthorized': True,
        'VMOrAppStarted': False})
    c.need(isinstance(os.environ.get('GITHUB_ENV'), str), 'github-env-handoff')
    values = {'HOME': str(private / 'home'), 'CODEX_HOME': str(private / 'home/.codex'),
        'NPM_CONFIG_CACHE': str(private / 'npm-cache'), 'NPM_CONFIG_USERCONFIG': str(private / 'npm-userconfig'),
        'NPM_CONFIG_GLOBALCONFIG': str(private / 'npm-globalconfig'), 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org',
        'NPM_CONFIG_IGNORE_SCRIPTS': 'true', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1', 'ELECTRON_SKIP_BINARY_DOWNLOAD': '1'}
    with Path(os.environ['GITHUB_ENV']).open('a', encoding='utf-8') as stream:
        for key, value in values.items(): stream.write(key + '=' + value + '\n')


def dependencies(ctx, node):
    c.need(node is not None, 'actual-setup-node-path')
    node = node.resolve(strict=True)
    probe = 'console.log(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform,executable:process.execPath}))'
    observed = json.loads(ctx['tools'].run('actual-node', [str(node), '-e', probe]))
    c.need(observed == {'version': NODE_VERSION, 'arch': 'arm64', 'platform': 'darwin', 'executable': str(node)}, 'actual-node24-arm')
    npm = node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    npm_pin = c.file_pin(npm)
    env = npm_environment(ctx['private'], node)
    c.source_guard(ctx['source'], ctx['parent'], ctx['tools'], Path('/usr/bin/git'), 'before-dependencies')
    for name in ['npm-userconfig', 'npm-globalconfig']:
        file = ctx['private'] / name; st = file.lstat()
        c.need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size == 0, 'private-empty-npm-config')
    tools = c.load_adapter(ctx['source']).OriginalTools(ctx['output'], env, ctx['source'])
    tools.run('locked-npm-ci', [str(node), str(npm), *NPM_ARGS], seconds=900)
    query = 'console.log(JSON.stringify(["@playwright/test","ssh2"].map(name=>({name,path:require.resolve(name)}))))'
    modules = json.loads(tools.run('actual-module-entries', [str(node), '-e', query]))
    c.need([v['name'] for v in modules] == ['@playwright/test', 'ssh2'], 'dependency-entry-roles')
    pins = []
    for row in modules:
        file = Path(row['path'])
        c.need(file.is_relative_to(ctx['source'] / 'node_modules'), 'private-locked-module')
        pins.append(c.file_pin(file))
    c.write(ctx['output'] / 'dependencies.json', {'nodePin': {**c.file_pin(node), 'version': NODE_VERSION,
        'platform': 'darwin', 'arch': 'arm64'}, 'npmPin': npm_pin, 'dependencyPins': pins,
        'lockSHA256': ctx['parent']['npmLockSHA256'], 'args': NPM_ARGS,
        'parentPin': ctx['parentPin'], 'identity': ctx['identity'],
        'nodeAcquisitionScope': 'Pinned setup-node action; actual binary/version/arch/hash observed. No per-HTTP action transport receipt is exposed.',
        'lifecycleScriptsRun': False, 'browserOrElectronDownloadRequested': False,
        'scope': 'Locked npm installation plus observed module entry pins; not independent reconstruction of every runtime-loaded dependency.'})


def app_redirect(value):
    c.need(isinstance(value, str) and 0 < len(value) <= 16384 and not re.search(r'[\x00-\x20\x7f\\]', value), 'app-redirect')
    u = urllib.parse.urlsplit(value)
    c.need(u.scheme == 'https' and u.netloc in (APP_HOST, APP_HOST + ':443') and u.port in (None, 443)
        and not u.username and not u.password and not u.fragment and u.path.startswith('/'), 'app-redirect-host')
    return value


def acquire_app(destination, out, token):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), c.NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    response = sink = None
    receipt = {'assetID': ASSET, 'attempts': {'api': 0, 'blob': 0}, 'automaticRetries': 0,
        'signedURLRetained': False, 'responsesClosed': [], 'outputClosed': False, 'ok': False}
    try:
        h = {**c.headers('api', token), 'Accept': 'application/octet-stream'}
        receipt['attempts']['api'] = 1
        try: response = opener.open(urllib.request.Request('https://api.github.com/repos/' + c.REPOSITORY + '/releases/assets/' + str(ASSET), headers=h), timeout=45)
        except urllib.error.HTTPError as error: response = error
        if response.status == 302:
            location = app_redirect(response.headers.get('Location'))
            body = response.read(65537); c.need(len(body) <= 65536 and response.read(1) == b'', 'app-redirect-body-eof')
            response.close(); receipt['responsesClosed'].append(response.closed); response = None
            receipt['attempts']['blob'] = 1
            try: response = opener.open(urllib.request.Request(location, headers=c.headers('blob')), timeout=45)
            except urllib.error.HTTPError as error: response = error
            location = None
        c.need(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity', 'app-http200')
        length = response.headers.get('Content-Length')
        c.need(length is not None and length.isdigit() and int(length) == APP_BYTES, 'app-declared-size')
        sink = destination.open('xb'); receipt['body'] = {}
        c.copy_exact(response, sink, APP_BYTES, APP_SHA, time.monotonic() + 900, receipt['body'])
        sink.flush(); receipt['sealed'] = True
    except Exception as error:
        receipt['failureType'] = type(error).__name__
        raise ValueError('public-app-acquisition-failed') from None
    finally:
        if response is not None: response.close(); receipt['responsesClosed'].append(response.closed)
        if sink is not None: sink.close(); receipt['outputClosed'] = sink.closed
        receipt['ok'] = receipt.get('sealed') is True and 'failureType' not in receipt and all(receipt['responsesClosed']) and receipt['outputClosed']
        c.write(out / 'app-transfer.receipt.json', receipt)
    c.need(receipt['ok'], 'app-transfer-closure')


def member_name(value):
    c.need(isinstance(value, str) and value and not value.startswith('/') and '\\' not in value
        and not re.search(r'[\x00-\x1f\x7f]', value) and all(v not in ('', '.', '..') for v in value.rstrip('/').split('/')), 'archive-relative-name')
    return value.rstrip('/')


def materialize(artifact, member, expected, destination):
    c.need(not os.path.lexists(destination), 'fresh-materialized-input')
    with zipfile.ZipFile(artifact) as archive:
        rows = [v for v in archive.infolist() if v.filename == member]
        c.need(len(rows) == 1 and not rows[0].is_dir() and rows[0].file_size == expected['bytes']
            and stat.S_IFMT(rows[0].external_attr >> 16) in (0, stat.S_IFREG), 'sole-regular-materialized-member')
        with archive.open(rows[0]) as stream, destination.open('xb') as sink:
            progress = c.copy_exact(stream, sink, expected['bytes'], expected['sha256'], time.monotonic() + 300)
    c.need(progress['bodyEOF'], 'materialized-original-eof')
    return {'path': str(destination), 'bytes': expected['bytes'], 'sha256': expected['sha256']}


def app_inventory(app):
    rows, total = {}, 0
    for parent, directories, files in os.walk(app, followlinks=False):
        for name in sorted(directories + files):
            file = Path(parent) / name; st = file.lstat(); relative = str(file.relative_to(app))
            row = {'mode': stat.S_IMODE(st.st_mode), 'type': stat.S_IFMT(st.st_mode)}
            if stat.S_ISREG(st.st_mode): total += st.st_size; row.update(c.file_pin(file)); row.pop('path')
            elif stat.S_ISLNK(st.st_mode):
                row['target'] = os.readlink(file)
                c.need(not os.path.isabs(row['target']) and file.resolve(strict=True).is_relative_to(app), 'internal-app-link')
            else: c.need(stat.S_ISDIR(st.st_mode), 'app-entry-type')
            rows[relative] = row
            c.need(len(rows) <= 50000 and total <= 3 * 1024**3, 'bounded-private-app')
    return rows


def prepare_app(ctx, archive, ditto_pin):
    with zipfile.ZipFile(archive) as compressed:
        rows = compressed.infolist(); names = [member_name(v.filename) for v in rows]
        c.need(len(rows) <= 50000 and len(names) == len(set(names)) and sum(v.file_size for v in rows) <= 3 * 1024**3, 'app-zip-cap-unique')
        for row, name in zip(rows, names):
            kind = stat.S_IFMT(row.external_attr >> 16)
            c.need((name == 'ReviewOps.app' or name.startswith('ReviewOps.app/')) and not row.flag_bits & 1
                and kind in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK) and row.file_size <= 512 * 1024**2, 'app-zip-type-size')
            if kind == stat.S_IFLNK:
                c.need(row.file_size <= 4096, 'app-link-cap')
                target = compressed.read(row).decode('utf-8'); member_name(str(Path(name).parent / target))
                c.need(not os.path.isabs(target) and os.path.normpath(str(Path(name).parent / target)).startswith('ReviewOps.app/'), 'app-zip-internal-link')
    applications = ctx['private'] / 'Applications'; applications.mkdir(mode=0o700)
    c.need(c.file_pin(Path('/usr/bin/ditto')) == ditto_pin, 'same-runner-ditto')
    ctx['tools'].run('extract-accepted-app', ['/usr/bin/ditto', '-xk', str(archive), str(applications)], seconds=180)
    app = applications / 'ReviewOps.app'; c.need(app.is_dir() and not app.is_symlink(), 'accepted-private-app')
    actual = {}
    for role, expected in [('asar', ASAR), ('executable', EXECUTABLE)]:
        value = c.file_pin(app / expected['path']); c.need(same_pin(value, expected), 'accepted-app-member'); actual[role] = value
    before = app_inventory(app); c.write(ctx['output'] / 'app-before-inventory.json', before)
    return app, actual, before


def runtime_primary(parent, identity, runtime, runtime_pin, evidence, parent_pin):
    c.need(parent.get('approved') is True and parent.get('allowConditionalRuntimeAcceptance') is True
        and runtime.get('ok') is True and runtime.get('status') == 'private-qemu-capability-observed'
        and runtime.get('harnessSource') == parent['expectedHarnessSource'] and runtime.get('productSource') == c.PRODUCT,
        'delegated-current-runtime-only')
    capability = runtime['capabilityHandoff']
    c.need(set(capability['probeEvidence']) == {'system-version', 'image-version', 'machines', 'accelerators'}, 'four-actual-probe-roles')
    for role in capability['probeEvidence'].values():
        receipt = checked_json(role['receiptPin'])
        c.need(receipt.get('wait') == receipt.get('poll') == 0 and receipt.get('signals') == receipt.get('retries') == 0
            and all(receipt.get(k) is True for k in ['stdoutEOF', 'stderrEOF', 'stdoutClosed', 'stderrClosed', 'stdoutFileClosed', 'stderrFileClosed']), 'capability-probe-original-closure')
        evidence_bytes(role['stdoutPin']); evidence_bytes(role['stderrPin'])
    lines = c.read_regular(checked_pin(evidence['machines']['stdoutPin'], 4 * 1024**2), 4 * 1024**2).decode().splitlines()
    c.need(any(line.split() and line.split()[0] == parent['machineName'] for line in lines), 'new-run-exact-machine')
    return {'acceptedRuntime': True, 'productSource': c.PRODUCT, 'harnessSource': parent['expectedHarnessSource'],
        'runID': int(identity['GITHUB_RUN_ID']), 'runtimeResultPin': runtime_pin, 'capabilityHandoff': capability,
        'machineName': parent['machineName'], 'conditionalParentAuthorityPin': parent_pin,
        'predicateContract': RECIPE, 'RootDirectRuntimeReviewClaimed': False}


def ui_base(source, private, app, driver, package, members, dependencies):
    return {'root': str(source), 'build': dict(BUILD), 'output': str(source / 'test-results/installed-linux-permission-ui/one'),
        'claimPath': str(private / 'installed-linux-permission-ui-once.json'),
        'driverPin': driver, 'privateRoot': str(private), 'packageApp': str(app), 'home': str(private / 'home'),
        'codeHome': str(private / 'home/.codex'), 'dataDir': str(private / 'data'), 'sshConfig': str(private / 'home/.ssh/config'),
        'packageZipPin': package, 'expectedASARPin': members['asar'], 'executablePin': members['executable'],
        'dependencyPins': dependencies}


def run_combined(ctx):
    p, out, private, source = ctx['parent'], ctx['output'], ctx['private'], ctx['source']
    dependencies_record = json.loads(c.read_regular(out / 'dependencies.json', 65536))
    c.need(dependencies_record.get('parentPin') == ctx['parentPin'] and dependencies_record.get('identity') == ctx['identity']
        and dependencies_record.get('lockSHA256') == p['npmLockSHA256'], 'same-run-dependencies')
    node = checked_pin(dependencies_record['nodePin'], 512 * 1024**2)
    fixed = {name: c.file_pin(Path('/usr/bin/' + filename)) for name, filename in
        [('hdiutil', 'hdiutil'), ('sshKeygen', 'ssh-keygen'), ('ditto', 'ditto')]}
    c.write(out / 'same-runner-tools.json', {'identity': ctx['identity'], 'node': dependencies_record['nodePin'], **fixed})
    c.write(out / 'capability-child-control.json', ctx['child'])
    c.write(out / 'capability-child-derivation.json', {'parentPin': ctx['parentPin'], 'recipe': RECIPE,
        'coordinatorPin': c.file_pin(Path(__file__).resolve()), 'childControlPin': c.file_pin(out / 'capability-child-control.json')})
    token = os.environ.pop('REVIEWOPS_ARTIFACT_TOKEN', None)
    c.headers('api', token)  # Validate the explicit token only after complete parent/source admission.
    cap_env = {**ctx['env'], **{key: os.environ[key] for key in CAP_CI_KEYS},
        'RUNNER_TEMP': os.environ['RUNNER_TEMP'], 'REVIEWOPS_ARTIFACT_TOKEN': token}
    # Only the capability transport child receives the dedicated read token; no Node/UI child receives it.
    cap_tools = c.load_adapter(source).OriginalTools(out, cap_env, source)
    cap_out = source / 'test-results/private-qemu-capability-orchestrator'
    cap_tools.run('capability-once', [str(Path(sys.executable).resolve()), '-I', '-B', str(source / 'scripts/diagnostics/private-qemu-capability.py'),
        '--parent', str(out / 'capability-child-control.json'), '--whole-proof', str(out / 'whole-root.original.json'), '--output', str(cap_out)], seconds=2700)
    cap_result = json.loads(c.read_regular(cap_out / 'result.json', 65536))
    c.need(cap_result.get('ok') is True and cap_result.get('adapterCalls') == 1 and cap_result.get('acceptedRuntime') is False
        and cap_result.get('runIdentity') == ctx['identity'], 'one-current-capability-observation')
    material = checked_json(cap_result['materializationPin']); runtime_pin = cap_result['runtimeResultPin']
    runtime = checked_json(runtime_pin); cap = runtime['capabilityHandoff']
    primary = runtime_primary(p, ctx['identity'], runtime, runtime_pin, cap['probeEvidence'], ctx['parentPin'])
    c.write(out / 'runtime-conditional-primary.json', primary)
    artifact = checked_pin(material['artifactStagedPin'], c.ZIP_BYTES)
    prepared_pin = material['preparedReportStagedPin']; prepared = checked_json(prepared_pin)
    image = materialize(artifact, 'installed-linux-supply/ubuntu-amd64.img', prepared['ubuntu']['imagePin'], private / 'ubuntu-amd64.img')
    elf = materialize(artifact, 'installed-linux-supply/genuine-codex-x86_64-linux', prepared['vendor']['elfPin'], private / 'genuine-codex-x86_64-linux')
    whole_pin = material['wholeProofStagedPin']; whole = json.loads(ctx['wholeRaw'])
    vm_material = {'originalRootPin': material['wholeProofOriginPin'], 'stagedRootPin': whole_pin,
        'files': [{'originalPin': whole['preparedSupplyPin'], 'localPin': prepared_pin},
                  {'originalPin': prepared['ubuntu']['imagePin'], 'localPin': image},
                  {'originalPin': prepared['vendor']['elfPin'], 'localPin': elf}],
        'capabilityMaterializationPin': cap_result['materializationPin'], 'conditionalParentAuthorityPin': ctx['parentPin']}
    c.write(out / 'vm-materialization.json', vm_material)
    app_zip = private / 'ReviewOps-1.4.1-dev-3-arm64.zip'; acquire_app(app_zip, out, token); token = None
    app, members, app_before = prepare_app(ctx, app_zip, fixed['ditto'])
    package_pin = {'path': str(app_zip), 'bytes': APP_BYTES, 'sha256': APP_SHA}
    app_primary = {'acceptedPrivateApp': True, 'productSource': c.PRODUCT, 'harnessSource': p['expectedHarnessSource'],
        'runID': int(ctx['identity']['GITHUB_RUN_ID']), 'privateRoot': str(private), 'packageZipPin': package_pin,
        'expectedASARPin': members['asar'], 'executablePin': members['executable'],
        'conditionalParentAuthorityPin': ctx['parentPin'], 'predicateContract': RECIPE, 'RootDirectAppReviewClaimed': False}
    c.write(out / 'private-app-conditional-primary.json', app_primary)
    old_table = (out / 'preflight-base.stdout').read_bytes().split(b'\0')
    old_names = sorted(row.split(b'\t', 1)[1].decode() for row in old_table if row)
    rows = [{'path': name, 'bytes': (source / name).stat().st_size, 'sha256': sha_file(source / name),
             'mode': stat.S_IMODE((source / name).stat().st_mode)} for name in old_names]
    c.need(len(rows) == 438, 'exact-base438-rows')
    c.write(out / 'base438-inventory.json', {'source': c.BASE, 'fileCount': 438, 'files': rows})
    c.source_guard(source, p, ctx['tools'], Path('/usr/bin/git'), 'before-owner')
    source_primary = {'accepted': True, 'productSource': c.PRODUCT, 'harnessSource': p['expectedHarnessSource'],
        'baselineFiles': 429, 'existingFilesUnchanged': True, 'baseSource': c.BASE, 'baseFiles': 438,
        'baseFilesUnchanged': True, 'baseInventoryPin': c.file_pin(out / 'base438-inventory.json'),
        'actualSourceFiles': 449, 'exactAdditions': sorted(c.PATHS), 'conditionalParentAuthorityPin': ctx['parentPin'], 'predicateContract': RECIPE}
    c.write(out / 'source-conditional-primary.json', source_primary)
    ui_driver = c.file_pin(source / 'scripts/diagnostics/installed-linux-permission-ui.mjs')
    c.need(ui_driver['sha256'] == UI_SHA, 'unchanged-ui-driver')
    owner, guards = source / 'scripts/diagnostics/installed-linux-permission-vm.mjs', source / 'scripts/diagnostics/installed-linux-vm-guards.mjs'
    pins = {'r3Root': whole_pin, 'preparedSupply': prepared_pin, 'materialization': c.file_pin(out / 'vm-materialization.json'),
        'runtimeRoot': c.file_pin(out / 'runtime-conditional-primary.json'), 'runtimeResult': runtime_pin,
        'sourceRoot': c.file_pin(out / 'source-conditional-primary.json'), 'base438Inventory': c.file_pin(out / 'base438-inventory.json'),
        'baseImage': image, 'vendorELF': elf, 'privateAppRoot': c.file_pin(out / 'private-app-conditional-primary.json')}
    request = {'schema': 1, 'phase': 'vm-owner', 'scenario': 'installed-linux-permission', 'productSource': c.PRODUCT,
        'harnessSource': p['expectedHarnessSource'], 'runID': int(ctx['identity']['GITHUB_RUN_ID']), 'root': str(source),
        'privateRoot': str(private), 'output': str(source / 'test-results/installed-linux-permission-vm/one'),
        'machineID': p['machineName'], 'inputPins': pins,
        'tools': {'node': dependencies_record['nodePin'], 'hdiutil': fixed['hdiutil'], 'sshKeygen': fixed['sshKeygen'],
                  'qemuSystem': cap['qemuSystemPin'], 'qemuImg': cap['qemuImgPin']},
        'ui': ui_base(source, private, app, ui_driver, package_pin, members, dependencies_record['dependencyPins']),
        'deadlines': {'tool': 180000, 'boot': 1800000, 'qmp': 30000, 'channel': 90000, 'ui': 1200000, 'poweroff': 300000},
        'maximumVMLaunches': 1, 'maximumAppLaunches': 1, 'maximumPowerdownRequests': 1}
    c.write(out / 'vm-request.derived.json', request)
    authority = {'approved': True, 'scope': CONTRACT, 'requestSHA256': c.file_pin(out / 'vm-request.derived.json')['sha256'],
        'runID': request['runID'], 'harnessSource': p['expectedHarnessSource'], 'productSource': c.PRODUCT,
        'ownerSHA256': c.file_pin(owner)['sha256'], 'guardsSHA256': c.file_pin(guards)['sha256'], 'uiDriverSHA256': UI_SHA,
        'predicateContract': CONTRACT, 'allowConditionalGuestProofAndUIApproval': True,
        'maximumVMLaunches': 1, 'maximumAppLaunches': 1, 'maximumPowerdownRequests': 1,
        'networkAcquisitionAuthorized': False, 'inputPins': pins, 'conditionalParentAuthorityPin': ctx['parentPin'],
        'combinedPredicateContract': RECIPE, 'RootDirectGuestOrUIReviewClaimed': False}
    c.write(out / 'vm-authority.derived.json', authority)
    ci = {key: os.environ[key] for key in CI_KEYS}
    vm_tools = c.load_adapter(source).OriginalTools(out, minimal_env(private / 'home', private / 'tmp', ci), source)
    vm_tools.run('original-vm-owner-once', [str(node), str(owner), '--request', str(out / 'vm-request.derived.json'),
        '--authority', str(out / 'vm-authority.derived.json')], seconds=3900)
    owner_result = checked_json(c.file_pin(Path(request['output']) / 'owner-result.json'))
    c.need(owner_result.get('ok') is True and owner_result.get('originalVMClosureConfirmed') is True
        and owner_result.get('vmLaunchAttempts') == owner_result.get('uiLaunchAttempts') == 1
        and owner_result.get('liveClosurePostRead') == 'passed' and owner_result.get('liveClosureFailure') is None,
        'actual-original-vm-ui-verdict')
    after = app_inventory(app); c.need(after == app_before, 'genuine-app-bytes-modes-links-preserved')
    c.write(out / 'app-after-inventory.json', after)
    c.source_guard(source, p, ctx['tools'], Path('/usr/bin/git'), 'after-owner')
    return {'ok': True, 'status': 'same-runner-observations-await-Root-final-acceptance',
        'ownerResultPin': c.file_pin(Path(request['output']) / 'owner-result.json'),
        'capabilityResultPin': runtime_pin, 'nativeQAAccepted': False, 'RootFinalAcceptance': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['preflight', 'dependencies', 'run'], required=True)
    parser.add_argument('--parent', type=Path, required=True)
    parser.add_argument('--whole-proof', type=Path, required=True)
    parser.add_argument('--public-proof', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node', type=Path)
    args = parser.parse_args(); ctx = None; result = {'ok': False, 'phase': args.phase, 'nativeQAAccepted': False}
    try:
        ctx = source_context(args, creating=args.phase == 'preflight')
        claim = ctx['output'] / (args.phase + '.once.claim')
        with claim.open('x') as stream: stream.write(ctx['parent']['controlID'] + '\n')
        if args.phase == 'preflight': preflight(ctx)
        elif args.phase == 'dependencies': dependencies(ctx, args.node)
        else: result.update(run_combined(ctx))
        result['ok'] = True
    except Exception as error:
        result.update({'failureType': type(error).__name__, 'reason': 'Controlled combined phase failed; retain sanitized records. No retry authorized.'})
    finally:
        if ctx is not None: c.write(ctx['output'] / (args.phase + '-result.json'), result)
        print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
