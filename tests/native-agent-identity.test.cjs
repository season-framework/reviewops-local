'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../scripts/native-packet.mjs');

// The PID and ticks reproduce run 41406718922's two-lifetime shape. Nonces are
// synthetic inputs for the new contract, not a revalidation of that old run.
const priorNonce = '11111111-1111-4111-8111-111111111111';
const currentNonce = '22222222-2222-4222-8222-222222222222';
const parentTicks = '639292016762761943';
const childTicks = '639292016765096148';
function fixture() {
  const root = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\rv-on-4ApkCj';
  const expected = {
    launcherPath: root + '\\bin\\codex.exe',
    nodeExecutable: 'C:\\hostedtoolcache\\windows\\node\\24.22.2\\x64\\node.exe',
    agentScript: root + '\\fixture-agent.cjs',
    nodeSHA256: '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9',
    agentSHA256: 'd6f2f321f5637f2cc0d7f0763ebd7908b4f5e07a7eb2aa8213eaddf262264cb8',
    configSHA256: '623fa46d3350084fbb3c720cce34c4a7911162ca92fdd4442b2cac8025bd0c8e'
  };
  const args = ['exec', '--json', '--skip-git-repo-check', '--model', 'fixture-model', '--dangerously-bypass-approvals-and-sandbox', '-'];
  const cwd = root + '\\agent-A-workspace-0';
  const make = (parent, startTicks, nodeTicks, launchNonce, command, directory) => ({
    name: `launcher-${parent}-${startTicks}.jsonl`,
    records: [
      {phase: 'native-start', launchNonce, launcherPid: parent, launcherStartTicks: startTicks,
        launcherPath: expected.launcherPath, cwd: directory, args: [...command], configSHA256: expected.configSHA256},
      {phase: 'node-child-start', launchNonce, launcherPid: parent, launcherStartTicks: startTicks,
        nodeChildPid: 4296, nodeStartTicks: nodeTicks, nodeExecutable: expected.nodeExecutable,
        nodeSHA256: expected.nodeSHA256, agentScript: expected.agentScript, agentSHA256: expected.agentSHA256,
        cwd: directory, args: [...command]}
    ]
  });
  const prior = make(6380, '639292016556627985', '639292016561274171', priorNonce, ['app-server'], root + '\\home');
  const current = make(6588, parentTicks, childTicks, currentNonce, args, cwd);
  current.records.push({phase: 'node-child-exit', launchNonce: currentNonce, launcherPid: 6588,
    launcherStartTicks: parentTicks, nodeChildPid: 4296, nodeStartTicks: childTicks, exitCode: 0});
  return {journals: [prior, current], observed: {pid: 4296, ppid: 6588, launchNonce: currentNonce,
    argv: [expected.nodeExecutable, expected.agentScript, ...args], cwd}, expected};
}
const choose = (api, input) => api.selectWindowsAgentIdentity(input.journals, input.observed, input.expected);
const currentIdentities = [
  {pid: 6588, startTicks: parentTicks},
  {pid: 4296, startTicks: childTicks}
];

test('reused PID 4296 selects the current exact nonce and both original start ticks in either journal order', async () => {
  const api = await modulePromise;
  for (const reverse of [false, true]) {
    const input = fixture();
    if (reverse) input.journals.reverse();
    const before = structuredClone(input), selected = choose(api, input);
    assert.deepEqual(selected.identities, currentIdentities);
    assert.equal(selected.launcher.launchNonce, currentNonce);
    assert.equal(selected.nativeStart.launchNonce, currentNonce);
    assert.equal(selected.journal, `launcher-6588-${parentTicks}.jsonl`);
    assert.deepEqual(input, before, 'Raw argv, cwd, and journal inputs must remain unchanged');
  }
});

test('reuse of both child and parent numeric PIDs stays distinct by nonce and original ticks', async () => {
  const api = await modulePromise, input = fixture(), prior = input.journals[0];
  prior.name = 'launcher-6588-639292016556627985.jsonl';
  for (const row of prior.records) {
    row.launcherPid = 6588;
    row.args = [...input.observed.argv.slice(2)];
    row.cwd = input.observed.cwd;
  }
  assert.deepEqual(choose(api, input).identities, currentIdentities);
});

test('an exact older observation selects its own lifetime rather than the latest reused PID', async () => {
  const api = await modulePromise, input = fixture(), prior = input.journals[0];
  input.observed = {pid: 4296, ppid: 6380, launchNonce: priorNonce,
    argv: [input.expected.nodeExecutable, input.expected.agentScript, 'app-server'], cwd: prior.records[1].cwd};
  assert.deepEqual(choose(api, input).identities, [
    {pid: 6380, startTicks: '639292016556627985'},
    {pid: 4296, startTicks: '639292016561274171'}
  ]);
});

test('a completed observation can omit the optional exit journal row', async () => {
  const api = await modulePromise, input = fixture();
  input.journals[1].records.pop();
  assert.deepEqual(choose(api, input).identities, currentIdentities);
});

const invalidSelections = [
  ['missing nonce', input => delete input.observed.launchNonce],
  ['malformed nonce', input => input.observed.launchNonce = 'not-a-guid'],
  ['non-v4 nonce', input => input.observed.launchNonce = currentNonce.replace('-4222-', '-3222-')],
  ['nonce from the other lifetime', input => input.observed.launchNonce = priorNonce],
  ['missing parent PID', input => delete input.observed.ppid],
  ['parent PID from the other lifetime', input => input.observed.ppid = 6380],
  ['duplicate exact child start', input => input.journals[1].records.push({...input.journals[1].records[1]})],
  ['duplicate exact journal', input => input.journals.push(structuredClone(input.journals[1]))],
  ['an extra child start in the selected journal', input => input.journals[1].records.push({...input.journals[0].records[1]})],
  ['missing same-journal native start', input => input.journals[1].records.shift()],
  ['native start moved to another journal', input => input.journals[0].records.push(input.journals[1].records.shift())],
  ['duplicate native start', input => input.journals[1].records.push({...input.journals[1].records[0]})],
  ['mixed native nonce', input => input.journals[1].records[0].launchNonce = priorNonce],
  ['mixed native parent PID', input => input.journals[1].records[0].launcherPid = 6380],
  ['mixed native parent ticks', input => input.journals[1].records[0].launcherStartTicks = '639292016556627985'],
  ['malformed parent ticks', input => input.journals[1].records[1].launcherStartTicks = '1.5'],
  ['missing child ticks', input => delete input.journals[1].records[1].nodeStartTicks],
  ['malformed child ticks', input => input.journals[1].records[1].nodeStartTicks = '0'],
  ['wrong journal filename identity', input => input.journals[1].name = 'launcher-6588-1.jsonl'],
  ['wrong native executable', input => input.journals[1].records[0].launcherPath = 'C:\\other\\codex.exe'],
  ['wrong Node executable', input => input.journals[1].records[1].nodeExecutable = 'C:\\other\\node.exe'],
  ['wrong agent script', input => input.journals[1].records[1].agentScript = 'C:\\other\\fixture-agent.cjs'],
  ['wrong Node hash', input => input.journals[1].records[1].nodeSHA256 = 'd'.repeat(64)],
  ['wrong source script hash', input => input.journals[1].records[1].agentSHA256 = 'd'.repeat(64)],
  ['wrong config hash', input => input.journals[1].records[0].configSHA256 = 'd'.repeat(64)],
  ['malformed expected source hash', input => input.expected.agentSHA256 = 'not-a-sha256'],
  ['wrong child args', input => input.journals[1].records[1].args = ['app-server']],
  ['wrong native args', input => input.journals[1].records[0].args = ['app-server']],
  ['wrong child cwd', input => input.journals[1].records[1].cwd = 'C:\\other'],
  ['wrong native cwd', input => input.journals[1].records[0].cwd = 'C:\\other'],
  ['wrong observed cwd', input => input.observed.cwd = 'C:\\other'],
  ['wrong observed Node path', input => input.observed.argv[0] = 'C:\\other\\node.exe'],
  ['wrong observed script path', input => input.observed.argv[1] = 'C:\\other\\fixture-agent.cjs'],
  ['wrong observed args', input => input.observed.argv[2] = 'app-server'],
  ['mixed exit nonce', input => input.journals[1].records[2].launchNonce = priorNonce],
  ['mixed exit parent PID', input => input.journals[1].records[2].launcherPid = 6380],
  ['mixed exit parent ticks', input => input.journals[1].records[2].launcherStartTicks = '639292016556627985'],
  ['mixed exit child PID', input => input.journals[1].records[2].nodeChildPid = 1],
  ['mixed exit child ticks', input => input.journals[1].records[2].nodeStartTicks = '639292016561274171'],
  ['duplicate exit row', input => input.journals[1].records.push({...input.journals[1].records[2]})],
  ['non-integer exit code', input => input.journals[1].records[2].exitCode = '0']
];
for (const [name, mutate] of invalidSelections) {
  test(`identity selection fails closed: ${name}`, async () => {
    const api = await modulePromise, input = fixture();
    mutate(input);
    assert.throws(() => choose(api, input), {code: 'ERR_ASSERTION'});
  });
}

function exitedStates() {
  return currentIdentities.map(row => ({pid: row.pid, requestedStartTicks: row.startTicks,
    originalRunning: false, state: 'not-present'}));
}
test('the exact two inspector identity pairs confirm that both originals are absent', async () => {
  const api = await modulePromise;
  api.assertWindowsIdentityStates(exitedStates(), currentIdentities);
});
test('a different currently observed PID lifetime is never adopted as the original', async () => {
  const api = await modulePromise, states = exitedStates();
  for (const row of states) {
    row.state = 'pid-reused-do-not-adopt';
    row.observedStartTicks = '639292016999999999';
  }
  api.assertWindowsIdentityStates(states, currentIdentities);
});
const invalidStates = [
  ['wrong returned parent PID', states => states[0].pid = 6380],
  ['wrong returned child PID', states => states[1].pid = 1],
  ['wrong returned parent ticks', states => states[0].requestedStartTicks = '639292016556627985'],
  ['wrong returned child ticks', states => states[1].requestedStartTicks = '639292016561274171'],
  ['swapped returned identity pairs', states => states.reverse()],
  ['missing returned identity pair', states => states.pop()],
  ['duplicate returned identity pair', states => states[1] = {...states[0]}],
  ['original parent still running', states => states[0].originalRunning = true],
  ['original child still running', states => states[1].originalRunning = true],
  ['missing originalRunning verdict', states => delete states[1].originalRunning]
];
for (const [name, mutate] of invalidStates) {
  test(`identity inspection fails closed: ${name}`, async () => {
    const api = await modulePromise, states = exitedStates();
    mutate(states);
    assert.throws(() => api.assertWindowsIdentityStates(states, currentIdentities), {code: 'ERR_ASSERTION'});
  });
}


// These in-memory file descriptors exercise the exported production reader.
// They allocate no temporary files and launch no OS process or native fixture.
const path = require('node:path');
const MiB = 1024 ** 2;
function journalIO(entries) {
  const calls = {opened: [], closed: [], reads: []}, handles = new Map();
  let nextFD = 10;
  const stats = (entry, overrides = {}) => ({dev: 1, ino: entry.ino || 1,
    size: entry.size ?? Buffer.byteLength(entry.content), mtimeMs: 10, ctimeMs: 20,
    isFile: () => true, isSymbolicLink: () => false, ...overrides});
  const entryFor = file => {
    const entry = entries.find(value => value.name === path.basename(file));
    assert.ok(entry, 'The reader must address only the listed mock journal');
    return entry;
  };
  const io = {
    constants: {O_RDONLY: 0, O_NOFOLLOW: 0x20000},
    readdirSync: () => entries.map(entry => entry.name),
    lstatSync(file) {
      const entry = entryFor(file), index = entry.pathStatCount || 0;
      entry.pathStatCount = index + 1;
      return stats(entry, entry.pathStats?.[index]);
    },
    openSync(file, flags) {
      const entry = entryFor(file), fd = nextFD++;
      assert.equal(flags, io.constants.O_NOFOLLOW);
      handles.set(fd, entry); calls.opened.push(entry.name); return fd;
    },
    fstatSync(fd) {
      assert.ok(handles.has(fd));
      const entry = handles.get(fd), index = entry.fdStatCount || 0;
      entry.fdStatCount = index + 1;
      return stats(entry, entry.fdStats?.[index]);
    },
    readSync(fd, buffer, offset, length, position) {
      assert.ok(handles.has(fd));
      const entry = handles.get(fd), size = entry.size ?? Buffer.byteLength(entry.content);
      const actual = Math.max(0, Math.min(length, size - position, entry.readLimit ?? length));
      calls.reads.push({name: entry.name, requested: length, actual, position});
      assert.ok(length <= 64 * 1024, 'Every read request is bounded');
      assert.ok(position + length <= size, 'No extra EOF byte is requested');
      if (entry.content !== undefined) Buffer.from(entry.content).copy(buffer, offset, position, position + actual);
      else {
        buffer.fill(32, offset, offset + actual);
        if (position === 0 && actual >= 2) { buffer[offset] = 123; buffer[offset + 1] = 125; }
        if (position + actual === size && actual > 0) buffer[offset + actual - 1] = 10;
      }
      return actual;
    },
    closeSync(fd) {
      assert.ok(handles.has(fd)); calls.closed.push(handles.get(fd).name); handles.delete(fd);
    }
  };
  return {io, calls, handles};
}
const smallJournal = overrides => ({name: 'launcher-6588-639292016762761943.jsonl', content: '{"phase":"native-start"}\n', ...overrides});
function assertReadBudget(calls) {
  assert.ok(calls.reads.reduce((sum, row) => sum + row.requested, 0) <= 32 * MiB);
  assert.ok(calls.reads.reduce((sum, row) => sum + row.actual, 0) <= 32 * MiB);
  for (const name of new Set(calls.reads.map(row => row.name))) {
    const rows = calls.reads.filter(row => row.name === name);
    assert.ok(rows.reduce((sum, row) => sum + row.requested, 0) <= 16 * MiB);
    assert.ok(rows.reduce((sum, row) => sum + row.actual, 0) <= 16 * MiB);
  }
}

test('the real journal reader parses every row and always closes its file descriptor', async () => {
  const api = await modulePromise, fake = journalIO([smallJournal({content: '{"phase":"native-start"}\n{"phase":"node-child-start"}\n'})]);
  assert.deepEqual(api.readWindowsLauncherJournals('inert-journals', fake.io), [{
    name: 'launcher-6588-639292016762761943.jsonl', records: [{phase: 'native-start'}, {phase: 'node-child-start'}]
  }]);
  assert.deepEqual(fake.calls.closed, fake.calls.opened); assert.equal(fake.handles.size, 0); assertReadBudget(fake.calls);
});

test('exact 16 MiB files and exact 32 MiB total are accepted without an extra EOF read', async () => {
  const api = await modulePromise, fake = journalIO([
    {name: 'launcher-1-1.jsonl', size: 16 * MiB, ino: 1},
    {name: 'launcher-2-2.jsonl', size: 16 * MiB, ino: 2}
  ]);
  assert.deepEqual(api.readWindowsLauncherJournals('inert-journals', fake.io).map(row => row.records), [[{}], [{}]]);
  assert.equal(fake.calls.reads.reduce((sum, row) => sum + row.requested, 0), 32 * MiB);
  assert.deepEqual(fake.calls.closed, fake.calls.opened); assertReadBudget(fake.calls);
});

test('a third 16 MiB journal is rejected before open or read after the 32 MiB budget is consumed', async () => {
  const api = await modulePromise, fake = journalIO([1, 2, 3].map(pid => ({name: `launcher-${pid}-${pid}.jsonl`, size: 16 * MiB, ino: pid})));
  assert.throws(() => api.readWindowsLauncherJournals('inert-journals', fake.io), /aggregate overflow/);
  assert.deepEqual(fake.calls.opened, ['launcher-1-1.jsonl', 'launcher-2-2.jsonl']);
  assert.deepEqual(fake.calls.closed, fake.calls.opened); assert.equal(fake.handles.size, 0); assertReadBudget(fake.calls);
});

const invalidJournals = [
  ['per-file overflow before opening', () => smallJournal({size: 16 * MiB + 1}), 0],
  ['a symlink before opening', () => smallJournal({pathStats: [{isSymbolicLink: () => true}]}), 0],
  ['file growth between path stat and FD stat', () => smallJournal({fdStats: [{size: 16 * MiB + 1}]}), 0],
  ['different opened inode', () => smallJournal({fdStats: [{ino: 99}]}), 0],
  ['different opened modification time', () => smallJournal({fdStats: [{mtimeMs: 11}]}), 0],
  ['growth during reading at the exact per-file cap', () => ({name: 'launcher-1-1.jsonl', size: 16 * MiB, fdStats: [{}, {size: 16 * MiB + 1}]}), 16 * MiB],
  ['replacement of the path after reading', () => smallJournal({pathStats: [{}, {ino: 99}]}), undefined],
  ['modification time changed after reading', () => smallJournal({fdStats: [{}, {mtimeMs: 11}]}), undefined],
  ['change time changed after reading', () => smallJournal({fdStats: [{}, {ctimeMs: 21}]}), undefined],
  ['early EOF', () => smallJournal({readLimit: 0}), undefined],
  ['short read without retry', () => smallJournal({readLimit: 1}), undefined],
  ['an incomplete final row', () => smallJournal({content: '{"phase":"native-start"}'}), undefined],
  ['an invalid row', () => smallJournal({content: '{"phase":"native-start"}\nnot-json\n'}), undefined],
  ['a trailing blank row rather than silently omitting it', () => smallJournal({content: '{"phase":"native-start"}\n\n'}), undefined]
];
for (const [name, make, expectedRequestedBytes] of invalidJournals) {
  test(`bounded journal reading fails closed: ${name}`, async () => {
    const api = await modulePromise, fake = journalIO([make()]);
    assert.throws(() => api.readWindowsLauncherJournals('inert-journals', fake.io));
    if (expectedRequestedBytes !== undefined) assert.equal(fake.calls.reads.reduce((sum, row) => sum + row.requested, 0), expectedRequestedBytes);
    assert.deepEqual(fake.calls.closed, fake.calls.opened);
    assert.equal(fake.handles.size, 0); assertReadBudget(fake.calls);
    if (name.includes('EOF') || name.includes('short read')) assert.equal(fake.calls.reads.length, 1, 'No retry can expand the requested-byte budget');
  });
}
