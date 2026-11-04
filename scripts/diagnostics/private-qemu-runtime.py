#!/usr/bin/env python3
"""Build and probe one private QEMU derivative only after explicit Root admission."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import selectors
import stat
import subprocess
import sys
import tarfile
import time
import zipfile

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('private_qemu_runtime_guards',
                                             Path(__file__).with_name('private_qemu_runtime_guards.py'))
_guards = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _guards
_spec.loader.exec_module(_guards)
from private_qemu_runtime_guards import (
    ADDITIONS, BASE, DYLIB, MAX_FILE, Ownership, PHASE, PRODUCT, RPATH, ZIP_BYTES, ZIP_SHA,
    admit, closed_path, dependency_path, macho, mapped, need, patch_macho, probe_result,
    resolve_local, rpath_context, safe_link, subset_provenance, retained_prefix,
)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            h.update(block)
    return h.hexdigest()


def pin(path):
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha_file(path)}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n')


def checked_pin(value, cap):
    need(isinstance(value, dict) and isinstance(value.get('path'), str), 'unbound-input-pin')
    path = Path(value['path'])
    info = path.lstat()
    need(path.is_absolute() and stat.S_ISREG(info.st_mode) and 0 < info.st_size <= cap
         and info.st_size == value.get('bytes') and sha_file(path) == value.get('sha256'), 'input-pin-mismatch')
    return path


def read_json(value, cap=4 * 1024**2):
    return json.loads(checked_pin(value, cap).read_bytes())


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



def snapshot(root):
    rows = {}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(parent) / name
            info = path.lstat()
            relative = str(path.relative_to(root))
            row = {'mode': stat.S_IMODE(info.st_mode), 'type': stat.S_IFMT(info.st_mode)}
            if stat.S_ISREG(info.st_mode):
                row.update({'bytes': info.st_size, 'sha256': sha_file(path)})
            elif stat.S_ISLNK(info.st_mode):
                row['target'] = os.readlink(path)
            else:
                need(stat.S_ISDIR(info.st_mode), 'unexpected-derived-entry')
            rows[relative] = row
            need(len(rows) <= 20000, 'derived-entry-cap')
    return rows


def blueprint(value):
    rows = value.get('bottles')
    need(value.get('schema') == 1 and value.get('artifactSHA256') == ZIP_SHA
         and isinstance(rows, list) and len(rows) == 30, 'subset-blueprint')
    names = set()
    for index, row in enumerate(rows):
        name, version = row.get('name'), row.get('pkgVersion')
        need(isinstance(name, str) and re.fullmatch('[a-z0-9][a-z0-9+@._-]{0,79}', name)
             and name not in names and isinstance(version, str)
             and re.fullmatch('[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}', version), 'subset-name-version')
        names.add(name)
        for kind, suffix in [('archive', 'tar.gz'), ('inventory', 'inventory.json')]:
            need(row.get(kind + 'Member') == 'installed-linux-supply/bottle-' + str(index) + '.' + suffix
                 and type(row.get(kind + 'Bytes')) is int
                 and 0 < row[kind + 'Bytes'] <= (MAX_FILE if kind == 'archive' else 4 * 1024**2)
                 and re.fullmatch('[a-f0-9]{64}', row.get(kind + 'SHA256', '')), 'subset-member-pin')
    need(rows[0]['name'] == 'qemu' and rows[0]['pkgVersion'] == '11.1.3', 'qemu-root')
    return rows


def seal_subset(archive, rows):
    inventories, count, expanded = [], 0, 0
    need(len(archive.infolist()) <= 300 and len({x.filename for x in archive.infolist()}) == len(archive.infolist()),
         'artifact-entry-set')
    for row in rows:
        for kind in ('archive', 'inventory'):
            info = archive.getinfo(row[kind + 'Member'])
            need(info.file_size == row[kind + 'Bytes'], 'subset-member-size')
            h, observed = hashlib.sha256(), 0
            with archive.open(info) as stream:
                for block in iter(lambda: stream.read(1024**2), b''):
                    observed += len(block)
                    need(observed <= row[kind + 'Bytes'], 'subset-member-cap')
                    h.update(block)
            need(observed == row[kind + 'Bytes'] and h.hexdigest() == row[kind + 'SHA256'], 'subset-member-hash')
        inventory = json.loads(archive.read(row['inventoryMember']))
        entries = inventory['entries']
        need(isinstance(entries, list) and len(entries) <= 30000
             and len({x['name'] for x in entries}) == len(entries), 'inventory-entry-set')
        keg = row['name'] + '/' + row['pkgVersion']
        for item in entries:
            name = closed_path(item['name'])
            need((name in (row['name'], keg) and item['type'] == '5') or name.startswith(keg + '/'),
                 'inventory-keg-root')
            need(item['type'] in ('0', '5', '2') and 0 <= item['bytes'] <= MAX_FILE
                 and item['mode'] & 0o7000 == 0, 'inventory-type-mode')
            if item['type'] == '2':
                safe_link(name, item['link'])
            expanded += item['bytes']
        count += len(entries)
        need(count <= 18000 and expanded <= 1024**3, 'subset-expansion-cap')
        inventories.append(inventory)
    return inventories, {'entries': count, 'declaredExpandedBytes': expanded, 'archiveCount': 30}


def extract_subset(archive, rows, inventories, root):
    links, modes, regular, directories = {}, {}, set(), {'Cellar', 'opt'}
    (root / 'Cellar').mkdir()
    (root / 'opt').mkdir()
    deferred = []
    for row, inventory in zip(rows, inventories):
        expected = {x['name']: x for x in inventory['entries']}
        seen = set()
        with archive.open(row['archiveMember']) as source, tarfile.open(fileobj=source, mode='r|gz') as tar:
            for item in tar:
                need(item.name in expected and item.name not in seen, 'tar-inventory-set')
                seen.add(item.name)
                observation = expected[item.name]
                need(item.type.decode('ascii') == observation['type'] and item.size == observation['bytes']
                     and item.mode & 0o7777 == observation['mode']
                     and (item.linkname if item.issym() or item.islnk() else None) == observation['link'],
                     'tar-inventory-entry')
                name = 'Cellar/' + closed_path(item.name)
                path = root / name
                if item.isdir():
                    path.mkdir(mode=0o700, parents=True, exist_ok=True)
                    directories.add(name)
                elif item.isfile():
                    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    h, count = hashlib.sha256(), 0
                    with tar.extractfile(item) as incoming, path.open('xb') as output:
                        for block in iter(lambda: incoming.read(1024**2), b''):
                            count += len(block)
                            need(count <= item.size, 'tar-member-grew')
                            output.write(block)
                            h.update(block)
                    need(count == item.size and h.hexdigest() == observation['sha256'], 'tar-member-hash')
                    path.chmod(item.mode & 0o777)
                    regular.add(name)
                    modes[name] = item.mode & 0o777
                else:
                    target = 'Cellar/' + safe_link(item.name, item.linkname)
                    links[name] = target
                    deferred.append((name, target, item.linkname))
            need(seen == set(expected), 'tar-inventory-incomplete')
    # No links exist while regular files are written; archive parents cannot redirect writes.
    for name, target, literal in deferred:
        path = root / name
        need(not os.path.lexists(path), 'link-destination-exists')
        for parent in path.parents:
            if parent == root:
                break
            need(stat.S_ISDIR(parent.lstat().st_mode), 'archive-link-parent')
        path.symlink_to(literal)
    for row in rows:
        name = 'opt/' + row['name']
        target = 'Cellar/' + row['name'] + '/' + row['pkgVersion']
        (root / name).symlink_to('../' + target)
        links[name] = target
    for name in links:
        resolve_local(name, links, regular, directories)
    return links, regular, directories, modes


def native_files(root, regular):
    selected = []
    for name in sorted(regular):
        with (root / name).open('rb') as stream:
            header = stream.read(16)
        if header[:4] == b'\xcf\xfa\xed\xfe':
            kind = int.from_bytes(header[12:16], 'little')
            if kind in (2, 6, 8):
                macho((root / name).read_bytes())
                selected.append(name)
        elif '/lib/' in name and name.endswith(('.dylib', '.so')):
            need(False, 'unsupported-library-format')
    need(2 <= len(selected) <= 256, 'native-file-cap')
    return selected


def walk_dependencies(root, native, logical, links, regular, directories):
    allowed, report, seen = set(native), [], set()
    main = 'Cellar/qemu/11.1.3/bin/qemu-system-x86_64'
    pending = [(name, name if macho((root / name).read_bytes())['kind'] == 2 else main, ()) for name in native]
    while pending:
        name, executable, inherited = pending.pop()
        key = (name, executable, inherited)
        if key in seen:
            continue
        seen.add(key)
        need(len(seen) <= 16384, 'dependency-context-cap')
        parsed = macho((root / name).read_bytes())
        paths = [x['path'] for x in parsed['commands'] if x['command'] == RPATH]
        own = rpath_context(paths, name, executable, logical, links, regular, directories)
        rpaths = list(dict.fromkeys(own + list(inherited)))
        need(len(rpaths) <= 32, 'inherited-rpath-cap')
        for command in parsed['commands']:
            if command['command'] in DYLIB - {0xd}:
                target = dependency_path(command['path'], name, executable, rpaths, logical, links, regular, directories)
                need(target is None or target in allowed, 'dependency-is-not-supplied-native-code')
                report.append({'loader': name, 'executableContext': executable, 'rpaths': rpaths,
                               'command': command['command'], 'path': command['path'],
                               'resolvedPrivateFile': target, 'systemReferenceOnly': target is None})
                need(len(report) <= 65536, 'dependency-edge-cap')
                if target is not None:
                    pending.append((target, executable, tuple(rpaths)))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', required=True, type=Path)
    parser.add_argument('--approval', required=True, type=Path)
    args = parser.parse_args()
    raw = args.binding.read_bytes()
    binding, approval = json.loads(raw), json.loads(args.approval.read_bytes())
    # False authority fails before loading any further input, let alone extraction.
    need(approval.get('approved') is True and approval.get('scope') == PHASE
         and approval.get('bindingSHA256') == hashlib.sha256(raw).hexdigest(), 'phase-authority')
    whole = read_json(binding.get('wholeSupplyAcceptancePin'))
    harness = admit(binding, approval, raw, whole, sys.platform, os.uname().machine)
    source = Path(__file__).resolve().parents[2]
    output = Path(binding['output']).absolute()
    logical = binding['logicalPrefix']
    need(not os.path.lexists(output) and output.parent.resolve(strict=True) == source / 'test-results',
         'fresh-output')
    need(not os.path.lexists(logical) and Path('/tmp').resolve(strict=True) == Path('/private/tmp'),
         'fresh-private-prefix')
    codesign = checked_pin(binding.get('codesignPin'), MAX_FILE)
    git = checked_pin(binding.get('gitPin'), MAX_FILE)
    need(codesign == Path('/usr/bin/codesign') and git == Path('/usr/bin/git'), 'system-tool-path')
    artifact = checked_pin(binding['artifactZIPPin'], ZIP_BYTES)
    subset = read_json(binding.get('subsetBlueprintPin'))
    rows = blueprint(subset)
    staged_report = binding.get('acceptedPreparedReportPin', {})
    need(all(staged_report.get(k) == whole.get('preparedSupplyPin', {}).get(k)
             for k in ('bytes', 'sha256')), 'staged-report-origin-pin')
    accepted_report = read_json(staged_report)
    subset_provenance(accepted_report, rows)
    output.mkdir(mode=0o700)
    private = output / 'private'
    private.mkdir(mode=0o700)
    temporary = private / 'tmp'
    temporary.mkdir(mode=0o700)
    env = {'HOME': str(private), 'TMPDIR': str(temporary), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'LANG': 'en_US.UTF-8', 'TZ': 'UTC'}
    tools = OriginalTools(output, env, source)
    result = {'schema': 1, 'phase': PHASE, 'ok': False, 'startedAt': stamp(), 'productSource': PRODUCT,
              'harnessSource': harness, 'bindingPin': pin(args.binding), 'approvalPin': pin(args.approval),
              'wholeSupplyAcceptancePin': binding['wholeSupplyAcceptancePin'], 'originalInputWriteAttempted': False,
              'VMStarted': False, 'SSHStarted': False, 'applicationLaunched': False, 'nativeUIAccepted': False}
    prefix_created, identity = False, None
    try:
        def source_guard(label):
            run = lambda suffix, *values: tools.run(label + suffix, [str(git), '-C', str(source), *values])
            need(run('-head', 'rev-parse', 'HEAD').decode().strip() == harness
                 and not run('-clean', 'status', '--porcelain=v1'), 'clean-harness')
            def table(data):
                return {x.split(b'\t', 1)[1]: x.split(b'\t', 1)[0] for x in data.split(b'\0') if x}
            old = table(run('-base', 'ls-tree', '-rz', binding['sourceBaseline']))
            current = table(run('-current', 'ls-tree', '-rz', 'HEAD'))
            need(len(old) == 438 and all(current.get(n) == v for n, v in old.items())
                 and {n.decode() for n in set(current) - set(old)} == ADDITIONS, 'diagnostic-only-source')
        source_guard('before')
        with zipfile.ZipFile(artifact) as archive:
            inventories, result['sealedSubset'] = seal_subset(archive, rows)
            tab_raw = archive.read('installed-linux-supply/bottle-0.tab.json')
            need(len(tab_raw) == 6447 and hashlib.sha256(tab_raw).hexdigest() ==
                 '9f86bc4693ee848160c6eaeff3a8c915e8ca27ea1e2c16f20bb45de4f51b09b7', 'root-tab-seal')
            tab = json.loads(tab_raw)
            need(len(tab.get('changed_files', [])) == 8 and len(set(tab['changed_files'])) == 8, 'root-text-file-set')
            os.mkdir(logical, 0o700)
            prefix_created = True
            root = Path(logical)
            identity = root.lstat()
            need(stat.S_ISDIR(identity.st_mode) and identity.st_uid == os.getuid()
                 and stat.S_IMODE(identity.st_mode) == 0o700
                 and root.resolve(strict=True) == Path('/private/tmp') / root.name, 'owned-prefix')
            links, regular, directories, modes = extract_subset(archive, rows, inventories, root)
        before = snapshot(root)
        write(output / 'before-inventory.json', before)
        native = native_files(root, regular)
        patches = []
        for name in native:
            path = root / name
            original = path.read_bytes()
            derivative, changes = patch_macho(original, logical)
            if changes:
                path.chmod(modes[name] | 0o200)
                with path.open('r+b') as stream:
                    stream.write(derivative)
                patches.append({'path': name, 'originalSHA256': hashlib.sha256(original).hexdigest(),
                                'patchedSHA256': hashlib.sha256(derivative).hexdigest(), 'changes': changes})
        # Only the eight producer-listed QEMU firmware JSON files are text-relocated.
        text_changes = []
        for relative in tab.get('changed_files', []):
            need(re.fullmatch(r'share/qemu/firmware/[0-9A-Za-z_.-]+\.json', relative), 'unadmitted-text-file')
            name = 'Cellar/qemu/11.1.3/' + relative
            need(name in regular, 'missing-firmware-json')
            path = root / name
            original = path.read_bytes()
            need(len(original) <= 1024**2, 'firmware-json-cap')
            text = original.decode('utf-8')
            json.loads(text)
            updated = mapped(text, logical).encode()
            json.loads(updated)
            if updated != original:
                path.chmod(modes[name] | 0o200)
                path.write_bytes(updated)
                path.chmod(modes[name])
                text_changes.append({'path': name, 'beforeSHA256': hashlib.sha256(original).hexdigest(),
                                     'afterSHA256': hashlib.sha256(updated).hexdigest()})
        write(output / 'bounded-relocations.json', {'native': patches, 'firmwareJSON': text_changes})
        dependency_report = walk_dependencies(root, native, logical, links, regular, directories)
        write(output / 'non-system-dependency-walk.json', dependency_report)
        signed = []
        for index, name in enumerate(native):
            path = root / name
            path.chmod(modes[name] | 0o200)
            patched = pin(path)
            tools.run('sign-' + str(index), [str(codesign), '--force', '--sign', '-', '--timestamp=none', str(path)])
            tools.run('verify-sign-' + str(index), [str(codesign), '--verify', '--strict', str(path)])
            path.chmod(modes[name])
            macho(path.read_bytes())
            signed.append({'path': name, 'beforeSigningPin': patched, 'derivativeSignedPin': pin(path)})
        need(walk_dependencies(root, native, logical, links, regular, directories) == dependency_report,
             'signing-changed-dependency-paths')
        executables = {'system': 'Cellar/qemu/11.1.3/bin/qemu-system-x86_64',
                       'image': 'Cellar/qemu/11.1.3/bin/qemu-img'}
        need(set(executables.values()) <= set(native), 'qemu-tools-not-native')
        probes = [('system-version', [str(root / executables['system']), '--version']),
                  ('image-version', [str(root / executables['image']), '--version']),
                  ('machines', [str(root / executables['system']), '-machine', 'help']),
                  ('accelerators', [str(root / executables['system']), '-accel', 'help'])]
        for label, argv in probes:
            probe_result(label, tools.run(label, argv).decode('utf-8'))
        after = snapshot(root)
        write(output / 'after-inventory.json', after)
        permitted = set(native) | {x['path'] for x in text_changes}
        need(set(before) == set(after) and all(after[n] == row for n, row in before.items() if n not in permitted),
             'unexpected-derived-change')
        need((root.lstat().st_dev, root.lstat().st_ino) == (identity.st_dev, identity.st_ino), 'prefix-incarnation')
        need(sha_file(artifact) == ZIP_SHA and artifact.stat().st_size == ZIP_BYTES, 'original-artifact-changed')
        source_guard('after')
        probe_evidence = {label: {'receiptPin': pin(output / (label + '.receipt.json')),
                                 'stdoutPin': pin(output / (label + '.stdout')),
                                 'stderrPin': pin(output / (label + '.stderr'))} for label, _ in probes}
        data_directory = root / 'Cellar/qemu/11.1.3/share/qemu'
        handoff = {'qemuSystemPin': pin(root / executables['system']), 'qemuImgPin': pin(root / executables['image']),
                   'firmwarePins': {name: pin(data_directory / name) for name in ('bios.bin', 'bios-256k.bin')},
                   'dataDirectory': str(data_directory), 'physicalDataDirectory': str(data_directory.resolve()),
                   'installedInventoryPin': pin(output / 'after-inventory.json'),
                   'logicalPrefix': logical, 'physicalPrefix': str(root.resolve()),
                   'machineListed': 'pc', 'acceleratorListed': 'tcg', 'probeEvidence': probe_evidence}
        result.update({'ok': True, 'status': 'private-qemu-capability-observed', 'logicalPrefix': logical,
                       'physicalPrefix': str(root.resolve()), 'signedDerivatives': signed,
                       'sourceBaseline': binding['sourceBaseline'], 'capabilityHandoff': handoff,
                       'nativeFiles': len(native), 'nonSystemDependencyWalkPassed': True,
                       'probeOriginals': 4, 'TCGListedNotExecuted': True, 'VMExecutionAuthority': None,
                       'originalArtifactAfterPin': pin(artifact), 'originalsUnmodifiedAfterFreshHash': True})
    except Exception as error:
        result.update({'status': 'private-qemu-capability-failed', 'failureType': type(error).__name__,
                       'failureReason': 'Inspect retained originals and private derivative; no retry or cleanup fallback.'})
    finally:
        observed_identity = False
        if prefix_created:
            try:
                current = Path(logical).lstat()
                observed_identity = (current.st_dev, current.st_ino, current.st_uid, current.st_mode)
            except FileNotFoundError:
                observed_identity = False
            except OSError:
                observed_identity = None
        expected_identity = (identity.st_dev, identity.st_ino, identity.st_uid, identity.st_mode) if identity else None
        result.update({'completedAt': stamp(), 'originalToolReceipts': tools.receipts,
                       'signals': 0, 'retries': 0, 'privatePrefixCreated': prefix_created,
                       'privateDerivativeRetained': retained_prefix(prefix_created, expected_identity, observed_identity)})
        write(output / 'result.json', result)
        write(output / 'manifest.json', {'files': [pin(p) for p in sorted(output.rglob('*')) if p.is_file()]})
    need(result['ok'], 'private-qemu-capability-failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Private QEMU phase stopped (' + type(error).__name__ + '); no fallback.', file=sys.stderr)
        sys.exit(1)
