"""Inert admission and original-owner predicates for the issue 34 supply phase."""
import hashlib
import json
import posixpath
import re
from pathlib import PurePosixPath
from urllib.parse import urlsplit

BASE = '2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a'
TREE = 'f8e5ce991cf927d8064b1f7d7fe0604a48959303'
BRANCH = 'refs/heads/codex/issue34-installed-linux-ssh-ui'
REPOSITORY = 'season-framework/reviewops-local'
FORMULA_COMMIT = '6f3d127080e96f5192e5280fc94babd809e231ac'
QEMU_BOTTLE = 'a99cca4450c91f471e8e546b8fb48780e0cb2104ffbe15d394c1b431d44df620'
QEMU_MANIFEST = 'c03180c7ec3614b9c31f8fe287e0d95c608f4c7a59fc925197c54acfb175d0b8'
QEMU_TAB = '9f86bc4693ee848160c6eaeff3a8c915e8ca27ea1e2c16f20bb45de4f51b09b7'
IMAGE_SHA = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
IMAGE_KEY = 'D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81'
IMAGE_DIR = 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/'
APP_SHA = '2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead'
MAX_DOWNLOAD = 3 * 1024**3
ALLOWED_ADDITIONS = {
    '.github/workflows/installed-linux-permission-ui.yml',
    'scripts/diagnostics/installed-linux-permission-supply.py',
    'scripts/diagnostics/installed_linux_supply_guards.py',
    'scripts/diagnostics/installed-linux-permission-supply-request.json',
    'scripts/diagnostics/installed-linux-permission-ui.mjs',
    'tests/installed_linux_supply_test.py',
    'tests/installed-linux-permission-ui.test.mjs',
    'docs/diagnostics/installed-linux-permission-supply.md',
    'docs/diagnostics/installed-linux-permission-ui.md',
}
REQUIRED_PREPARATION = ALLOWED_ADDITIONS - {
    'scripts/diagnostics/installed-linux-permission-ui.mjs',
    'tests/installed-linux-permission-ui.test.mjs',
    'docs/diagnostics/installed-linux-permission-ui.md',
}


SAFE_REASONS = frozenset({
    'guard-rejected', 'supply-stage', 'oci-request-shape', 'oci-manifest-seal',
    'oci-manifest-schema', 'oci-response-identity', 'oci-reference', 'oci-layer-seal',
    'oci-tab-seal', 'oci-json', 'oci-root-selection', 'oci-runtime-row',
    'oci-nested-name', 'oci-neutral-tag', 'oci-host-arch',
})


class SupplyGuardFailure(ValueError):
    def __init__(self, message):
        super().__init__(message)
        # Never publish an arbitrary exception string, even one from this class.
        self.reason = message if message in SAFE_REASONS else 'guard-rejected'


def need(value, message):
    if not value:
        raise SupplyGuardFailure(message)


class FailureStage:
    NAMES = frozenset({'admission', 'source-guard', 'qemu-formula-source', 'qemu-manifests',
                       'qemu-bottle-archives', 'ubuntu-signature', 'ubuntu-image',
                       'vendor-archive', 'vendor-elf', 'complete'})

    def __init__(self):
        self.name = 'admission'

    def enter(self, name):
        need(name in self.NAMES, 'supply-stage')
        self.name = name

    def failure(self, error):
        return {'stage': self.name, 'exceptionType': type(error).__name__,
                'guardReason': error.reason if isinstance(error, SupplyGuardFailure)
                and error.reason in SAFE_REASONS else None}


OCI_ROW_KEYS = frozenset({'name', 'version', 'revision', 'bottleRebuild', 'pkgVersion', 'tag',
                          'manifestBytes', 'manifestSHA256', 'tabSHA256', 'bottleBytes', 'bottleSHA256'})


def oci_row(row):
    need(isinstance(row, dict) and set(row) == OCI_ROW_KEYS, 'oci-request-shape')
    need(isinstance(row['name'], str) and re.fullmatch('[a-z0-9][a-z0-9+@._-]{0,79}', row['name'])
         and isinstance(row['version'], str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}', row['version']),
         'oci-runtime-row')
    need(all(type(row[k]) is int and 0 <= row[k] <= 10000 for k in ('revision', 'bottleRebuild')),
         'oci-runtime-row')
    need(row['pkgVersion'] == row['version'] + ('_' + str(row['revision']) if row['revision'] else ''),
         'oci-runtime-row')
    if row['tag'] == 'all':
        need((row['name'], row['version'], row['revision'], row['bottleRebuild']) ==
             ('ca-certificates', '2026-10-20', 0, 0), 'oci-neutral-tag')
    else:
        need(row['tag'] == 'arm64_sequoia', 'oci-host-arch')
    need(type(row['manifestBytes']) is int and 0 < row['manifestBytes'] <= 512 * 1024
         and type(row['bottleBytes']) is int and 0 < row['bottleBytes'] <= 512 * 1024**2,
         'oci-request-shape')
    for key in ('manifestSHA256', 'tabSHA256', 'bottleSHA256'):
        digest(row[key])
    return row


def oci_request(qemu):
    rows = qemu.get('ociBottles')
    need(isinstance(rows, list) and len(rows) == 30, 'oci-root-selection')
    for row in rows:
        oci_row(row)
    need(len({row['name'] for row in rows}) == 30, 'oci-root-selection')
    root = rows[0]
    need(root == {'name': 'qemu', 'version': '11.1.3', 'revision': 0, 'bottleRebuild': 0,
                  'pkgVersion': '11.1.3', 'tag': 'arm64_sequoia', 'manifestBytes': 36175,
                  'manifestSHA256': QEMU_MANIFEST, 'tabSHA256': QEMU_TAB,
                  'bottleBytes': 113165355, 'bottleSHA256': QEMU_BOTTLE}, 'oci-root-selection')
    need(qemu.get('dependencyBottleTags') == ['arm64_sequoia']
         and sum(row['tag'] == 'all' for row in rows) == 1, 'oci-neutral-tag')
    return rows


def _json_object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'oci-json')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError) as error:
        raise SupplyGuardFailure('oci-json') from error
    need(isinstance(value, dict), 'oci-json')
    return value


def oci_manifest(raw, row):
    """Verify a reviewed immutable child, not a mutable index or formula API."""
    oci_row(row)
    need(isinstance(raw, bytes) and len(raw) == row['manifestBytes']
         and hashlib.sha256(raw).hexdigest() == row['manifestSHA256'], 'oci-manifest-seal')
    manifest = _json_object(raw)
    need(set(manifest) == {'schemaVersion', 'config', 'layers', 'annotations'}
         and type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 2,
         'oci-manifest-schema')
    config = manifest['config']
    need(isinstance(config, dict) and config.get('mediaType') == 'application/vnd.oci.image.config.v1+json'
         and isinstance(config.get('digest'), str) and re.fullmatch('sha256:[a-f0-9]{64}', config['digest'])
         and type(config.get('size')) is int and config['size'] > 0, 'oci-manifest-schema')
    annotations = manifest['annotations']
    need(isinstance(annotations, dict) and all(isinstance(k, str) and isinstance(v, str)
         for k, v in annotations.items()), 'oci-manifest-schema')
    reference = row['pkgVersion'] + '.' + row['tag'] + (
        '.' + str(row['bottleRebuild']) if row['bottleRebuild'] else '')
    need(annotations.get('com.github.package.type') == 'homebrew_bottle'
         and annotations.get('org.opencontainers.image.vendor') in {'homebrew', 'Homebrew'}
         and annotations.get('org.opencontainers.image.version') == row['pkgVersion']
         and annotations.get('org.opencontainers.image.ref.name') == reference
         and annotations.get('org.opencontainers.image.title') == row['name'] + ' ' + reference,
         'oci-reference')
    layers = manifest['layers']
    need(isinstance(layers, list) and len(layers) == 1 and isinstance(layers[0], dict), 'oci-layer-seal')
    layer = layers[0]
    need(layer.get('mediaType') == 'application/vnd.oci.image.layer.v1.tar+gzip'
         and layer.get('digest') == 'sha256:' + row['bottleSHA256']
         and type(layer.get('size')) is int and layer['size'] == row['bottleBytes']
         and annotations.get('sh.brew.bottle.digest') == row['bottleSHA256']
         and annotations.get('sh.brew.bottle.size') == str(row['bottleBytes']), 'oci-layer-seal')
    tab_text = annotations.get('sh.brew.tab')
    need(isinstance(tab_text, str) and hashlib.sha256(tab_text.encode()).hexdigest() == row['tabSHA256'],
         'oci-tab-seal')
    tab = _json_object(tab_text)
    if row['tag'] == 'all':
        need(tab.get('arch') is None and tab.get('built_on') is None, 'oci-neutral-tag')
    else:
        need(tab.get('arch') == 'arm64' and isinstance(tab.get('built_on'), dict)
             and tab['built_on'].get('os') == 'Macintosh', 'oci-host-arch')
    return tab, tab_text


def oci_runtime_set(rows, tabs):
    """Select exact root tuples while preserving literal nested build histories."""
    need(len(rows) == 30 and len(tabs) == 30, 'oci-root-selection')
    declarations = tabs[0].get('runtime_dependencies')
    need(isinstance(declarations, list) and len(declarations) == 29, 'oci-root-selection')
    selected, histories, differences, omissions = {}, [], [], []
    for declaration in declarations:
        need(isinstance(declaration, dict), 'oci-runtime-row')
        name = declaration.get('full_name')
        need(isinstance(name, str) and name not in selected, 'oci-runtime-row')
        selected[name] = declaration
    need(set(selected) == {row['name'] for row in rows[1:]}, 'oci-root-selection')
    for row in rows[1:]:
        declaration = selected[row['name']]
        need(all(declaration.get(key) == row[field] for key, field in (
            ('version', 'version'), ('revision', 'revision'), ('bottle_rebuild', 'bottleRebuild'),
            ('pkg_version', 'pkgVersion'))) and type(declaration.get('revision')) is int
            and type(declaration.get('bottle_rebuild')) is int
            and type(declaration.get('declared_directly')) is bool, 'oci-root-selection')
    for row, tab in zip(rows[1:], tabs[1:]):
        nested = tab.get('runtime_dependencies')
        need(isinstance(nested, list) and len(nested) <= 48, 'oci-runtime-row')
        seen = set()
        for declaration in nested:
            need(isinstance(declaration, dict) and isinstance(declaration.get('full_name'), str),
                 'oci-runtime-row')
            name = declaration['full_name']
            need(name in selected and name not in seen, 'oci-nested-name')
            seen.add(name)
            need(isinstance(declaration.get('version'), str) and isinstance(declaration.get('pkg_version'), str)
                 and type(declaration.get('revision')) is int and declaration['revision'] >= 0
                 and ('bottle_rebuild' not in declaration or type(declaration['bottle_rebuild']) is int
                      and declaration['bottle_rebuild'] >= 0), 'oci-runtime-row')
            missing = [key for key in ('version', 'revision', 'bottle_rebuild', 'pkg_version') if key not in declaration]
            changed = [key for key in ('version', 'revision', 'bottle_rebuild', 'pkg_version')
                       if key in declaration and declaration[key] != selected[name].get(key)]
            if missing:
                omissions.append({'bottle': row['name'], 'dependency': name, 'omittedFields': missing})
            if changed or missing:
                differences.append({'bottle': row['name'], 'literalDependency': declaration,
                                    'rootSelectedDependency': selected[name], 'differentFields': changed,
                                    'omittedFields': missing})
        histories.append({'bottle': row['name'], 'literalRuntimeDependencies': nested})
    return {'selectedRuntimeDeclarations': declarations, 'nestedBuildHistories': histories,
            'nestedBuildDifferences': differences, 'nestedOmittedFields': omissions}


def digest(value):
    need(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'A full SHA256 is required')
    return value


def initial_url(value, hosts):
    need(isinstance(value, str), 'URL must be a string')
    parsed = urlsplit(value)
    need(parsed.scheme == 'https' and parsed.hostname in hosts and parsed.port in (None, 443)
         and not parsed.username and not parsed.password and not parsed.fragment and not parsed.query,
         'Unadmitted initial URL')
    return parsed


def archive_name(value):
    need(isinstance(value, str) and value and '\\' not in value
         and not re.search(r'[\x00-\x1f\x7f]', value),
         'Unsafe archive name')
    path = PurePosixPath(value)
    need(not path.is_absolute() and '..' not in path.parts and path.parts
         and all(part not in ('', '.') for part in path.parts), 'Unsafe archive path')
    need(posixpath.normpath(value.rstrip('/')) == value.rstrip('/'), 'Noncanonical archive path')
    return path


def admit_request(request, approval, request_bytes, env):
    need(request.get('schema') == 1 and request.get('phase') == 'prepare-supply'
         and request.get('scenario') == 'installed-linux-permission', 'Wrong preparation scope')
    need(approval.get('approved') is True and approval.get('scope') == 'issue34-acquire-prepare-only'
         and approval.get('requestSHA256') == hashlib.sha256(request_bytes).hexdigest(),
         'External exact-request preparation authority is required')
    head = request.get('harnessSource')
    need(isinstance(head, str) and re.fullmatch('[a-f0-9]{40}', head), 'Reviewed harness commit is unbound')
    need(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('GITHUB_REF') == BRANCH
         and env.get('GITHUB_SHA') == head and env.get('GITHUB_REPOSITORY') == REPOSITORY
         and env.get('GITHUB_RUN_ATTEMPT') == '1'
         and env.get('GITHUB_ACTOR_ID') == '351100875', 'Only the reviewed first manual App-owned attempt is admitted')
    need(env.get('GITHUB_WORKFLOW_REF') == REPOSITORY + '/.github/workflows/installed-linux-permission-ui.yml@' + BRANCH,
         'Unexpected workflow source')
    need(request.get('source') == BASE and request.get('tree') == TREE and request.get('sourceFiles') == 429,
         'Accepted public product source differs')
    need(request.get('app') == {'target': 'darwin-arm64', 'version': '1.4.1', 'buildNumber': 41001,
         'developmentNumber': 3, 'zipBytes': 133831763, 'zipSHA256': APP_SHA}, 'R41 app identity differs')
    qemu = request.get('qemu', {})
    need(qemu.get('version') == '11.1.3' and qemu.get('formulaCommit') == FORMULA_COMMIT
         and qemu.get('bottleTag') == 'arm64_sequoia' and qemu.get('bottleSHA256') == QEMU_BOTTLE,
         'Reviewed ARM QEMU bottle differs')
    oci_request(qemu)
    image = request.get('ubuntu', {})
    need(image == {'directory': IMAGE_DIR, 'name': 'ubuntu-24.04-server-cloudimg-amd64.img',
                   'sha256': IMAGE_SHA, 'signingFingerprint': IMAGE_KEY}, 'Dated Ubuntu input differs')
    vendor = request.get('vendor', {})
    tag = vendor.get('tag')
    need(tag == 'rust-v0.166.0', 'Reviewed immutable vendor tag differs')
    expected_url = 'https://github.com/openai/codex/releases/download/' + tag + '/codex-x86_64-unknown-linux-musl.tar.gz'
    need(vendor.get('url') == expected_url, 'Only the fixed official Linux x86_64 archive is admitted')
    need(vendor.get('sha256') == 'a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978'
         and type(vendor.get('bytes')) is int and vendor['bytes'] == 121764138,
         'Reviewed exact vendor archive bytes differ')
    need(vendor.get('releaseID') == 428320524 and vendor.get('assetID') == 689712643
         and vendor.get('officialReleaseMetadataSHA256') == '21eefb68cd956cedec06809daa38fb8f7e18893730241ace6cf58cfa754814d2',
         'Official vendor metadata identity differs')
    need(vendor.get('elfMember') == 'codex-x86_64-unknown-linux-musl', 'Unexpected genuine ELF member')
    need(vendor.get('elfSHA256') is None, 'The extracted ELF seal cannot be asserted before preparation')
    need(request.get('maximumDownloadBytes') == MAX_DOWNLOAD, 'Preparation download cap differs')
    additions = request.get('allowedAdditions')
    need(isinstance(additions, list) and additions == sorted(set(additions))
         and REQUIRED_PREPARATION <= set(additions) <= ALLOWED_ADDITIONS,
         'Only the exact approved preparation additions and optional reviewed UI files are admitted')
    return head


def bottle(formula, tag, expected_version=None, expected_sha=None):
    need(isinstance(formula, dict) and re.fullmatch('[a-z0-9+@._-]+', formula.get('name', '')),
         'Unexpected formula name')
    need(not formula.get('disabled') and not formula.get('deprecated'), 'Unavailable formula')
    version = formula.get('versions', {}).get('stable')
    need(isinstance(version, str) and version and (expected_version is None or version == expected_version),
         'Formula version drift')
    item = formula.get('bottle', {}).get('stable', {}).get('files', {}).get(tag)
    need(isinstance(item, dict), 'No admitted bottle; source builds and architecture fallback are forbidden')
    checksum = digest(item.get('sha256'))
    need(expected_sha is None or checksum == expected_sha, 'Bottle digest drift')
    parsed = initial_url(item.get('url'), {'ghcr.io'})
    expected_path = '/v2/homebrew/core/' + formula['name'].replace('@', '/') + '/blobs/sha256:' + checksum
    need(parsed.path == expected_path, 'Bottle URL does not name its exact registry digest')
    return {'name': formula['name'], 'version': version, 'revision': formula.get('revision', 0),
            'tag': tag, 'url': item['url'], 'sha256': checksum}


def checksum_row(text, filename):
    matches = []
    for line in text.splitlines():
        match = re.fullmatch(r'([a-f0-9]{64}) [ *](.+)', line)
        need(match is not None, 'Malformed signed checksum document')
        if match[2] == filename:
            matches.append(match[1])
    need(len(matches) == 1, 'Expected image must occur exactly once in signed checksums')
    return matches[0]


def elf_x86_64(header):
    need(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01'
         and int.from_bytes(header[18:20], 'little') == 62, 'Expected a Linux x86_64 ELF64 entry')


def qcow_base(header):
    need(len(header) >= 104 and header[:4] == b'QFI\xfb'
         and int.from_bytes(header[4:8], 'big') in (2, 3)
         and int.from_bytes(header[8:20], 'big') == 0
         and int.from_bytes(header[32:36], 'big') == 0
         and 1024**3 <= int.from_bytes(header[24:32], 'big') <= 16 * 1024**3,
         'Expected a standalone, unencrypted QCOW2 base image')
    need(int.from_bytes(header[4:8], 'big') != 3 or not (int.from_bytes(header[72:80], 'big') & 4),
         'External QCOW data file is not admitted')


def arm64_macho(header):
    need(len(header) >= 8 and header[:4] == b'\xcf\xfa\xed\xfe'
         and int.from_bytes(header[4:8], 'little') == 0x100000c,
         'Expected a thin ARM64 macOS executable in the admitted ARM bottle')


class Ownership:
    """No PID adoption: a receipt can close only its current original attempt object."""
    def __init__(self):
        self.current = None

    def begin(self):
        need(self.current is None or self.current['closed'], 'An unresolved original owner is still held')
        token = object()
        self.current = {'token': token, 'owner': None, 'closed': False}
        return token

    def retain(self, token, original):
        need(self.current is not None and self.current['token'] is token and original is not None
             and self.current['owner'] is None, 'Only the current original object can be retained')
        self.current['owner'] = original

    def confirm(self, token, original, receipt):
        need(self.current is not None and self.current['token'] is token
             and self.current['owner'] is original and original is not None, 'Foreign or previous owner')
        need(receipt.get('wait') == receipt.get('poll') and type(receipt.get('wait')) is int
             and receipt.get('stdoutEOF') is True and receipt.get('stderrEOF') is True
             and receipt.get('stdoutClosed') is True and receipt.get('stderrClosed') is True
             and receipt.get('signals') == receipt.get('retries') == 0, 'Original lifetime is not confirmed')
        self.current['closed'] = True
