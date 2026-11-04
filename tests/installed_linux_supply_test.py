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
    BASE, BRANCH, FORMULA_COMMIT, IMAGE_SHA, FailureStage, Ownership, QEMU_BOTTLE, REPOSITORY,
    SupplyGuardFailure,
    admit_request, archive_name, arm64_macho, bottle, checksum_row, elf_x86_64, initial_url, qcow_base,
    oci_manifest, oci_request, oci_row, oci_runtime_set,
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


class OCIMetadata(unittest.TestCase):
    def setUp(self):
        self.qemu = json.loads((ROOT / 'scripts/diagnostics/installed-linux-permission-supply-request.json').read_text())['qemu']
        self.rows = copy.deepcopy(self.qemu['ociBottles'])

    def tabs(self):
        declarations = [{'full_name': row['name'], 'version': row['version'], 'revision': row['revision'],
                         'bottle_rebuild': row['bottleRebuild'], 'pkg_version': row['pkgVersion'],
                         'declared_directly': False} for row in self.rows[1:]]
        return [{'runtime_dependencies': declarations}] + [{'runtime_dependencies': []} for _ in self.rows[1:]]

    def manifest(self, name='gnutls'):
        row = copy.deepcopy(next(row for row in self.rows if row['name'] == name))
        tab = {'homebrew_version': '7.0.11-24-g2833c25', 'runtime_dependencies': []}
        if row['tag'] != 'all':
            tab.update({'arch': 'arm64', 'built_on': {'os': 'Macintosh', 'os_version': 'macOS 15.8'}})
        tab_text = json.dumps(tab, separators=(',', ':'))
        ref = row['pkgVersion'] + '.' + row['tag'] + ('.' + str(row['bottleRebuild']) if row['bottleRebuild'] else '')
        manifest = {'schemaVersion': 2,
                    'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                               'digest': 'sha256:' + '1' * 64, 'size': 100},
                    'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip',
                                'digest': 'sha256:' + row['bottleSHA256'], 'size': row['bottleBytes']}],
                    'annotations': {'com.github.package.type': 'homebrew_bottle',
                                    'org.opencontainers.image.vendor': 'homebrew',
                                    'org.opencontainers.image.version': row['pkgVersion'],
                                    'org.opencontainers.image.title': row['name'] + ' ' + ref,
                                    'org.opencontainers.image.ref.name': ref,
                                    'sh.brew.bottle.digest': row['bottleSHA256'],
                                    'sh.brew.bottle.size': str(row['bottleBytes']), 'sh.brew.tab': tab_text}}
        row['tabSHA256'] = hashlib.sha256(tab_text.encode()).hexdigest()
        return row, manifest

    def reseal(self, row, manifest):
        raw = json.dumps(manifest, separators=(',', ':')).encode()
        row = {**row, 'manifestBytes': len(raw), 'manifestSHA256': hashlib.sha256(raw).hexdigest()}
        return raw, row

    def test_reviewed_request_seals_thirty_children_without_a_formula_api_dependency_field(self):
        self.assertEqual(oci_request(self.qemu), self.rows)
        self.assertNotIn('runtime_dependencies', self.qemu)
        self.assertEqual(sum(row['tag'] == 'all' for row in self.rows), 1)
        self.assertEqual(sum(row['bottleBytes'] for row in self.rows[1:]), 54073186)
        changed = copy.deepcopy(self.qemu)
        changed['ociBottles'][0]['manifestSHA256'] = '0' * 64
        with self.assertRaisesRegex(SupplyGuardFailure, 'oci-root-selection'):
            oci_request(changed)

    def test_manifest_raw_bytes_and_size_are_verified_before_parsing(self):
        row, manifest = self.manifest()
        raw, row = self.reseal(row, manifest)
        oci_manifest(raw, row)
        for changed in [raw + b' ', raw.replace(b'gnutls', b'Gnutls')]:
            with self.assertRaisesRegex(SupplyGuardFailure, 'oci-manifest-seal'):
                oci_manifest(changed, row)

    def test_manifest_reference_and_package_revision_cannot_drift_even_if_resealed(self):
        row, manifest = self.manifest()
        for field, value in [('org.opencontainers.image.ref.name', '3.8.13_2.arm64_sequoia'),
                             ('org.opencontainers.image.version', '3.8.13'),
                             ('org.opencontainers.image.vendor', 'other'),
                             ('org.opencontainers.image.title', 'other 3.8.13_2.arm64_sequoia.1')]:
            changed = copy.deepcopy(manifest)
            changed['annotations'][field] = value
            raw, seal = self.reseal(row, changed)
            with self.subTest(field=field), self.assertRaisesRegex(SupplyGuardFailure, 'oci-reference'):
                oci_manifest(raw, seal)
        manifest['annotations']['org.opencontainers.image.vendor'] = 'Homebrew'
        raw, seal = self.reseal(row, manifest)
        oci_manifest(raw, seal)

    def test_single_layer_digest_size_and_annotation_must_join_the_reviewed_bottle(self):
        row, manifest = self.manifest()
        for change in ['extra-layer', 'wrong-digest', 'wrong-size', 'annotation']:
            changed = copy.deepcopy(manifest)
            if change == 'extra-layer':
                changed['layers'].append(copy.deepcopy(changed['layers'][0]))
            elif change == 'wrong-digest':
                changed['layers'][0]['digest'] = 'sha256:' + '0' * 64
            elif change == 'wrong-size':
                changed['layers'][0]['size'] += 1
            else:
                changed['annotations']['sh.brew.bottle.digest'] = '0' * 64
            raw, seal = self.reseal(row, changed)
            with self.subTest(change=change), self.assertRaisesRegex(SupplyGuardFailure, 'oci-layer-seal'):
                oci_manifest(raw, seal)

    def test_duplicate_json_keys_and_changed_literal_tab_are_rejected(self):
        row, manifest = self.manifest()
        raw, row = self.reseal(row, manifest)
        duplicate = raw.replace(b'{"schemaVersion":2,', b'{"schemaVersion":2,"schemaVersion":2,', 1)
        seal = {**row, 'manifestBytes': len(duplicate), 'manifestSHA256': hashlib.sha256(duplicate).hexdigest()}
        with self.assertRaisesRegex(SupplyGuardFailure, 'oci-json'):
            oci_manifest(duplicate, seal)
        manifest['annotations']['sh.brew.tab'] += ' '
        changed, seal = self.reseal(row, manifest)
        with self.assertRaisesRegex(SupplyGuardFailure, 'oci-tab-seal'):
            oci_manifest(changed, seal)

    def test_only_the_exact_neutral_certificate_data_bottle_can_use_all(self):
        row, manifest = self.manifest('ca-certificates')
        raw, row = self.reseal(row, manifest)
        tab, _ = oci_manifest(raw, row)
        self.assertNotIn('arch', tab)
        for change in [{'name': 'libpng'}, {'version': '2026-10-21', 'pkgVersion': '2026-10-21'},
                       {'revision': 1, 'pkgVersion': '2026-10-20_1'}]:
            with self.assertRaisesRegex(SupplyGuardFailure, 'oci-neutral-tag'):
                oci_row({**row, **change})
        tab['arch'] = 'arm64'
        manifest['annotations']['sh.brew.tab'] = json.dumps(tab)
        row['tabSHA256'] = hashlib.sha256(manifest['annotations']['sh.brew.tab'].encode()).hexdigest()
        raw, row = self.reseal(row, manifest)
        with self.assertRaisesRegex(SupplyGuardFailure, 'oci-neutral-tag'):
            oci_manifest(raw, row)

    def test_root_declared_version_revision_rebuild_and_complete_name_set_are_required(self):
        self.assertEqual(len(oci_runtime_set(self.rows, self.tabs())['selectedRuntimeDeclarations']), 29)
        for key, value in [('version', '0.1'), ('revision', 1), ('bottle_rebuild', 99), ('pkg_version', 'wrong')]:
            tabs = self.tabs()
            tabs[0]['runtime_dependencies'][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(SupplyGuardFailure, 'oci-root-selection'):
                oci_runtime_set(self.rows, tabs)
        tabs = self.tabs()
        tabs[0]['runtime_dependencies'][1] = copy.deepcopy(tabs[0]['runtime_dependencies'][0])
        with self.assertRaises(SupplyGuardFailure):
            oci_runtime_set(self.rows, tabs)

    def test_nested_historical_versions_and_omitted_rebuild_are_preserved_literally(self):
        tabs = self.tabs()
        index = next(i for i, row in enumerate(self.rows) if row['name'] == 'libidn2')
        historical = {'full_name': 'libunistring', 'version': '1.3', 'revision': 0,
                      'pkg_version': '1.3', 'declared_directly': True}
        tabs[index]['runtime_dependencies'] = [historical]
        original = copy.deepcopy(tabs)
        result = oci_runtime_set(self.rows, tabs)
        self.assertEqual(tabs, original)
        history = next(row for row in result['nestedBuildHistories'] if row['bottle'] == 'libidn2')
        self.assertEqual(history['literalRuntimeDependencies'], [historical])
        self.assertNotIn('bottle_rebuild', history['literalRuntimeDependencies'][0])
        self.assertEqual(result['nestedOmittedFields'], [{'bottle': 'libidn2', 'dependency': 'libunistring',
                                                         'omittedFields': ['bottle_rebuild']}])
        self.assertEqual(result['nestedBuildDifferences'][0]['literalDependency'], historical)

    def test_missing_duplicate_or_unrecorded_nested_dependencies_are_not_dropped(self):
        nested = {'full_name': 'not-supplied', 'version': '1', 'revision': 0, 'pkg_version': '1'}
        for value in [[nested], None, [self.tabs()[0]['runtime_dependencies'][0]] * 2]:
            tabs = self.tabs()
            tabs[1]['runtime_dependencies'] = value
            with self.assertRaises(SupplyGuardFailure):
                oci_runtime_set(self.rows, tabs)

    def test_integer_fields_and_arm_host_metadata_cannot_masquerade_as_valid_inputs(self):
        row, manifest = self.manifest()
        with self.assertRaises(SupplyGuardFailure):
            oci_row({**row, 'revision': True})
        tab = json.loads(manifest['annotations']['sh.brew.tab'])
        tab['arch'] = 'x86_64'
        manifest['annotations']['sh.brew.tab'] = json.dumps(tab)
        row['tabSHA256'] = hashlib.sha256(manifest['annotations']['sh.brew.tab'].encode()).hexdigest()
        raw, row = self.reseal(row, manifest)
        with self.assertRaisesRegex(SupplyGuardFailure, 'oci-host-arch'):
            oci_manifest(raw, row)

    def test_named_stages_publish_only_source_controlled_reasons_not_signed_urls(self):
        stage = FailureStage()
        stage.enter('qemu-manifests')
        secret = 'https://example.org/blob?signature=DO-NOT-RETAIN'
        for error in [ValueError(secret), RuntimeError(secret), SupplyGuardFailure(secret)]:
            observation = stage.failure(error)
            self.assertEqual(observation['stage'], 'qemu-manifests')
            self.assertNotIn(secret, json.dumps(observation))
        self.assertEqual(stage.failure(SupplyGuardFailure('oci-tab-seal'))['guardReason'], 'oci-tab-seal')
        with self.assertRaisesRegex(SupplyGuardFailure, 'supply-stage'):
            stage.enter(secret)
        self.assertEqual(stage.name, 'qemu-manifests')


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
