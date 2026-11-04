"""Inert guards for one private derivative of the sealed ARM QEMU supply."""
import hashlib
import json
import posixpath
from pathlib import PurePosixPath
import re
import struct

BASE = '81c2a48d08c6b00a23478c12e4ca9d1401a0cb4a'
REVIEWED_BASELINES = frozenset({BASE, '34bf2ed064a93c709a2f6d00caa70ca444abca55'})
PRODUCT = '2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a'
ZIP_SHA = '5f260806475c71e0eddd5909bd640f023bb3a22baa801506087bc979f9e7c4d5'
ZIP_BYTES = 1024957312
PHASE = 'issue34-private-qemu-capability'
ADDITIONS = {
    'scripts/diagnostics/private-qemu-runtime.py',
    'scripts/diagnostics/private_qemu_runtime_guards.py',
    'tests/private_qemu_runtime_test.py',
    'docs/diagnostics/private-qemu-runtime.md',
    'scripts/diagnostics/private-qemu-capability.py',
    '.github/workflows/private-qemu-capability.yml',
    'scripts/diagnostics/installed-linux-permission-combined.py',
    'scripts/diagnostics/installed-linux-permission-ui-v2.mjs',
    'scripts/diagnostics/installed-linux-permission-vm.mjs',
    'scripts/diagnostics/installed-linux-vm-guards.mjs',
    'tests/installed-linux-vm-guards.test.mjs',
    'docs/diagnostics/installed-linux-permission-vm.md',
}
DYLIB = {0xc, 0xd, 0x80000018, 0x8000001f, 0x20, 0x80000023}
RPATH = 0x8000001c
MAX_FILE = 512 * 1024**2


def need(value, reason):
    if not value:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def closed_path(name):
    need(isinstance(name, str) and name and '\\' not in name
         and not re.search(r'[\x00-\x1f\x7f]', name), 'unsafe-path')
    path = PurePosixPath(name)
    need(path.parts and not path.is_absolute() and '..' not in path.parts
         and posixpath.normpath(name.rstrip('/')) == name.rstrip('/'), 'unsafe-path')
    return str(path)


def prefix(value):
    # Twelve bytes also fit CELLAR placeholders without growing a C string.
    need(isinstance(value, str) and re.fullmatch('/tmp/r34[a-f0-9]{4}', value)
         and len(value.encode()) <= 13, 'private-prefix')
    return value


def admit(binding, approval, raw, whole, platform, machine):
    # This gate runs before opening an archive or creating/modifying a directory.
    need(binding.get('schema') == 1 and binding.get('phase') == PHASE
         and approval.get('approved') is True and approval.get('scope') == PHASE
         and approval.get('bindingSHA256') == sha(raw), 'phase-authority')
    need(whole.get('accepted') is True and whole.get('wholeSupplyAccepted') is True
         and whole.get('productSource') == PRODUCT
         and whole.get('bottleArchivesVerified') == 30
         and whole.get('preparedReportPreservedVerbatim') is True
         and whole.get('supplyZIPPin', {}).get('bytes') == ZIP_BYTES
         and whole.get('supplyZIPPin', {}).get('sha256') == ZIP_SHA, 'whole-supply-not-accepted')
    need(binding.get('productSource') == PRODUCT
         and binding.get('sourceBaseline') in REVIEWED_BASELINES
         and re.fullmatch('[a-f0-9]{40}', binding.get('harnessSource') or '')
         and binding.get('artifactZIPPin', {}).get('bytes') == ZIP_BYTES
         and binding.get('artifactZIPPin', {}).get('sha256') == ZIP_SHA,
         'source-or-artifact-binding')
    need(platform == 'darwin' and machine == 'arm64', 'arm-macos-only')
    prefix(binding.get('logicalPrefix'))
    return binding['harnessSource']


def subset_provenance(report, rows):
    """Join the actual accepted R3 prepared-report producer without aliases."""
    need(report.get('ok') is True and report.get('status') == 'prepared-supply-only'
         and report.get('source') == PRODUCT, 'accepted-prepared-report')
    actual = report.get('qemu', {}).get('bottles')
    need(isinstance(actual, list) and len(actual) == len(rows) == 30, 'accepted-qemu-subset')
    for row, accepted in zip(rows, actual):
        need(row['name'] == accepted.get('name') and row['pkgVersion'] == accepted.get('pkgVersion')
             and all(row[kind + 'Bytes'] == accepted.get(kind + 'Pin', {}).get('bytes')
                     and row[kind + 'SHA256'] == accepted.get(kind + 'Pin', {}).get('sha256')
                     for kind in ('archive', 'inventory')), 'accepted-qemu-subset-differs')


def safe_link(name, target, hard=False):
    """Return an archive-relative target, never follow an archive link."""
    name = closed_path(name)
    need(isinstance(target, str) and target and not target.startswith('/')
         and '\\' not in target and not re.search(r'[\x00-\x1f\x7f]', target), 'unsafe-link')
    resolved = posixpath.normpath(target if hard else posixpath.join(posixpath.dirname(name), target))
    resolved = closed_path(resolved)
    keg = '/'.join(name.split('/')[:2])
    need(resolved == keg or resolved.startswith(keg + '/'), 'link-leaves-keg')
    return resolved


def resolve_local(path, links, regular, directories=()):
    """Resolve only the supplied lexical tree, with a finite symlink walk."""
    path = closed_path(path)
    seen = set()
    for _ in range(64):
        need(path not in seen, 'link-cycle')
        seen.add(path)
        parts = path.split('/')
        found = False
        for index in range(1, len(parts) + 1):
            head = '/'.join(parts[:index])
            if head in links:
                path = closed_path(posixpath.normpath(posixpath.join(links[head], *parts[index:])))
                found = True
                break
        if not found:
            need(path in regular or path in directories, 'missing-supplied-path')
            return path
    raise ValueError('link-depth')


def mapped(text, logical):
    prefix(logical)
    return text.replace('@@HOMEBREW_CELLAR@@', logical + '/Cellar').replace(
        '@@HOMEBREW_PREFIX@@', logical).replace('/opt/homebrew', logical)


def cstring_prefixes(logical):
    """Preserve prefix width so pooled suffix pointers keep their original offset."""
    prefix(logical)
    def padded(width):
        parent, name = logical.rsplit('/', 1)
        value = parent + '/' * (1 + width - len(logical)) + name
        need(len(value.encode()) == width and posixpath.normpath(value) == logical, 'cstring-prefix-spelling')
        return value
    pairs = [(b'@@HOMEBREW_PREFIX@@', padded(19).encode()),
             (b'@@HOMEBREW_CELLAR@@', (logical + '/Cellar').encode()),
             (b'/opt/homebrew', padded(13).encode())]
    need(all(len(old) == len(new) and (
        posixpath.normpath(new.decode()) == logical or posixpath.normpath(new.decode()) == logical + '/Cellar')
        for old, new in pairs), 'cstring-prefix-spelling')
    return pairs


def system_path(path):
    return isinstance(path, str) and '..' not in PurePosixPath(path).parts and (
        path.startswith('/usr/lib/') or path.startswith('/System/Library/'))


def macho(raw):
    need(isinstance(raw, bytes) and 32 <= len(raw) <= MAX_FILE, 'macho-size')
    magic, cpu, subtype, kind, count, area, flags, reserved = struct.unpack_from('<8I', raw)
    need(magic == 0xfeedfacf and cpu == 0x100000c and kind in (2, 6, 8), 'thin-arm64-macho')
    need(count <= 4096 and area <= 1024**2 and 32 + area <= len(raw), 'load-command-bounds')
    commands, cstrings, position = [], [], 32
    for index in range(count):
        need(position + 8 <= 32 + area, 'load-command-header')
        command, size = struct.unpack_from('<II', raw, position)
        need(size >= 8 and size % 8 == 0 and position + size <= 32 + area, 'load-command-size')
        need(command != 0x27, 'dyld-environment-forbidden')
        row = {'index': index, 'command': command, 'offset': position, 'bytes': size}
        if command in DYLIB or command in (RPATH, 0xe):
            minimum = 24 if command in DYLIB else 12
            need(size >= minimum, 'path-command-size')
            offset = struct.unpack_from('<I', raw, position + 8)[0]
            need(minimum <= offset < size, 'path-command-offset')
            end = raw.find(b'\0', position + offset, position + size)
            need(end >= 0 and end - position - offset <= 4096, 'path-command-termination')
            try:
                text = raw[position + offset:end].decode('ascii')
            except UnicodeError as error:
                raise ValueError('path-command-encoding') from error
            need(text and not re.search(r'[\x00-\x1f\x7f]', text), 'path-command-encoding')
            row.update({'path': text, 'stringOffset': position + offset, 'stringBytes': end - position - offset})
            if command == 0xe:
                need(text == '/usr/lib/dyld', 'foreign-dynamic-linker')
        if command == 0x19:
            need(size >= 72, 'segment-command')
            sections = struct.unpack_from('<I', raw, position + 64)[0]
            segment_start, segment_bytes = struct.unpack_from('<QQ', raw, position + 40)
            need(72 + sections * 80 <= size, 'section-bounds')
            for number in range(sections):
                at = position + 72 + number * 80
                name = raw[at:at + 16].rstrip(b'\0')
                segment = raw[at + 16:at + 32].rstrip(b'\0')
                length = struct.unpack_from('<Q', raw, at + 40)[0]
                offset = struct.unpack_from('<I', raw, at + 48)[0]
                if name == b'__cstring' and segment == b'__TEXT':
                    need(raw[position + 8:position + 24].rstrip(b'\0') == b'__TEXT'
                         and struct.unpack_from('<I', raw, at + 64)[0] & 0xff == 2
                         and offset >= 32 + area and offset + length <= len(raw)
                         and segment_start <= offset and offset + length <= segment_start + segment_bytes
                         and segment_start + segment_bytes <= len(raw), 'cstring-section-bounds')
                    cstrings.append((offset, length))
        if command == 0x1d:
            need(size == 16, 'code-signature-command')
            offset, length = struct.unpack_from('<II', raw, position + 8)
            need(offset + length <= len(raw), 'code-signature-bounds')
            row.update({'signatureOffset': offset, 'signatureBytes': length})
        commands.append(row)
        position += size
    need(position == 32 + area and len(cstrings) <= 32, 'load-command-total')
    ordered = sorted(cstrings)
    need(all(a + n <= b for (a, n), (b, m) in zip(ordered, ordered[1:])), 'overlapping-cstring-sections')
    return {'kind': kind, 'subtype': subtype, 'flags': flags, 'commands': commands, 'cstringSections': cstrings}


def patch_macho(raw, logical):
    prefix(logical)
    parsed, changed = macho(raw), []
    output = bytearray(raw)
    spans = []
    for command in parsed['commands']:
        if 'path' in command and command['command'] != 0xe:
            spans.append((command['stringOffset'], command['stringBytes'], 'load-command'))
    for at, length, role in spans:
        old = raw[at:at + length]
        replacement = mapped(old.decode('ascii'), logical).encode()
        need(len(replacement) <= length, 'relocation-would-grow')
        if replacement != old:
            output[at:at + length + 1] = replacement + b'\0' * (length + 1 - len(replacement))
            changed.append({'offset': at, 'bytes': length + 1, 'role': role,
                            'beforeSHA256': sha(old + b'\0'), 'afterSHA256': sha(bytes(output[at:at + length + 1]))})
    prefix_pairs = cstring_prefixes(logical)
    for offset, length in parsed['cstringSections']:
        at, limit = offset, offset + length
        while at < limit:
            end = raw.find(b'\0', at, limit)
            need(end >= 0, 'unterminated-cstring')
            for old, replacement in prefix_pairs:
                position = raw.find(old, at, end)
                while position >= 0:
                    after = position + len(old)
                    if after == end or raw[after:after + 1] == b'/':
                        output[position:after] = replacement
                        changed.append({'offset': position, 'bytes': len(old), 'role': 'cstring-prefix',
                                        'beforeSHA256': sha(old), 'afterSHA256': sha(replacement)})
                    position = raw.find(old, position + len(old), end)
            at = end + 1
    need(len(changed) <= 2048, 'patch-count')
    need(len(output) == len(raw), 'relocation-size-change')
    macho(bytes(output))
    return bytes(output), changed


def dependency_path(path, loader, executable, rpaths, logical, links, regular, directories):
    """No dyld fallback to host-global libraries."""
    need(isinstance(path, str), 'dependency-path')
    if system_path(path):
        return None
    def expand(value):
        value = value.replace('@loader_path', logical + '/' + posixpath.dirname(loader)).replace(
            '@executable_path', logical + '/' + posixpath.dirname(executable))
        need(value.startswith(logical + '/'), 'outside-private-prefix')
        return closed_path(posixpath.normpath(value[len(logical) + 1:]))
    values = [expand(base + path[len('@rpath'):]) for base in rpaths] if path.startswith('@rpath/') else [expand(path)]
    found = set()
    for value in values:
        try:
            found.add(resolve_local(value, links, regular, directories))
        except ValueError as error:
            if str(error) != 'missing-supplied-path':
                raise
    need(len(found) == 1, 'unresolved-or-ambiguous-dependency')
    result = found.pop()
    need(result in regular, 'dependency-not-regular')
    return result


def rpath_context(paths, loader, executable, logical, links, regular, directories):
    need(len(paths) <= 32, 'rpath-cap')
    result = []
    for path in paths:
        path = path.replace('@loader_path', logical + '/' + posixpath.dirname(loader)).replace(
            '@executable_path', logical + '/' + posixpath.dirname(executable))
        need(path.startswith(logical + '/'), 'outside-private-rpath')
        relative = closed_path(posixpath.normpath(path[len(logical) + 1:]))
        resolved = resolve_local(relative, links, regular, directories)
        need(resolved in directories, 'rpath-not-directory')
        result.append(logical + '/' + resolved)
    return result


def probe_result(label, text):
    if label in ('system-version', 'image-version'):
        start = 'QEMU emulator version ' if label == 'system-version' else 'qemu-img version '
        need(re.match(re.escape(start) + r'11\.1\.3(?:[\s(]|$)', text) is not None, 'qemu-version')
    elif label == 'machines':
        need(re.search(r'(?m)^pc\s', text) is not None, 'pc-machine-unavailable')
    elif label == 'accelerators':
        need(re.search(r'(?m)^tcg\s*$', text) is not None, 'tcg-unavailable')
    else:
        raise ValueError('unadmitted-probe')


def retained_prefix(created, expected, observed):
    """False before creation; unknown for a lost or changed identity."""
    if created is not True:
        return False
    if observed is False:
        return False
    if expected is None or observed is None:
        return None
    return True if expected == observed else None


class Ownership:
    """An original object, never a PID, closes only its current attempt."""
    def __init__(self):
        self.current = None

    def begin(self):
        need(self.current is None or self.current['closed'], 'unresolved-owner')
        token = object()
        self.current = {'token': token, 'owner': None, 'closed': False}
        return token

    def retain(self, token, original):
        need(self.current is not None and self.current['token'] is token and original is not None
             and self.current['owner'] is None, 'foreign-owner')
        self.current['owner'] = original

    def confirm(self, token, original, receipt):
        need(self.current is not None and self.current['token'] is token
             and self.current['owner'] is original and original is not None, 'foreign-owner')
        need(type(receipt.get('wait')) is int and receipt.get('wait') == receipt.get('poll')
             and all(receipt.get(k) is True for k in ('stdoutEOF', 'stderrEOF', 'stdoutClosed', 'stderrClosed'))
             and receipt.get('signals') == receipt.get('retries') == 0, 'unconfirmed-original')
        self.current['closed'] = True
