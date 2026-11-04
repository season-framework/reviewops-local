"""Inert bytes, paths, authority and original-object tests; no runtime tools."""
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import struct
import runpy
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('private_qemu_runtime_guards',
    ROOT / 'scripts/diagnostics/private_qemu_runtime_guards.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
PREFIX = '/tmp/r34abcd'


def command(path, kind=0xc):
    offset = 12 if kind == g.RPATH else 24
    size = (offset + len(path.encode()) + 1 + 7) // 8 * 8
    raw = struct.pack('<III', kind, size, offset)
    raw += b'\0' * (offset - len(raw)) + path.encode() + b'\0'
    return raw.ljust(size, b'\0')


def image(paths=None, strings=None, cpu=0x100000c):
    commands = b''.join(command(path, kind) for kind, path in (paths or []))
    count = len(paths or [])
    suffix = b''
    if strings is not None:
        suffix = b'\0'.join(value.encode() for value in strings) + b'\0'
        offset = 32 + len(commands) + 152
        segment = struct.pack('<II16sQQQQiiII', 0x19, 152, b'__TEXT', 0, offset + len(suffix),
                              0, offset + len(suffix), 5, 5, 1, 0)
        section = struct.pack('<16s16sQQIIIIIIII', b'__cstring', b'__TEXT', offset,
                              len(suffix), offset, 0, 0, 0, 2, 0, 0, 0)
        commands += segment + section
        count += 1
    return struct.pack('<8I', 0xfeedfacf, cpu, 0, 2, count, len(commands), 0, 0) + commands + suffix


class AuthorityAndPaths(unittest.TestCase):
    def authority(self):
        binding = {'schema': 1, 'phase': g.PHASE, 'productSource': g.PRODUCT,
                   'sourceBaseline': g.BASE,
                   'harnessSource': '1' * 40, 'logicalPrefix': PREFIX,
                   'artifactZIPPin': {'bytes': g.ZIP_BYTES, 'sha256': g.ZIP_SHA}}
        raw = json.dumps(binding).encode()
        authority = {'approved': True, 'scope': g.PHASE, 'bindingSHA256': g.sha(raw)}
        whole = {'accepted': True, 'wholeSupplyAccepted': True, 'productSource': g.PRODUCT,
                 'bottleArchivesVerified': 30, 'preparedReportPreservedVerbatim': True,
                 'supplyZIPPin': {'bytes': g.ZIP_BYTES, 'sha256': g.ZIP_SHA}}
        return binding, raw, authority, whole

    def test_false_authority_and_retention_only_r2_never_admit_effects(self):
        b, raw, a, whole = self.authority()
        self.assertEqual(g.admit(b, a, raw, whole, 'darwin', 'arm64'), '1' * 40)
        for changed in [{'approved': False}, {'scope': 'vm-boot'}, {'bindingSHA256': '0' * 64}]:
            with self.assertRaises(ValueError):
                g.admit(b, {**a, **changed}, raw, whole, 'darwin', 'arm64')
        for changed in [{'wholeSupplyAccepted': False}, {'accepted': False},
                        {'bottleArchivesVerified': 29}]:
            with self.assertRaises(ValueError):
                g.admit(b, a, raw, {**whole, **changed}, 'darwin', 'arm64')

    def test_arm_and_reviewed_source_are_required_without_architecture_fallback(self):
        b, raw, a, whole = self.authority()
        for platform, machine in [('darwin', 'x86_64'), ('linux', 'aarch64')]:
            with self.assertRaises(ValueError):
                g.admit(b, a, raw, whole, platform, machine)
        with self.assertRaises(ValueError):
            g.admit({**b, 'harnessSource': None}, a, raw, whole, 'darwin', 'arm64')
        with self.assertRaises(ValueError):
            g.admit({**b, 'sourceBaseline': '9' * 40}, a, raw, whole, 'darwin', 'arm64')

    def test_exact_four_path_integration_can_bind_the_reviewed_post_supply_baseline(self):
        b, raw, a, whole = self.authority()
        b['sourceBaseline'] = '34bf2ed064a93c709a2f6d00caa70ca444abca55'
        raw = json.dumps(b).encode()
        a['bindingSHA256'] = g.sha(raw)
        self.assertEqual(g.admit(b, a, raw, whole, 'darwin', 'arm64'), '1' * 40)

    def test_blueprint_must_match_the_actual_accepted_r3_report_not_a_partial_report(self):
        rows = [{'name': 'x' + str(i), 'pkgVersion': '1', 'archiveBytes': 100,
                 'archiveSHA256': 'a' * 64, 'inventoryBytes': 200, 'inventorySHA256': 'b' * 64}
                for i in range(30)]
        report = {'ok': True, 'status': 'prepared-supply-only', 'source': g.PRODUCT,
                  'qemu': {'bottles': [{'name': row['name'], 'pkgVersion': row['pkgVersion'],
                                      'archivePin': {'bytes': row['archiveBytes'], 'sha256': row['archiveSHA256']},
                                      'inventoryPin': {'bytes': row['inventoryBytes'], 'sha256': row['inventorySHA256']}}
                                     for row in rows]}}
        g.subset_provenance(report, rows)
        with self.assertRaises(ValueError):
            g.subset_provenance({**report, 'ok': False, 'status': 'preparation-failed'}, rows)
        for field in ['archiveSHA256', 'inventorySHA256', 'pkgVersion']:
            changed = [dict(row) for row in rows]
            changed[0][field] = 'wrong'
            with self.assertRaises(ValueError):
                g.subset_provenance(report, changed)

    def test_short_prefix_and_archive_names_cannot_escape(self):
        self.assertEqual(g.prefix(PREFIX), PREFIX)
        for value in ['/tmp/r34abcde', '/opt/homebrew', '/tmp/../x', '/tmp/r34abcd/x']:
            with self.assertRaises(ValueError):
                g.prefix(value)
        for value in ['../x', '/tmp/x', 'qemu//x', 'qemu/./x', 'qemu\\x', 'qemu/\nx', '.']:
            with self.assertRaises(ValueError):
                g.closed_path(value)

    def test_symlinks_stay_in_their_exact_keg_and_cycles_do_not_resolve(self):
        self.assertEqual(g.safe_link('qemu/11.1.3/lib/a', '../share/b'), 'qemu/11.1.3/share/b')
        for target in ['/opt/homebrew/lib/a', '../../../outside', '../bad\nname']:
            with self.assertRaises(ValueError):
                g.safe_link('qemu/11.1.3/lib/a', target)
        links = {'opt/x': 'Cellar/x/1', 'Cellar/x/1/lib/a': 'Cellar/x/1/lib/b'}
        regular = {'Cellar/x/1/lib/b'}
        self.assertEqual(g.resolve_local('opt/x/lib/a', links, regular), 'Cellar/x/1/lib/b')
        with self.assertRaises(ValueError):
            g.resolve_local('opt/x/lib/a', {**links, 'Cellar/x/1/lib/b': 'Cellar/x/1/lib/a'}, regular)
        with self.assertRaises(ValueError):
            g.resolve_local('opt/x/lib/missing', links, regular)


class MachOBytes(unittest.TestCase):
    def test_shared_cstring_suffix_offsets_and_bytes_are_preserved(self):
        strings = ['/opt/homebrew/Cellar/qemu/11.1.3/share/qemu',
                   '@@HOMEBREW_PREFIX@@/opt/x/lib/a.dylib', '@@HOMEBREW_CELLAR@@/x/1/lib/a.dylib']
        original = image(strings=strings)
        derived, records = g.patch_macho(original, PREFIX)
        for value, token in zip(strings, [b'/opt/homebrew', b'@@HOMEBREW_PREFIX@@', b'@@HOMEBREW_CELLAR@@']):
            start = original.index(value.encode())
            suffix = start + len(token)
            end = start + len(value.encode()) + 1
            self.assertEqual(derived[suffix:end], original[suffix:end])
            relocated = derived[start:end - 1].decode()
            expected = PREFIX + ('/Cellar' if token == b'@@HOMEBREW_CELLAR@@' else '') + value[len(token):]
            self.assertEqual(g.posixpath.normpath(relocated), expected)
        self.assertTrue(all(row['role'] == 'cstring-prefix' for row in records))

    def test_patch_changes_only_bounded_strings_and_keeps_file_geometry(self):
        original = image([(0xc, '@@HOMEBREW_PREFIX@@/opt/x/lib/a.dylib')],
                         ['/opt/homebrew/Cellar/qemu/11.1.3/share/qemu',
                          '@@HOMEBREW_CELLAR@@/x/1/share', 'unchanged text'])
        derived, records = g.patch_macho(original, PREFIX)
        self.assertEqual(len(derived), len(original))
        self.assertEqual(derived[:32], original[:32])
        self.assertIn((PREFIX + '/Cellar/x/1/share').encode(), derived)
        self.assertIn(b'unchanged text', derived)
        self.assertEqual(len(records), 3)
        for index, (old, new) in enumerate(zip(original, derived)):
            if old != new:
                self.assertTrue(any(row['offset'] <= index < row['offset'] + row['bytes'] for row in records))
        self.assertEqual(g.macho(derived)['commands'][0]['path'], PREFIX + '/opt/x/lib/a.dylib')

    def test_header_architecture_truncation_and_command_overflow_are_refused(self):
        raw = image([(0xc, '/usr/lib/libSystem.B.dylib')])
        bad = [raw[:31], image(cpu=0x1000007), b'\xca\xfe\xba\xbe' + raw[4:]]
        changed = bytearray(raw)
        struct.pack_into('<I', changed, 36, 0xfffffff8)
        bad.append(bytes(changed))
        for value in bad:
            with self.assertRaises(ValueError):
                g.macho(value)

    def test_unterminated_or_header_pointing_load_paths_cannot_be_patched(self):
        raw = image([(0xc, '@@HOMEBREW_PREFIX@@/x')])
        changed = bytearray(raw)
        struct.pack_into('<I', changed, 40, 4)
        with self.assertRaises(ValueError):
            g.macho(bytes(changed))
        changed = bytearray(raw)
        changed[56:] = b'X' * (len(changed) - 56)
        with self.assertRaises(ValueError):
            g.macho(bytes(changed))

    def test_only_real_text_cstring_sections_and_known_dynamic_linker_are_admitted(self):
        raw = image(strings=['/opt/homebrew/share/qemu'])
        changed = bytearray(raw)
        struct.pack_into('<I', changed, 32 + 72 + 64, 0)
        with self.assertRaises(ValueError):
            g.patch_macho(bytes(changed), PREFIX)
        with self.assertRaises(ValueError):
            g.macho(image([(0xe, '/tmp/foreign-dyld')]))
        g.macho(image([(0xe, '/usr/lib/dyld')]))
        with self.assertRaises(ValueError):
            g.macho(image([(0x27, 'DYLD_LIBRARY_PATH=/host')]))


class LoaderClosure(unittest.TestCase):
    def setUp(self):
        self.loader = 'Cellar/qemu/11.1.3/bin/qemu-system-x86_64'
        self.lib = 'Cellar/x/1/lib/a.dylib'
        self.regular = {self.loader, self.lib, 'Cellar/y/2/lib/a.dylib'}
        self.directories = {'Cellar/x/1/lib', 'Cellar/y/2/lib', 'Cellar/qemu/11.1.3/bin'}
        self.links = {'opt/x': 'Cellar/x/1'}

    def resolve(self, value, rpaths=()):
        return g.dependency_path(value, self.loader, self.loader, rpaths, PREFIX,
                                 self.links, self.regular, self.directories)

    def test_non_system_loads_resolve_only_to_regular_supplied_files(self):
        self.assertEqual(self.resolve(PREFIX + '/opt/x/lib/a.dylib'), self.lib)
        self.assertIsNone(self.resolve('/usr/lib/libSystem.B.dylib'))
        for value in ['/opt/homebrew/opt/x/lib/a.dylib', '/Library/Frameworks/Foreign',
                      PREFIX + '/../foreign', PREFIX + '/opt/x/lib/missing']:
            with self.assertRaises(ValueError):
                self.resolve(value)

    def test_rpath_ambiguity_and_host_rpath_are_refused(self):
        paths = [PREFIX + '/Cellar/x/1/lib']
        self.assertEqual(self.resolve('@rpath/a.dylib', paths), self.lib)
        with self.assertRaises(ValueError):
            self.resolve('@rpath/a.dylib', paths + [PREFIX + '/Cellar/y/2/lib'])
        with self.assertRaises(ValueError):
            g.rpath_context(['/opt/homebrew/lib'], self.loader, self.loader, PREFIX,
                            self.links, self.regular, self.directories)

    def test_loader_and_executable_paths_have_distinct_owners(self):
        self.assertEqual(g.dependency_path('@loader_path/a.dylib', self.lib, self.loader, (), PREFIX,
                                          self.links, self.regular, self.directories), self.lib)
        with self.assertRaises(ValueError):
            self.resolve('@executable_path/a.dylib')
        self.assertEqual(g.rpath_context(['@loader_path'], self.lib, self.loader, PREFIX,
                                        self.links, self.regular, self.directories),
                         [PREFIX + '/Cellar/x/1/lib'])

    def test_version_machine_and_accelerator_observations_are_not_vm_runs(self):
        for label, text in [('system-version', 'QEMU emulator version 11.1.3\n'),
                            ('image-version', 'qemu-img version 11.1.3\n'),
                            ('machines', 'Supported machines are:\npc Standard PC\n'),
                            ('accelerators', 'Accelerators supported:\nhvf\ntcg\n')]:
            g.probe_result(label, text)
        for label, text in [('system-version', 'QEMU emulator version 11.1.30'),
                            ('machines', 'q35 only'), ('accelerators', 'hvf'), ('boot', 'anything')]:
            with self.assertRaises(ValueError):
                g.probe_result(label, text)


class OriginalObjects(unittest.TestCase):
    def test_no_pid_adoption_or_reuse_of_a_previous_closed_attempt(self):
        owner = g.Ownership()
        token, first = owner.begin(), object()
        owner.retain(token, first)
        receipt = {'wait': 0, 'poll': 0, 'stdoutEOF': True, 'stderrEOF': True,
                   'stdoutClosed': True, 'stderrClosed': True, 'signals': 0, 'retries': 0}
        owner.confirm(token, first, receipt)
        next_token = owner.begin()
        with self.assertRaises(ValueError):
            owner.confirm(next_token, first, receipt)
        with self.assertRaises(ValueError):
            owner.begin()

    def test_close_without_eof_or_signal_retry_is_not_original_completion(self):
        for key, value in [('stdoutEOF', False), ('poll', None), ('signals', 1), ('retries', 1)]:
            owner, original = g.Ownership(), object()
            token = owner.begin()
            owner.retain(token, original)
            receipt = {'wait': 0, 'poll': 0, 'stdoutEOF': True, 'stderrEOF': True,
                       'stdoutClosed': True, 'stderrClosed': True, 'signals': 0, 'retries': 0, key: value}
            with self.assertRaises(ValueError):
                owner.confirm(token, original, receipt)


class IsolatedImport(unittest.TestCase):
    def test_isolated_entry_import_has_no_tool_archive_or_write_effect(self):
        entry = ROOT / 'scripts/diagnostics/private-qemu-runtime.py'
        blocked = AssertionError('Import smoke must not invoke a tool, archive or write')
        with mock.patch('subprocess.Popen', side_effect=blocked), \
             mock.patch('zipfile.ZipFile', side_effect=blocked), \
             mock.patch('pathlib.Path.mkdir', side_effect=blocked), \
             mock.patch('pathlib.Path.write_text', side_effect=blocked), \
             mock.patch('pathlib.Path.write_bytes', side_effect=blocked), \
             mock.patch('os.mkdir', side_effect=blocked), \
             mock.patch('os.symlink', side_effect=blocked), \
             mock.patch('os.chmod', side_effect=blocked):
            namespace = runpy.run_path(str(entry), run_name='private_qemu_entry_import_smoke')
        self.assertTrue(callable(namespace['main']))
        self.assertTrue(callable(namespace['OriginalTools']))


class ConditionalOrchestration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('capability_inert',
            ROOT / 'scripts/diagnostics/private-qemu-capability.py')
        cls.c = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.c)

    def parent(self):
        c, head = self.c, '1' * 40
        parent = {'schema': 1, 'approved': True, 'scope': c.SCOPE, 'recipe': c.RECIPE,
            'controlID': 'a' * 32, 'expectedRepository': c.REPOSITORY, 'expectedActorID': '351100875',
            'expectedRef': c.REF, 'expectedHarnessSource': head, 'expectedWorkflowSource': head,
            'expectedWorkflowRef': c.WORKFLOW_REF, 'expectedJob': 'capability', 'expectedRunNumber': 7,
            'sourceBaseline': c.BASE, 'sourcePins': {name: {'bytes': 1, 'sha256': '2' * 64} for name in c.PATHS},
            'wholeSupplySHA256': c.WHOLE_SHA, 'maximumAdapterCalls': 1, 'allowAdapterInvocation': True,
            'allowVM': False, 'allowSSH': False, 'allowApp': False, 'allowAPIWrites': False}
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_REPOSITORY': c.REPOSITORY, 'GITHUB_ACTOR_ID': '351100875', 'GITHUB_REF': c.REF,
            'GITHUB_SHA': head, 'GITHUB_WORKFLOW_SHA': head, 'GITHUB_WORKFLOW_REF': c.WORKFLOW_REF,
            'GITHUB_JOB': 'capability', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_RUN_NUMBER': '7',
            'GITHUB_RUN_ID': '100', 'GITHUB_TRIGGERING_ACTOR': 'recorded-only'}
        return parent, env

    def test_unbound_or_replayed_parent_fails_before_effects(self):
        c, (parent, env) = self.c, self.parent()
        self.assertEqual(c.admit(parent, env, 'darwin', 'arm64')['GITHUB_RUN_ID'], '100')
        for change in [{'approved': False}, {'expectedRunNumber': None}, {'expectedRunNumber': True},
                       {'expectedRunNumber': 8}, {'expectedHarnessSource': None}, {'allowVM': True},
                       {'maximumAdapterCalls': 2}, {'unexpected': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                c.admit({**parent, **change}, env, 'darwin', 'arm64')

    def test_workflow_source_ref_actor_and_attempt_must_match_exactly(self):
        parent, env = self.parent()
        for key, value in [('GITHUB_SHA', '3' * 40), ('GITHUB_WORKFLOW_SHA', '3' * 40),
                ('GITHUB_WORKFLOW_REF', 'other'), ('GITHUB_REF', 'refs/heads/main'),
                ('GITHUB_ACTOR_ID', '1'), ('GITHUB_RUN_ATTEMPT', '2'),
                ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_JOB', 'other')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.c.admit(parent, {**env, key: value}, 'darwin', 'arm64')
        with self.assertRaises(ValueError):
            self.c.admit(parent, env, 'darwin', 'x86_64')

    def test_source_scope_is_twelve_exact_paths_and_pins_are_closed(self):
        parent, env = self.parent()
        self.assertEqual(g.ADDITIONS, set(self.c.PATHS))
        self.assertEqual(len(self.c.PATHS), 12)
        self.assertIn('scripts/diagnostics/installed-linux-permission-ui-v2.mjs', self.c.PATHS)
        self.assertNotIn('scripts/diagnostics/installed-linux-permission-ui.mjs', self.c.PATHS)
        pins = dict(parent['sourcePins'])
        pins.pop(next(iter(pins)))
        with self.assertRaises(ValueError):
            self.c.admit({**parent, 'sourcePins': pins}, env, 'darwin', 'arm64')
        for p in [{'bytes': 1, 'sha256': '2' * 64, 'path': '/other'}, {'bytes': 0, 'sha256': '2' * 64}]:
            pins = {name: p for name in self.c.PATHS}
            with self.assertRaises(ValueError):
                self.c.admit({**parent, 'sourcePins': pins}, env, 'darwin', 'arm64')

    def test_blob_location_requires_the_single_observed_host_without_credentials(self):
        c = self.c
        good = 'https://' + c.BLOB_HOST + '/container/item?opaque=not-retained'
        self.assertEqual(c.blob_location(good), good)
        for bad in ['http://' + c.BLOB_HOST + '/x', good.replace(c.BLOB_HOST, 'other.blob.core.windows.net'),
                    'https://user@' + c.BLOB_HOST + '/x', good + '#fragment',
                    'https://' + c.BLOB_HOST + ':444/x', good + '\n',
                    'https://' + c.BLOB_HOST + '.evil/x', 'https://' + c.BLOB_HOST + '\\@evil/x']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                c.blob_location(bad)

    def test_auth_is_explicit_api_only_and_redirect_handler_never_follows(self):
        c = self.c
        self.assertEqual(c.headers('api', 'dedicated')['Authorization'], 'Bearer dedicated')
        self.assertFalse(any(key.lower() in ('authorization', 'cookie') for key in c.headers('blob')))
        with self.assertRaises(ValueError):
            c.headers('blob', 'dedicated')
        with self.assertRaises(ValueError):
            c.headers('api', 'bad\nheader')
        self.assertIsNone(c.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other/'))

    def test_stream_seal_requires_exact_bytes_digest_and_actual_eof(self):
        c, raw = self.c, b'owned bytes'
        sink, progress = io.BytesIO(), {}
        c.copy_exact(io.BytesIO(raw), sink, len(raw), c.digest(raw), float('inf'), progress)
        self.assertEqual(sink.getvalue(), raw)
        self.assertEqual(progress, {'bodyEOF': True, 'observedBytes': len(raw),
            'writtenBytes': len(raw), 'sha256': c.digest(raw)})
        for body, size, sha in [(raw[:-1], len(raw), c.digest(raw)), (raw, len(raw), '0' * 64),
                                (raw + b'x', len(raw), c.digest(raw))]:
            progress, sink = {}, io.BytesIO()
            with self.subTest(body=body), self.assertRaises(ValueError):
                c.copy_exact(io.BytesIO(body), sink, size, sha, float('inf'), progress)
            self.assertEqual(progress['writtenBytes'], len(sink.getvalue()))
            self.assertLessEqual(len(sink.getvalue()), size)

    def test_extra_blob_redirect_is_closed_without_retry_or_signed_url_record(self):
        c = self.c
        class Response(io.BytesIO):
            def __init__(self, status, headers):
                super().__init__(b'')
                self.status, self.headers = status, headers
        secret_location = 'https://' + c.BLOB_HOST + '/x?signature=never-store'
        first, second = Response(302, {'Location': secret_location}), Response(302, {'Location': 'https://other/'})
        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        receipts = []
        with mock.patch.object(c.urllib.request, 'build_opener', return_value=opener), \
             mock.patch.object(c.ssl, 'create_default_context', return_value=None), \
             mock.patch.object(c, 'write', side_effect=lambda path, value: receipts.append(value)), \
             mock.patch('pathlib.Path.open', side_effect=AssertionError('No body file on redirect')):
            with self.assertRaisesRegex(ValueError, '^artifact-acquisition-failed$'):
                c.acquire(Path('/unused.zip'), Path('/unused'), 'dedicated')
        self.assertEqual(opener.open.call_count, 2)
        self.assertTrue(first.closed and second.closed)
        self.assertEqual(receipts[0]['attempts'], {'api': 1, 'blob': 1})
        self.assertFalse(receipts[0]['ok'])
        self.assertNotIn('never-store', json.dumps(receipts))
        second_request = opener.open.call_args_list[1].args[0]
        self.assertFalse(any(key.lower() == 'authorization' for key in second_request.headers))

    def test_blueprint_uses_only_exact_ordered_report_rows_and_producer_members(self):
        c = self.c
        rows = [{'name': 'qemu' if i == 0 else 'dep' + str(i), 'pkgVersion': '1',
            'archivePin': {'path': '/origin/installed-linux-supply/bottle-' + str(i) + '.tar.gz',
                           'bytes': 100, 'sha256': 'a' * 64},
            'inventoryPin': {'path': '/origin/installed-linux-supply/bottle-' + str(i) + '.inventory.json',
                             'bytes': 200, 'sha256': 'b' * 64}} for i in range(30)]
        report = {'ok': True, 'status': 'prepared-supply-only', 'source': c.PRODUCT, 'qemu': {'bottles': rows}}
        blueprint = c.blueprint(report)
        self.assertEqual(blueprint['bottles'][29]['archiveMember'], 'installed-linux-supply/bottle-29.tar.gz')
        g.subset_provenance(report, blueprint['bottles'])
        with self.assertRaises(ValueError):
            c.blueprint({**report, 'ok': False})
        rows[0]['archivePin']['path'] = '/wrong/bottle-1.tar.gz'
        with self.assertRaises(ValueError):
            c.blueprint(report)

    def test_failure_footer_does_not_invent_an_existing_private_derivative(self):
        same = (1, 2, 3, 0o40700)
        self.assertFalse(g.retained_prefix(False, None, False))
        self.assertFalse(g.retained_prefix(True, same, False))
        self.assertTrue(g.retained_prefix(True, same, same))
        self.assertIsNone(g.retained_prefix(True, same, (1, 9, 3, 0o40700)))
        self.assertIsNone(g.retained_prefix(True, same, None))

    def test_isolated_wrapper_import_has_no_credentials_transport_tools_or_writes(self):
        blocked = AssertionError('Definitions-only wrapper import')
        with mock.patch('subprocess.Popen', side_effect=blocked), \
             mock.patch('urllib.request.OpenerDirector.open', side_effect=blocked), \
             mock.patch('zipfile.ZipFile', side_effect=blocked), \
             mock.patch('pathlib.Path.mkdir', side_effect=blocked), \
             mock.patch('pathlib.Path.write_text', side_effect=blocked), \
             mock.patch('pathlib.Path.write_bytes', side_effect=blocked), \
             mock.patch.dict('os.environ', {}, clear=True):
            namespace = runpy.run_path(str(ROOT / 'scripts/diagnostics/private-qemu-capability.py'),
                                      run_name='private_qemu_wrapper_import_smoke')
        self.assertTrue(callable(namespace['main']))


class CombinedCoordinator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('combined_inert', ROOT / 'scripts/diagnostics/installed-linux-permission-combined.py')
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def fixture(self):
        recipe = ConditionalOrchestration(); recipe.c = self.m.c
        parent, env = recipe.parent()
        m = self.m
        parent.update({'scope': m.SCOPE, 'recipe': m.RECIPE, 'allowVM': True, 'allowSSH': True, 'allowApp': True,
            'allowNodeDependencyAcquisition': True, 'nodeVersion': m.NODE_VERSION, 'nodeArchitecture': 'arm64',
            'nodeSetupActionSHA': m.SETUP_NODE, 'npmLockSHA256': 'a' * 64, 'npmRegistry': 'https://registry.npmjs.org',
            'allowConditionalRuntimeAcceptance': True, 'allowPrivateAppPreparation': True, 'allowOriginalVMAndGuest': True,
            'allowConditionalUIApproval': True, 'maximumVMLaunches': 1, 'maximumAppLaunches': 1,
            'maximumPowerdownRequests': 1, 'machineName': 'pc-i440fx-11.1', 'uiDriverSHA256': m.UI_SHA,
            'r41PublicProofSHA256': m.PUBLIC_SHA})
        env['CI'] = 'true'
        return parent, env

    def test_no_true_child_can_be_derived_from_false_or_incomplete_combined_parent(self):
        m = self.m; parent, env = self.fixture()
        child, identity = m.admit(parent, env, 'darwin', 'arm64')
        self.assertTrue(child['approved']); self.assertFalse(child['allowVM']); self.assertFalse(child['allowSSH']); self.assertFalse(child['allowApp'])
        self.assertEqual(len(child['sourcePins']), 12); self.assertEqual(identity['GITHUB_RUN_ID'], '100')
        self.assertTrue(parent['allowVM'])  # Original parent is not rewritten.
        for change in [{'approved': False}, {'expectedRunNumber': None}, {'expectedRunNumber': 8},
            {'allowConditionalRuntimeAcceptance': False}, {'allowConditionalUIApproval': False},
            {'allowNodeDependencyAcquisition': False}, {'nodeArchitecture': 'x64'}, {'machineName': 'pc'},
            {'npmRegistry': 'https://foreign.invalid'}, {'extra': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.admit({**parent, **change}, env, 'darwin', 'arm64')
        with self.assertRaises(ValueError): m.child_control({**parent, 'approved': False})

    def test_reviewed_ui_v2_hash_names_the_actual_new_entry_and_original_ui_is_not_an_addition(self):
        relative = 'scripts/diagnostics/installed-linux-permission-ui-v2.mjs'
        self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), self.m.UI_SHA)
        self.assertIn(relative, self.m.c.PATHS)
        original = ROOT / 'scripts/diagnostics/installed-linux-permission-ui.mjs'
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),
                         '2fbf69b3535296aa3d89699641fc4284dec21fc98d55f1fe84df321e1d8f55b2')
        self.assertNotIn(original.relative_to(ROOT).as_posix(), self.m.c.PATHS)

    def test_actual_owner_environment_is_exact_five_setup_plus_six_admitted_ci_fields(self):
        m = self.m; _, ci = self.fixture()
        ci.update({'GH_TOKEN': 'never-copy', 'GITHUB_TOKEN': 'never-copy', 'SSH_AUTH_SOCK': '/foreign', 'NODE_OPTIONS': '--require foreign'})
        env = m.minimal_env(Path('/private/tmp/home'), Path('/private/tmp/tmp'), ci)
        self.assertEqual(set(env), {'HOME', 'TMPDIR', 'PATH', 'LANG', 'TZ', *m.CI_KEYS})
        self.assertTrue(all(env[key] == ci[key] for key in m.CI_KEYS))
        self.assertNotIn('REVIEWOPS_ARTIFACT_TOKEN', env)
        npm = m.npm_environment(Path('/private/tmp/r34v-abcdefgh1234'), Path('/private/tmp/node/bin/node'))
        self.assertEqual(npm['NPM_CONFIG_REGISTRY'], 'https://registry.npmjs.org')
        self.assertEqual(npm['NPM_CONFIG_USERCONFIG'], '/private/tmp/r34v-abcdefgh1234/npm-userconfig')
        self.assertEqual(npm['NPM_CONFIG_GLOBALCONFIG'], '/private/tmp/r34v-abcdefgh1234/npm-globalconfig')
        self.assertEqual(npm['NPM_CONFIG_FETCH_RETRIES'], '0'); self.assertEqual(npm['NPM_CONFIG_IGNORE_SCRIPTS'], 'true')
        self.assertNotIn('GITHUB_TOKEN', npm); self.assertEqual(npm['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1')

    def test_real_local_pin_hash_and_json_helpers_handle_small_files_without_missing_exports(self):
        m = self.m
        with tempfile.TemporaryDirectory(prefix='r34-combined-inert-') as temporary:
            root = Path(temporary).resolve(); file = root / 'input.json'; file.write_bytes(b'{"owned":true}\n')
            pin = {'path': str(file), 'bytes': file.stat().st_size, 'sha256': m.sha_file(file)}
            self.assertEqual(m.checked_pin(pin, 65536), file); self.assertEqual(m.checked_json(pin), {'owned': True})
            with self.assertRaises(ValueError): m.checked_pin({**pin, 'sha256': '0' * 64}, 65536)
            with self.assertRaises(ValueError): m.checked_pin(pin, 1)
            empty = root / 'empty'; empty.write_bytes(b''); zero = {'path': str(empty), 'bytes': 0, 'sha256': m.c.digest(b'')}
            self.assertEqual(m.evidence_bytes(zero), b'')
            with self.assertRaises(ValueError): m.checked_pin(zero, 65536)

    def test_ui_base_produces_required_paths_and_exact_r41_build_without_source_fallback(self):
        m = self.m; root, private = Path('/private/tmp/repo'), Path('/private/tmp/r34v-abcdefgh1234')
        app = private / 'Applications/ReviewOps.app'; pin = lambda p: {'path': str(p), 'bytes': 1, 'sha256': 'a' * 64}
        ui = m.ui_base(root, private, app, pin(root / 'driver'), {'path': '/zip', 'bytes': m.APP_BYTES, 'sha256': m.APP_SHA},
            {'asar': pin(app / m.ASAR['path']), 'executable': pin(app / m.EXECUTABLE['path'])}, [])
        self.assertEqual(ui['root'], str(root)); self.assertEqual(ui['output'], str(root / 'test-results/installed-linux-permission-ui/one'))
        self.assertEqual(ui['claimPath'], str(private / 'installed-linux-permission-ui-once.json'))
        self.assertEqual(ui['build'], m.BUILD); self.assertEqual(ui['build']['buildNumber'], 41001)
        self.assertEqual(ui['build']['commit'], m.c.PRODUCT)

    def test_public_asset_direct200_and_single302_close_originals_and_strip_blob_auth(self):
        m = self.m; raw = b'owned synthetic public ZIP bytes'
        class Response(io.BytesIO):
            def __init__(self, status, headers, body=b''):
                super().__init__(body); self.status, self.headers = status, headers
        class Sink(io.BytesIO):
            def close(self): self.retained = self.getvalue(); super().close()
        for redirected in [False, True]:
            sink = Sink(); body = Response(200, {'Content-Length': str(len(raw))}, raw)
            first = Response(302, {'Location': 'https://' + m.APP_HOST + '/x?signature=never-retain'})
            opener = mock.Mock(); opener.open.side_effect = [first, body] if redirected else [body]
            receipts = []
            with mock.patch.object(m, 'APP_BYTES', len(raw)), mock.patch.object(m, 'APP_SHA', m.c.digest(raw)), \
                 mock.patch.object(m.urllib.request, 'build_opener', return_value=opener), \
                 mock.patch.object(m.ssl, 'create_default_context', return_value=None), \
                 mock.patch('pathlib.Path.open', return_value=sink), \
                 mock.patch.object(m.c, 'write', side_effect=lambda path, value: receipts.append(value)):
                m.acquire_app(Path('/not-written'), Path('/not-written'), 'dedicated')
            self.assertEqual(sink.retained, raw); self.assertTrue(body.closed and sink.closed and receipts[0]['ok'])
            self.assertEqual(opener.open.call_count, 2 if redirected else 1)
            self.assertNotIn('never-retain', json.dumps(receipts))
            if redirected:
                self.assertTrue(first.closed)
                self.assertFalse(any(k.lower() == 'authorization' for k in opener.open.call_args_list[1].args[0].headers))

    def test_public_asset_extra_redirect_fails_without_body_file_or_retry(self):
        m = self.m
        class Response(io.BytesIO):
            status = 302
            headers = {'Location': 'https://' + m.APP_HOST + '/x?never=retain'}
        first, second = Response(), Response(); opener = mock.Mock(); opener.open.side_effect = [first, second]
        receipts = []
        with mock.patch.object(m.urllib.request, 'build_opener', return_value=opener), \
             mock.patch.object(m.ssl, 'create_default_context', return_value=None), \
             mock.patch('pathlib.Path.open', side_effect=AssertionError('No data on another redirect')), \
             mock.patch.object(m.c, 'write', side_effect=lambda path, value: receipts.append(value)):
            with self.assertRaisesRegex(ValueError, '^public-app-acquisition-failed$'):
                m.acquire_app(Path('/not-written'), Path('/not-written'), 'dedicated')
        self.assertEqual(opener.open.call_count, 2); self.assertTrue(first.closed and second.closed)
        self.assertFalse(receipts[0]['ok']); self.assertEqual(receipts[0]['automaticRetries'], 0)
        for bad in ['https://other.invalid/x', 'http://' + m.APP_HOST + '/x', 'https://user@' + m.APP_HOST + '/x']:
            with self.assertRaises(ValueError): m.app_redirect(bad)

    def test_old_runtime_or_missing_delegation_cannot_be_promoted_to_conditional_acceptance(self):
        m = self.m; parent, identity = self.fixture()
        raw = {'ok': True, 'status': 'private-qemu-capability-observed', 'harnessSource': '0' * 40, 'productSource': m.c.PRODUCT}
        with self.assertRaises(ValueError): m.runtime_primary(parent, {'GITHUB_RUN_ID': '100'}, raw, {}, {}, {})
        raw['harnessSource'] = parent['expectedHarnessSource']
        with self.assertRaises(ValueError): m.runtime_primary({**parent, 'allowConditionalRuntimeAcceptance': False}, {'GITHUB_RUN_ID': '100'}, raw, {}, {}, {})

    def test_combined_isolated_import_has_no_transport_subprocess_archive_or_write_effect(self):
        blocked = AssertionError('Definitions-only combined import')
        with mock.patch('subprocess.Popen', side_effect=blocked), mock.patch('urllib.request.OpenerDirector.open', side_effect=blocked), \
             mock.patch('zipfile.ZipFile', side_effect=blocked), mock.patch('pathlib.Path.mkdir', side_effect=blocked), \
             mock.patch('pathlib.Path.write_text', side_effect=blocked), mock.patch.dict('os.environ', {}, clear=True):
            namespace = runpy.run_path(str(ROOT / 'scripts/diagnostics/installed-linux-permission-combined.py'), run_name='combined_inert_smoke')
        self.assertTrue(callable(namespace['run_combined']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
