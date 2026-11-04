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


def need(value, message):
    if not value:
        raise ValueError(message)


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
    tags = qemu.get('dependencyBottleTags')
    need(isinstance(tags, list) and tags and len(tags) == len(set(tags))
         and all(tag in {'arm64_sequoia', 'arm64_sonoma', 'arm64_ventura'} for tag in tags),
         'Dependency tags must be explicitly admitted ARM bottles compatible with macOS 15')
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
