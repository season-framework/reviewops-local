"""Inert supply admission tests: no subprocess, network, binary or application execution."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/diagnostics'))
from installed_linux_supply_guards import (
    BASE, BRANCH, FORMULA_COMMIT, IMAGE_SHA, Ownership, QEMU_BOTTLE, REPOSITORY,
    admit_request, archive_name, arm64_macho, bottle, checksum_row, elf_x86_64, initial_url, qcow_base,
)


class SupplyAdmission(unittest.TestCase):
    def setUp(self):
        self.request = json.loads((ROOT / 'scripts/diagnostics/installed-linux-permission-supply-request.json').read_text())
        self.request['harnessSource'] = '1' * 40
        self.env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': BRANCH,
                    'GITHUB_SHA': '1' * 40, 'GITHUB_REPOSITORY': REPOSITORY,
                    'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_ACTOR_ID': '351100875',
                    'GITHUB_WORKFLOW_REF': REPOSITORY + '/.github/workflows/installed-linux-permission-ui.yml@' + BRANCH}

    def admit(self, request=None, env=None, approved=True):
        request = request or self.request
        raw = json.dumps(request).encode()
        authority = {'approved': approved, 'scope': 'issue34-acquire-prepare-only',
                     'requestSHA256': hashlib.sha256(raw).hexdigest()}
        return admit_request(request, authority, raw, env or self.env)

    def test_exact_prepare_request_is_admitted_without_runtime_identity(self):
        self.assertEqual(self.admit(), '1' * 40)
        self.assertIsNone(self.request['vendor']['elfSHA256'])

    def test_false_authority_wrong_bytes_and_ui_phase_are_refused(self):
        with self.assertRaises(ValueError):
            self.admit(approved=False)
        raw = json.dumps(self.request).encode()
        with self.assertRaises(ValueError):
            admit_request(self.request, {'approved': True, 'scope': 'issue34-acquire-prepare-only',
                          'requestSHA256': '0' * 64}, raw, self.env)
        changed = copy.deepcopy(self.request)
        changed['phase'] = 'ui'
        with self.assertRaises(ValueError):
            self.admit(changed)

    def test_unbound_source_other_actor_rerun_and_wrong_branch_are_refused(self):
        changed = copy.deepcopy(self.request)
        changed['harnessSource'] = None
        with self.assertRaises(ValueError):
            self.admit(changed)
        for key, value in [('GITHUB_ACTOR_ID', '1'), ('GITHUB_RUN_ATTEMPT', '2'),
                           ('GITHUB_REF', 'refs/heads/main'), ('GITHUB_EVENT_NAME', 'push')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.admit(env={**self.env, key: value})

    def test_old_product_cross_architecture_and_floating_vendor_are_refused(self):
        for path, value in [(('source',), '7c86173a49a046e6f2c127863e377ec8563ff808'),
                            (('app', 'target'), 'darwin-x64'), (('qemu', 'bottleTag'), 'sequoia'),
                            (('qemu', 'dependencyBottleTags'), ['x86_64_linux']),
                            (('vendor', 'tag'), 'latest'), (('vendor', 'sha256'), None)]:
            changed = copy.deepcopy(self.request)
            destination = changed
            for key in path[:-1]:
                destination = destination[key]
            destination[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.admit(changed)

    def test_formula_bottle_has_no_source_or_architecture_fallback(self):
        formula = {'name': 'qemu', 'versions': {'stable': '11.1.3'}, 'revision': 0,
                   'bottle': {'stable': {'files': {'arm64_sequoia': {
                       'sha256': QEMU_BOTTLE,
                       'url': 'https://ghcr.io/v2/homebrew/core/qemu/blobs/sha256:' + QEMU_BOTTLE}}}}}
        self.assertEqual(bottle(formula, 'arm64_sequoia', '11.1.3', QEMU_BOTTLE)['tag'], 'arm64_sequoia')
        with self.assertRaises(ValueError):
            bottle(formula, 'sequoia')
        with self.assertRaises(ValueError):
            bottle(formula, 'arm64_sequoia', '11.1.2')
        formula['bottle']['stable']['files']['arm64_sequoia']['url'] += '?token=untrusted'
        with self.assertRaises(ValueError):
            bottle(formula, 'arm64_sequoia')

    def test_signed_checksum_requires_one_exact_image_row(self):
        text = IMAGE_SHA + ' *ubuntu-24.04-server-cloudimg-amd64.img\n'
        self.assertEqual(checksum_row(text, 'ubuntu-24.04-server-cloudimg-amd64.img'), IMAGE_SHA)
        for value in [text + text, text.replace('amd64.img', 'arm64.img'), 'broken\n']:
            with self.assertRaises(ValueError):
                checksum_row(value, 'ubuntu-24.04-server-cloudimg-amd64.img')

    def test_archive_paths_cannot_escape_or_hide_control_characters(self):
        self.assertEqual(str(archive_name('qemu/11.1.3/share/qemu/bios.bin')), 'qemu/11.1.3/share/qemu/bios.bin')
        for name in ['/tmp/x', '../x', 'qemu/../../x', 'qemu//x', 'qemu/./x', 'qemu\\x', 'qemu/\nx']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                archive_name(name)

    def test_public_initial_urls_exclude_credentials_queries_and_wrong_hosts(self):
        initial_url('https://formulae.brew.sh/api/formula/qemu.json', {'formulae.brew.sh'})
        for url in ['http://formulae.brew.sh/x', 'https://user:secret@formulae.brew.sh/x',
                    'https://formulae.brew.sh/x?token=x', 'https://example.org/x']:
            with self.assertRaises(ValueError):
                initial_url(url, {'formulae.brew.sh'})

    def test_real_header_architectures_are_distinct_from_guest_target_names(self):
        macho = b'\xcf\xfa\xed\xfe' + (0x100000c).to_bytes(4, 'little')
        arm64_macho(macho)
        with self.assertRaises(ValueError):
            arm64_macho(macho[:4] + (0x1000007).to_bytes(4, 'little'))
        elf = bytearray(64)
        elf[:6], elf[18:20] = b'\x7fELF\x02\x01', (62).to_bytes(2, 'little')
        elf_x86_64(elf)
        elf[18:20] = (183).to_bytes(2, 'little')
        with self.assertRaises(ValueError):
            elf_x86_64(elf)

    def test_qcow_external_backing_data_and_encryption_are_refused(self):
        header = bytearray(104)
        header[:4], header[4:8], header[24:32] = b'QFI\xfb', (3).to_bytes(4, 'big'), (4 * 1024**3).to_bytes(8, 'big')
        qcow_base(header)
        for offset, data in [(8, (1).to_bytes(8, 'big')), (32, (1).to_bytes(4, 'big')),
                             (72, (4).to_bytes(8, 'big'))]:
            changed = bytearray(header)
            changed[offset:offset + len(data)] = data
            with self.assertRaises(ValueError):
                qcow_base(changed)


class OriginalOwnership(unittest.TestCase):
    def receipt(self, code=0):
        return {'wait': code, 'poll': code, 'stdoutEOF': True, 'stderrEOF': True,
                'stdoutClosed': True, 'stderrClosed': True, 'signals': 0, 'retries': 0}

    def test_previous_owner_cannot_reconcile_a_new_prehandle_failure(self):
        lifetime = Ownership()
        first, owner = lifetime.begin(), object()
        lifetime.retain(first, owner)
        lifetime.confirm(first, owner, self.receipt())
        second = lifetime.begin()
        with self.assertRaises(ValueError):
            lifetime.confirm(second, owner, self.receipt())
        with self.assertRaises(ValueError):
            lifetime.begin()

    def test_closed_without_eof_signals_retry_and_pid_substitution_are_refused(self):
        for key, value in [('stdoutEOF', False), ('stderrEOF', False), ('stdoutClosed', False),
                           ('signals', 1), ('retries', 1), ('poll', None)]:
            lifetime, owner = Ownership(), object()
            token = lifetime.begin()
            lifetime.retain(token, owner)
            with self.subTest(key=key), self.assertRaises(ValueError):
                lifetime.confirm(token, owner, {**self.receipt(), key: value})
        with self.assertRaises(ValueError):
            lifetime.confirm(token, object(), self.receipt())

    def test_original_nonzero_exit_can_close_but_is_not_converted_to_success(self):
        lifetime, owner = Ownership(), object()
        token = lifetime.begin()
        lifetime.retain(token, owner)
        receipt = self.receipt(17)
        lifetime.confirm(token, owner, receipt)
        self.assertTrue(lifetime.current['closed'])
        self.assertEqual(receipt['wait'], 17)


if __name__ == '__main__':
    unittest.main(verbosity=2)
