#!/usr/bin/env python3
"""Acquire and inspect issue 34 supply archives; never install, boot or launch them."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urljoin, urlsplit

# Isolated Python removes the script directory; load only this reviewed sibling.
_spec = importlib.util.spec_from_file_location('installed_linux_supply_guards',
                                            Path(__file__).with_name('installed_linux_supply_guards.py'))
_guards = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _guards
_spec.loader.exec_module(_guards)
from installed_linux_supply_guards import (
    ALLOWED_ADDITIONS, BASE, FORMULA_COMMIT, IMAGE_DIR, IMAGE_KEY, IMAGE_SHA,
    MAX_DOWNLOAD, Ownership, QEMU_BOTTLE, admit_request, archive_name, arm64_macho, bottle,
    checksum_row, elf_x86_64, initial_url, need, qcow_base,
)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            h.update(block)
    return h.hexdigest()


def pin(path):
    path = Path(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)}


def write(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


class OriginalTools:
    """Keep the original object and drain its pipes even after a failed observation."""
    def __init__(self, output, env, cwd):
        self.output, self.env, self.cwd = output, env, cwd
        self.ownership, self.receipts = Ownership(), []

    def run(self, label, argv, seconds=60):
        token = self.ownership.begin()
        start = stamp()
        stdout_path, stderr_path = self.output / (label + '.stdout'), self.output / (label + '.stderr')
        stdout = stdout_path.open('xb')
        try:
            stderr = stderr_path.open('xb')
        except Exception:
            stdout.close()
            raise
        try:
            child = subprocess.Popen(argv, cwd=self.cwd, env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except Exception as error:
            stdout.close()
            stderr.close()
            write(self.output / (label + '.pre-handle-failure.json'), {'pid': None,
                  'lifetime': 'UNKNOWN', 'errorType': type(error).__name__, 'signals': 0, 'retries': 0})
            raise RuntimeError('Original preparation process handle unavailable') from None
        self.ownership.retain(token, child)
        selector = selectors.DefaultSelector()
        eof = {'stdout': False, 'stderr': False}
        observed, discarded = dict.fromkeys(eof, 0), dict.fromkeys(eof, 0)
        failure, deadline = None, time.monotonic() + seconds
        def held(suffix, details):
            try:
                write(self.output / (label + suffix), {'pid': child.pid, 'signals': 0, 'retries': 0, **details})
            except OSError:
                pass  # A failed evidence disk cannot justify abandoning the original child.

        with stdout, stderr:
            sinks = {'stdout': stdout, 'stderr': stderr}
            for name in eof:
                try:
                    selector.register(getattr(child, name), selectors.EVENT_READ, name)
                except Exception:
                    held('.unregistered-original-HELD.json', {'lifetime': 'UNKNOWN', 'EOF': eof})
                    while True:
                        time.sleep(1)
            while selector.get_map() or child.poll() is None:
                if failure is None and time.monotonic() > deadline:
                    failure = 'observation deadline'
                    held('.HELD.json', {'stage': failure, 'EOF': eof, 'originalFailureRemainsFailure': True})
                if not selector.get_map():
                    time.sleep(.2)
                    continue
                try:
                    ready = selector.select(.2)
                except Exception:
                    held('.unreadable-selector-HELD.json', {'lifetime': 'UNKNOWN', 'EOF': eof})
                    while True:
                        time.sleep(1)
                for key, _ in ready:
                    try:
                        block = os.read(key.fd, 65536)
                    except OSError:
                        held('.unreadable-original-HELD.json', {'lifetime': 'UNKNOWN', 'EOF': eof})
                        # Do not close or replace an unconfirmed original stream with a PID lookup.
                        while True:
                            time.sleep(1)
                    name = key.data
                    if not block:
                        eof[name] = True
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    observed[name] += len(block)
                    if failure is None and observed[name] > 4 * 1024**2:
                        failure = 'output cap'
                        held('.HELD.json', {'stage': failure, 'EOF': eof, 'originalFailureRemainsFailure': True})
                    if failure is None:
                        try:
                            sinks[name].write(block)
                        except OSError:
                            failure = 'output sink unavailable'
                            discarded[name] += len(block)
                            held('.HELD.json', {'stage': failure, 'EOF': eof, 'originalFailureRemainsFailure': True})
                    else:
                        discarded[name] += len(block)
            code = child.wait()
        selector.close()
        receipt = {'pid': child.pid, 'argv': argv, 'startedAt': start, 'completedAt': stamp(),
                   'wait': code, 'poll': child.poll(), 'stdoutEOF': eof['stdout'], 'stderrEOF': eof['stderr'],
                   'stdoutClosed': child.stdout.closed, 'stderrClosed': child.stderr.closed,
                   'stdoutFileClosed': stdout.closed, 'stderrFileClosed': stderr.closed,
                   'signals': 0, 'retries': 0, 'failedObservation': failure,
                   'observedBytes': observed, 'discardedAfterFailure': discarded,
                   'originalFailureRemainsFailure': failure is not None}
        self.ownership.confirm(token, child, receipt)
        write(self.output / (label + '.receipt.json'), receipt)
        self.receipts.append(receipt)
        need(failure is None and code == 0, 'Original preparation tool failed: ' + label)
        return stdout_path.read_bytes()


class Transport:
    """One explicit request chain per resource; no retry and no retained signed URLs."""
    def __init__(self, output):
        self.output, self.total = output, 0
        self.deadline = time.monotonic() + 1800
        self.records = []

    def get(self, label, url, hosts, cap, expected_sha=None, expected_bytes=None, bearer=None, secret=False):
        # Queries are limited to this fixed public key lookup and an anonymous registry token.
        if secret:
            parsed = urlsplit(url)
            need(parsed.scheme == 'https' and parsed.hostname == 'ghcr.io' and parsed.path == '/token'
                 and not parsed.username and not parsed.password and not parsed.fragment, 'Unexpected token endpoint')
        elif url == 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x' + IMAGE_KEY:
            initial_url(url.split('?', 1)[0], {'keyserver.ubuntu.com'})
        else:
            initial_url(url, hosts)
        need(time.monotonic() < self.deadline, 'Supply transfer deadline')
        hops, started = [], stamp()

        class Redirects(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, request, response, code, message, headers, target):
                target = urljoin(request.full_url, target)
                parsed = urlsplit(target)
                need(not secret and len(hops) < 5 and parsed.scheme == 'https'
                     and parsed.hostname in hosts and parsed.port in (None, 443)
                     and not parsed.username and not parsed.password and not parsed.fragment,
                     'Unadmitted supply redirect')
                hops.append({'host': urlsplit(request.full_url).hostname, 'status': code})
                # Registry tokens never follow a redirect, including another GitHub host.
                return urllib.request.Request(target, headers={'User-Agent': 'ReviewOps-issue34-supply/1',
                                                               'Accept-Encoding': 'identity'})

            def http_error_302(self, request, response, code, message, headers):
                try:
                    target = headers.get('Location')
                    need(isinstance(target, str) and target, 'Missing supply redirect')
                    redirected = self.redirect_request(request, response, code, message, headers, target)
                finally:
                    response.close()
                return self.parent.open(redirected, timeout=45)

            http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

        http_failure = {}

        class Errors(urllib.request.HTTPDefaultErrorHandler):
            def http_error_default(self, request, response, code, message, headers):
                response.close()
                http_failure.update({'status': code, 'responseClosed': response.closed})
                raise RuntimeError('Supply HTTP status ' + str(code))

        headers = {'User-Agent': 'ReviewOps-issue34-supply/1', 'Accept-Encoding': 'identity'}
        if bearer is not None:
            need(urlsplit(url).hostname == 'ghcr.io' and not secret, 'Registry token destination differs')
            headers['Authorization'] = 'Bearer ' + bearer
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects(), Errors())
        observed, h, content = 0, hashlib.sha256(), bytearray()
        destination = None if secret else self.output / label
        sink = None if secret else destination.open('xb')
        response, failed = None, None
        eof = False
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=45) as response:
                need(response.status == 200 and response.headers.get('Content-Encoding') in (None, 'identity'),
                     'Unexpected supply response')
                declared = response.headers.get('Content-Length')
                need(declared is None or declared.isdigit() and int(declared) <= cap, 'Supply declared-size cap')
                while True:
                    need(time.monotonic() < self.deadline, 'Supply transfer deadline')
                    block = response.read(min(65536, cap + 1 - observed))
                    if not block:
                        eof = True
                        break
                    observed += len(block)
                    self.total += len(block)
                    need(observed <= cap and self.total <= MAX_DOWNLOAD, 'Supply byte cap')
                    h.update(block)
                    if sink is None:
                        content.extend(block)
                    else:
                        sink.write(block)
                need(declared is None or observed == int(declared), 'Incomplete declared response')
                need(expected_bytes is None or observed == expected_bytes, 'Supply exact size differs')
                need(expected_sha is None or h.hexdigest() == expected_sha, 'Supply SHA256 differs')
                hops.append({'host': urlsplit(response.url).hostname, 'status': response.status})
            need(response.closed, 'Original HTTP response is not closed')
        except Exception as error:
            failed = type(error).__name__
            raise
        finally:
            if sink is not None:
                sink.close()
            receipt = {'label': label, 'startedAt': started, 'completedAt': stamp(), 'hops': hops,
                       'bytes': observed, 'sha256': None if secret else h.hexdigest(), 'EOF': eof,
                       'responseObtained': response is not None,
                       'responseClosed': response.closed if response is not None else None,
                       'HTTPFailure': http_failure or None,
                       'outputClosed': sink is None or sink.closed, 'failedType': failed,
                       'requestChains': 1, 'retries': 0, 'anonymousRegistryTokenExchange': secret,
                       'registryBearerUsed': bearer is not None, 'tokenBodyRetained': False,
                       'socketTimeoutSeconds': 45, 'deadlineCheckedBetweenReads': True,
                       'hardInterruptInsideBlockedReadClaim': False}
            write(self.output / (label + '.receipt.json'), receipt)
            self.records.append(receipt)
        return bytes(content) if secret else destination


def bottle_inventory(path, prefix, firmware=False):
    entries, total, pins, executables = [], 0, {}, {}
    with tarfile.open(path, mode='r:gz') as archive:
        for item in archive:
            name = archive_name(item.name)
            ancestor = str(name) in {prefix, prefix.split('/', 1)[0]} and item.isdir()
            need(len(entries) < 30000 and (ancestor or str(name).startswith(prefix + '/')),
                 'Bottle archive root/count differs')
            need(item.isdir() or item.isfile() or item.issym() or item.islnk(), 'Unsupported bottle entry type')
            need(0 <= item.size <= 512 * 1024**2, 'Bottle entry cap')
            total += item.size
            need(total <= 4 * 1024**3, 'Bottle expansion cap')
            row = {'name': item.name, 'type': item.type.decode('ascii'), 'bytes': item.size,
                   'mode': item.mode & 0o7777, 'link': item.linkname if item.issym() or item.islnk() else None}
            if item.isfile():
                h, count, header = hashlib.sha256(), 0, b''
                with archive.extractfile(item) as stream:
                    for block in iter(lambda: stream.read(1024**2), b''):
                        if not header:
                            header = block[:32]
                        count += len(block)
                        need(count <= item.size, 'Bottle member grew')
                        h.update(block)
                need(count == item.size, 'Incomplete bottle member')
                row['sha256'] = h.hexdigest()
                if firmware and str(name) in {prefix + '/share/qemu/bios.bin', prefix + '/share/qemu/bios-256k.bin'}:
                    pins[name.name] = {key: row[key] for key in ('name', 'bytes', 'sha256', 'mode')}
                if firmware and str(name) in {prefix + '/bin/qemu-system-x86_64', prefix + '/bin/qemu-img'}:
                    arm64_macho(header)
                    executables[name.name] = {key: row[key] for key in ('name', 'bytes', 'sha256', 'mode')}
            entries.append(row)
    need(len({row['name'] for row in entries}) == len(entries), 'Duplicate bottle archive name')
    if firmware:
        need(set(pins) == {'bios.bin', 'bios-256k.bin'}, 'PC firmware is not present as two regular bottle files')
        need(set(executables) == {'qemu-system-x86_64', 'qemu-img'}, 'Expected ARM-host tools are not regular bottle files')
    return {'entries': entries, 'expandedRegularAndLinkDeclaredBytes': total, 'firmware': pins,
            'executables': executables, 'extracted': False, 'linksFollowed': False}


def collect_bottles(request, transport, output):
    source_url = 'https://raw.githubusercontent.com/Homebrew/homebrew-core/' + FORMULA_COMMIT + '/Formula/q/qemu.rb'
    source = transport.get('qemu-formula.rb', source_url, {'raw.githubusercontent.com'}, 32768)
    text = source.read_text()
    need('qemu-11.1.3.tar.xz' in text and QEMU_BOTTLE in text, 'Pinned formula does not declare the reviewed bottle')
    qemu_path = transport.get('formula-qemu.json', 'https://formulae.brew.sh/api/formula/qemu.json',
                              {'formulae.brew.sh'}, 2 * 1024**2)
    qemu = json.loads(qemu_path.read_bytes())
    need(qemu.get('name') == 'qemu', 'Formula identity differs')
    first = bottle(qemu, 'arm64_sequoia', '11.1.3', QEMU_BOTTLE)
    dependencies = qemu.get('runtime_dependencies')
    need(isinstance(dependencies, list) and 0 < len(dependencies) <= 48, 'Finite bottle runtime closure is missing')
    rows, names = [(first, qemu)], {'qemu'}
    for index, dependency in enumerate(dependencies):
        name = dependency.get('full_name', '')
        need(re.fullmatch('[a-z0-9+@._-]+', name) and name not in names, 'Unexpected runtime dependency')
        names.add(name)
        path = transport.get('formula-dependency-' + str(index) + '.json',
                             'https://formulae.brew.sh/api/formula/' + name + '.json', {'formulae.brew.sh'}, 2 * 1024**2)
        formula = json.loads(path.read_bytes())
        need(formula.get('name') == name and formula.get('versions', {}).get('stable') == dependency.get('version')
             and formula.get('revision', 0) == dependency.get('revision', 0), 'Dependency metadata version drift')
        available = formula.get('bottle', {}).get('stable', {}).get('files', {})
        tag = next((tag for tag in request['qemu']['dependencyBottleTags'] if tag in available), None)
        need(tag is not None, 'No explicitly admitted ARM dependency bottle; no source-build fallback')
        rows.append((bottle(formula, tag), formula))
    closure = []
    sealed_versions = {item['name']: (item['version'], item['revision']) for item, _ in rows}
    for index, (item, formula) in enumerate(rows):
        for dependency in formula.get('runtime_dependencies', []):
            need(sealed_versions.get(dependency.get('full_name')) ==
                 (dependency.get('version'), dependency.get('revision', 0)),
                 'Runtime dependency version/revision does not match the sealed closure')
        repository = 'homebrew/core/' + item['name'].replace('@', '/')
        token_url = 'https://ghcr.io/token?' + urlencode({'service': 'ghcr.io', 'scope': 'repository:' + repository + ':pull'})
        token = json.loads(transport.get('registry-token-' + str(index), token_url, {'ghcr.io'}, 32768, secret=True))
        bearer = token.get('token')
        need(isinstance(bearer, str) and 0 < len(bearer) <= 16384, 'Anonymous registry token absent')
        archive = transport.get('bottle-' + str(index) + '.tar.gz', item['url'],
                                {'ghcr.io', 'pkg-containers.githubusercontent.com'}, 512 * 1024**2,
                                expected_sha=item['sha256'], bearer=bearer)
        del bearer, token
        pkg_version = item['version'] + ('_' + str(item['revision']) if item['revision'] else '')
        inventory = bottle_inventory(archive, item['name'] + '/' + pkg_version, firmware=index == 0)
        inventory_path = output / ('bottle-' + str(index) + '.inventory.json')
        write(inventory_path, inventory)
        closure.append({**item, 'archivePin': pin(archive), 'inventoryPin': pin(inventory_path),
                        'firmware': inventory['firmware'], 'executables': inventory['executables']})
    return {'formulaSourcePin': pin(source), 'formulaMetadataPin': pin(qemu_path), 'bottles': closure,
            'archiveBytesVerified': True, 'installed': False, 'executableInvoked': False,
            'relocationAndCapabilityAcceptance': None, 'sourceBuilds': 0}


def collect_image(request, transport, tools, output, gpg):
    sums = transport.get('SHA256SUMS', IMAGE_DIR + 'SHA256SUMS', {'cloud-images.ubuntu.com'}, 32768)
    signature = transport.get('SHA256SUMS.gpg', IMAGE_DIR + 'SHA256SUMS.gpg', {'cloud-images.ubuntu.com'}, 8192)
    # A fixed key lookup, not a GPG network fetch. The fingerprint is checked locally.
    key_url = 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x' + IMAGE_KEY
    key = transport.get('ubuntu-image-key.asc', key_url, {'keyserver.ubuntu.com'}, 65536, secret=False)
    key_bytes = key.read_bytes()
    need(key_bytes.startswith(b'-----BEGIN PGP PUBLIC KEY BLOCK-----') and b'PRIVATE KEY' not in key_bytes,
         'Only a public Ubuntu signing key is admitted')
    gpg_home = output / 'gnupg'
    gpg_home.mkdir(mode=0o700)
    options = [str(gpg), '--no-options', '--homedir', str(gpg_home), '--batch', '--no-autostart',
               '--no-auto-key-retrieve', '--no-auto-key-import']
    tools.run('gpg-import-public-key', options + ['--import', str(key)])
    listed = tools.run('gpg-public-fingerprint', options + ['--with-colons', '--fingerprint', '--list-keys'])
    primary = []
    want_fingerprint = False
    for line in listed.decode('utf-8').splitlines():
        fields = line.split(':')
        if fields[0] == 'pub':
            want_fingerprint = True
        elif fields[0] == 'fpr' and want_fingerprint:
            primary.append(fields[9])
            want_fingerprint = False
    need(primary == [IMAGE_KEY], 'Ubuntu primary key fingerprint differs')
    status = tools.run('gpg-verify-checksums', options + ['--status-fd', '1', '--verify', str(signature), str(sums)])
    valid = [line.split()[2] for line in status.decode('utf-8').splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    need(valid == [IMAGE_KEY] and checksum_row(sums.read_text(), request['ubuntu']['name']) == IMAGE_SHA,
         'Signed Ubuntu checksum differs')
    image = transport.get('ubuntu-amd64.img', IMAGE_DIR + request['ubuntu']['name'],
                          {'cloud-images.ubuntu.com'}, 1024**3, expected_sha=IMAGE_SHA)
    with image.open('rb') as stream:
        header = stream.read(104)
    qcow_base(header)
    return {'imagePin': pin(image), 'checksumPin': pin(sums), 'signaturePin': pin(signature),
            'keyPin': pin(key), 'signingFingerprint': IMAGE_KEY, 'gpgExecutablePin': pin(gpg),
            'signatureVerified': True, 'guestBooted': False}


def collect_vendor(request, transport, output):
    vendor = request['vendor']
    archive = transport.get('official-linux-cli.tar.gz', vendor['url'],
                            {'github.com', 'release-assets.githubusercontent.com'}, vendor['bytes'],
                            vendor['sha256'], vendor['bytes'])
    elf = output / 'genuine-codex-x86_64-linux'
    members = []
    with tarfile.open(archive, mode='r:gz') as source:
        for item in source:
            archive_name(item.name)
            need(len(members) < 32 and item.isfile() and item.size <= 512 * 1024**2,
                 'Unexpected vendor archive entry')
            members.append(item.name)
            need(item.name == vendor['elfMember'], 'Only the admitted genuine ELF entry is accepted')
            with source.extractfile(item) as stream, elf.open('xb') as destination:
                count = 0
                for block in iter(lambda: stream.read(1024**2), b''):
                    count += len(block)
                    need(count <= item.size, 'Vendor ELF cap')
                    destination.write(block)
                need(count == item.size, 'Incomplete vendor ELF')
    need(members == [vendor['elfMember']], 'Expected exactly one genuine vendor ELF')
    with elf.open('rb') as stream:
        header = stream.read(64)
    elf_x86_64(header)
    elf.chmod(0o700)
    return {'officialArchiveURL': vendor['url'], 'tag': vendor['tag'], 'archivePin': pin(archive),
            'elfPin': pin(elf), 'versionObservedAtRuntime': None, 'executed': False,
            'OAuthOrCredentialsPrepared': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, type=Path)
    parser.add_argument('--approval', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    request_bytes = args.request.read_bytes()
    request, approval = json.loads(request_bytes), json.loads(args.approval.read_bytes())
    reviewed = admit_request(request, approval, request_bytes, os.environ)
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64', 'Actual ARM macOS host required')
    root = Path(__file__).resolve().parents[2]
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    output = args.output.absolute()
    need(not output.exists() and output.parent.resolve(strict=True) == root / 'test-results', 'Fresh diagnostic output required')
    gpg_value = shutil.which('gpg', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    need(gpg_value is not None, 'A preinstalled GPG verifier is required; no package install fallback')
    gpg = Path(gpg_value).resolve(strict=True)
    output.mkdir(mode=0o700)
    private = output / 'private'
    private.mkdir(mode=0o700)
    env = {'HOME': str(private), 'TMPDIR': str(runner_temp), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'LANG': 'en_US.UTF-8', 'TZ': 'UTC'}
    tools, transport = OriginalTools(output, env, root), Transport(output)
    result = {'schema': 1, 'phase': 'prepare-supply', 'status': 'preparation-in-progress', 'ok': False, 'startedAt': stamp(),
              'source': BASE, 'harnessSource': reviewed, 'requestPin': pin(args.request),
              'approvalPin': pin(args.approval), 'archivesOnly': True, 'executableInstalled': False,
              'vmBooted': False, 'applicationLaunched': False, 'CLIExecuted': False,
              'nativeQAAccepted': False, 'VMExecutionAuthority': None, 'guestRootAcceptancePin': None,
              'host': {'platform': sys.platform, 'machine': os.uname().machine, 'release': os.uname().release}}
    try:
        git = lambda label, *values: tools.run(label, ['/usr/bin/git', '-C', str(root), *values])
        need(git('source-head', 'rev-parse', 'HEAD').decode().strip() == reviewed
             and not git('source-clean', 'status', '--porcelain=v1'), 'Reviewed clean harness HEAD required')
        def table(raw):
            return {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0]
                    for row in raw.split(b'\0') if row}
        old, current = table(git('source-base', 'ls-tree', '-rz', BASE)), table(git('source-current', 'ls-tree', '-rz', 'HEAD'))
        need(len(old) == 429 and all(current.get(name) == row for name, row in old.items())
             and set(current) - set(old) == set(request['allowedAdditions']),
             'Only the exact declared diagnostic additions are allowed')
        result['sourceGuard'] = {'baseFiles': 429, 'oldFilesUnchanged': True, 'addedPaths': request['allowedAdditions']}
        result['qemu'] = collect_bottles(request, transport, output)
        result['ubuntu'] = collect_image(request, transport, tools, output, gpg)
        result['vendor'] = collect_vendor(request, transport, output)
        result['ok'] = True
        result['status'] = 'prepared-supply-only'
    except Exception as error:
        result['failedStageType'] = type(error).__name__
        result['status'] = 'preparation-failed'
        # Exceptions from HTTP libraries can contain signed URLs; never serialize them.
        result['failureDetails'] = 'Preparation stopped; inspect retained originals. No automatic retry or runtime fallback.'
    finally:
        result.update({'completedAt': stamp(), 'downloadedBytes': transport.total,
                       'originalToolReceipts': tools.receipts, 'transferReceipts': transport.records,
                       'VMReady': False, 'appUIQA': False})
        write(output / 'prepared-supply.json', result)
        records = [pin(path) for path in sorted(output.rglob('*')) if path.is_file() and 'gnupg' not in path.parts]
        write(output / 'manifest.json', {'files': records, 'fileCount': len(records), 'includesSecretKeys': False,
                                       'GNUPGWorkingDirectoryExcluded': True})
    need(result['ok'], 'Preparation failed; no VM or UI authorization was created')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Issue34 supply preparation stopped (' + type(error).__name__ + '); no runtime fallback.', file=sys.stderr)
        sys.exit(1)
