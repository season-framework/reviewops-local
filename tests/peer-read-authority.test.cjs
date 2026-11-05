'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPeerReadAuthority} = require('../electron/peer-read-authority.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const code = expected => error => error.code === expected;
const denied = action => assert.throws(action, code('ACCESS_DENIED'));
function fixture() {
  const trusted = new WeakSet();
  const peer = Object.freeze(Object.create(null)); trusted.add(peer);
  let data = {epoch: A, projectIds: ['a', 'b']};
  let verify = handle => trusted.has(handle), provide = () => data;
  let verifierCalls = 0, providerCalls = 0;
  const authority = createPeerReadAuthority({
    verifyPeerHandle(handle) { verifierCalls++; return verify(handle); },
    currentDataset() { providerCalls++; return provide(); }
  });
  return {authority, peer, trust(handle) { trusted.add(handle); },
    data(value) { data = value; }, verifier(value) { verify = value; }, provider(value) { provide = value; },
    calls() { return {verifierCalls, providerCalls}; }};
}
function session(f, projectIds = ['a']) {
  f.authority.approvePeer(f.peer, {projectIds});
  f.authority.setEnabled(true);
  return f.authority.openSession(f.peer);
}
const context = (authority, cap) => authority.withReadContext(cap, value => value);

test('authority is disconnected and disabled until explicitly enabled', () => {
  const f = fixture();
  assert.deepEqual(f.calls(), {verifierCalls: 0, providerCalls: 0});
  f.authority.approvePeer(f.peer, {projectIds: ['a']});
  denied(() => f.authority.openSession(f.peer));
  assert.throws(() => f.authority.setEnabled(1), code('INVALID_AUTHORITY_REQUEST'));
  f.authority.setEnabled(true);
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('context contains only current approved projects and is deeply frozen and detached', () => {
  const f = fixture(), projects = ['b', 'a'];
  const cap = session(f, projects); projects.splice(0, 2, 'foreign');
  const result = context(f.authority, cap);
  assert.deepEqual(result, {projectGrants: [{projectId: 'b', read: true}, {projectId: 'a', read: true}]});
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.projectGrants) && result.projectGrants.every(Object.isFrozen));
  assert.throws(() => { result.projectGrants[0].projectId = 'foreign'; }, TypeError);
  assert.throws(() => result.projectGrants.push({projectId: 'foreign', read: true}), TypeError);
  assert.notEqual(context(f.authority, cap), result);
});

test('an explicit empty grant list stays empty instead of adopting existing projects', () => {
  const f = fixture(), cap = session(f, []);
  assert.deepEqual(context(f.authority, cap), {projectGrants: []});
  f.data({epoch: A, projectIds: ['a', 'b', 'new']});
  assert.deepEqual(context(f.authority, cap), {projectGrants: []});
});

test('fingerprints and caller-created handles do not establish verification', () => {
  const f = fixture();
  for (const peer of ['a'.repeat(64), 'device-a', {}, Object.freeze(Object.create(null)), null])
    denied(() => f.authority.approvePeer(peer, {projectIds: ['a']}));
  const trap = new Proxy({}, {get() { throw new Error('identity fields must not be read'); }});
  f.trust(trap); f.authority.approvePeer(trap, {projectIds: ['a']}); f.authority.setEnabled(true);
  assert.deepEqual(context(f.authority, f.authority.openSession(trap)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('verifier accepts only strict true and does not disclose provider errors', () => {
  for (const value of [false, 1, 'true', {}, Promise.resolve(true)]) {
    const f = fixture(); f.verifier(() => value);
    denied(() => f.authority.approvePeer(f.peer, {projectIds: ['a']}));
  }
  const f = fixture(); f.verifier(() => { throw new Error('PRIVATE verifier detail'); });
  assert.throws(() => f.authority.approvePeer(f.peer, {projectIds: ['a']}), error =>
    error.code === 'ACCESS_DENIED' && !error.message.includes('PRIVATE'));
});

test('session capability has no serializable identity and cannot be forged or moved to another authority', () => {
  const f = fixture(), other = fixture(), cap = session(f);
  assert.ok(Object.isFrozen(cap)); assert.equal(Object.getPrototypeOf(cap), null);
  assert.deepEqual(Reflect.ownKeys(cap), []); assert.equal(JSON.stringify(cap), '{}');
  let called = false;
  for (const forged of [{}, JSON.parse(JSON.stringify(cap)), Object.freeze(Object.create(null)), null])
    denied(() => f.authority.withReadContext(forged, () => { called = true; }));
  denied(() => other.authority.withReadContext(cap, () => { called = true; }));
  assert.equal(called, false);
});

test('revocation followed by reapproval never revives an original session', () => {
  const f = fixture(), old = session(f);
  assert.equal(f.authority.revokePeer(f.peer), true);
  f.authority.approvePeer(f.peer, {projectIds: ['a']});
  denied(() => context(f.authority, old));
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('even an identical approval replacement retires old sessions', () => {
  const f = fixture(), old = session(f);
  f.authority.approvePeer(f.peer, {projectIds: ['a']});
  denied(() => context(f.authority, old));
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('a replacement verified handle cannot adopt an old handle session', () => {
  const f = fixture(), old = session(f), replacement = Object.freeze(Object.create(null));
  f.trust(replacement); f.authority.revokePeer(f.peer);
  f.authority.approvePeer(replacement, {projectIds: ['b']});
  denied(() => context(f.authority, old));
  assert.deepEqual(context(f.authority, f.authority.openSession(replacement)), {projectGrants: [{projectId: 'b', read: true}]});
});

test('disable and reenable require a fresh original session', () => {
  const f = fixture(), old = session(f);
  f.authority.setEnabled(false); f.authority.setEnabled(true);
  denied(() => context(f.authority, old));
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('observed epoch A to B to A clears approvals and never renews old capabilities', () => {
  const f = fixture(), old = session(f);
  f.data({epoch: B, projectIds: ['a', 'b']});
  denied(() => context(f.authority, old)); denied(() => f.authority.openSession(f.peer));
  f.data({epoch: A, projectIds: ['a', 'b']});
  f.authority.approvePeer(f.peer, {projectIds: ['a']});
  denied(() => context(f.authority, old));
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('observed project deletion removes its grant and same-ID reappearance does not restore it', () => {
  const f = fixture(), old = session(f, ['a', 'b']);
  f.data({epoch: A, projectIds: ['b']}); denied(() => context(f.authority, old));
  f.data({epoch: A, projectIds: ['a', 'b']});
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'b', read: true}]});
  f.authority.approvePeer(f.peer, {projectIds: ['a']});
  assert.deepEqual(context(f.authority, f.authority.openSession(f.peer)), {projectGrants: [{projectId: 'a', read: true}]});
});

test('approval cannot name a currently missing project or replace a good approval on invalid input', () => {
  const f = fixture(), old = session(f);
  denied(() => f.authority.approvePeer(f.peer, {projectIds: ['missing']}));
  assert.deepEqual(context(f.authority, old), {projectGrants: [{projectId: 'a', read: true}]});
});

test('fresh provider failures deny without invoking a reader or exposing details', () => {
  const f = fixture(), cap = session(f); let reads = 0;
  f.provider(() => { throw new Error('PRIVATE dataset detail'); });
  assert.throws(() => f.authority.withReadContext(cap, () => { reads++; }), error =>
    error.code === 'ACCESS_DENIED' && !error.message.includes('PRIVATE'));
  assert.equal(reads, 0);
  f.provider(() => ({epoch: A, projectIds: ['a', 'b']}));
  assert.deepEqual(context(f.authority, cap), {projectGrants: [{projectId: 'a', read: true}]});
});

test('a lost verified handle retires its session even if the verifier later returns true', () => {
  const f = fixture(), cap = session(f), other = f.authority.openSession(f.peer); let reads = 0;
  f.verifier(() => false); denied(() => f.authority.withReadContext(cap, () => { reads++; }));
  f.verifier(() => true); denied(() => context(f.authority, cap)); denied(() => context(f.authority, other)); assert.equal(reads, 0);
});

test('malformed or asynchronous dataset records deny before the callback', () => {
  const malformed = [null, {}, {epoch: A}, {epoch: A, projectIds: ['a'], grants: []},
    {epoch: 'bad', projectIds: ['a']}, {epoch: A, projectIds: ['a', 'a']},
    {epoch: A, projectIds: ['x'.repeat(129)]}, {epoch: A, projectIds: new Array(1)},
    Promise.resolve({epoch: A, projectIds: ['a']})];
  for (const row of malformed) {
    const f = fixture(), cap = session(f); let reads = 0;
    f.provider(() => row); denied(() => f.authority.withReadContext(cap, () => { reads++; })); assert.equal(reads, 0);
  }
});

test('classification uses own data properties without reading accessor values', () => {
  const f = fixture(), cap = session(f); let getters = 0, reads = 0;
  const row = {projectIds: ['a']}; Object.defineProperty(row, 'epoch', {enumerable: true, get() { getters++; return A; }});
  f.provider(() => row); denied(() => f.authority.withReadContext(cap, () => { reads++; }));
  const projects = ['a']; Object.defineProperty(projects, '0', {get() { getters++; return 'a'; }});
  f.provider(() => ({epoch: A, projectIds: projects})); denied(() => f.authority.withReadContext(cap, () => { reads++; }));
  assert.equal(getters, 0); assert.equal(reads, 0);
});

test('approval schema refuses caller authority, duplicate IDs and accessor grants', () => {
  const f = fixture(); let getters = 0;
  for (const input of [{projectIds: ['a'], read: true}, {projectIds: ['a'], principalId: 'caller'},
    {projectIds: ['a'], projectGrants: []}, {projectIds: ['a', 'a']}, {projectIds: ['']}, {projectIds: 'a'}])
    assert.throws(() => f.authority.approvePeer(f.peer, input), code('INVALID_AUTHORITY_REQUEST'));
  const input = {}; Object.defineProperty(input, 'projectIds', {enumerable: true, get() { getters++; return ['a']; }});
  assert.throws(() => f.authority.approvePeer(f.peer, input), code('INVALID_AUTHORITY_REQUEST'));
  assert.equal(getters, 0);
});

test('post-callback checks withhold results after reentrant authority changes', () => {
  const changes = [f => f.authority.revokePeer(f.peer), f => f.authority.approvePeer(f.peer, {projectIds: ['a']}),
    f => { f.authority.setEnabled(false); f.authority.setEnabled(true); },
    f => f.data({epoch: B, projectIds: ['a', 'b']}), f => f.data({epoch: A, projectIds: ['b']}),
    f => f.verifier(() => false), f => f.provider(() => { throw new Error('PRIVATE'); }),
    (f, cap) => f.authority.closeSession(cap)];
  for (const change of changes) {
    const f = fixture(), cap = session(f); let entered = 0;
    denied(() => f.authority.withReadContext(cap, () => { entered++; change(f, cap); return {mustNotEscape: true}; }));
    assert.equal(entered, 1);
  }
});

test('async and thenable readers are refused without invoking a then function', () => {
  const f = fixture(), cap = session(f); let thenCalled = false;
  assert.throws(() => f.authority.withReadContext(cap, async () => 1), code('INVALID_READER'));
  assert.throws(() => f.authority.withReadContext(cap, () => ({then() { thenCalled = true; }})), code('INVALID_READER'));
  const bad = {}; Object.defineProperty(bad, 'then', {get() { throw new Error('PRIVATE then'); }});
  assert.throws(() => f.authority.withReadContext(cap, () => bad), error => error.code === 'INVALID_READER' && !error.message.includes('PRIVATE'));
  assert.equal(thenCalled, false);
});

test('ordinary synchronous query errors retain their original identity', () => {
  const f = fixture(), cap = session(f), error = Object.assign(new Error('Shared resource not found.'), {code: 'NOT_FOUND'});
  assert.throws(() => f.authority.withReadContext(cap, () => { throw error; }), value => value === error);
});

test('peer and live-session limits free resources through explicit lifecycle operations', () => {
  const f = fixture(), peers = Array.from({length: 65}, () => Object.freeze(Object.create(null)));
  peers.forEach(peer => f.trust(peer));
  for (const peer of peers.slice(0, 64)) f.authority.approvePeer(peer, {projectIds: []});
  assert.throws(() => f.authority.approvePeer(peers[64], {projectIds: []}), code('AUTHORITY_LIMIT_EXCEEDED'));
  f.authority.revokePeer(peers[0]); f.authority.approvePeer(peers[64], {projectIds: []}); f.authority.setEnabled(true);
  const caps = Array.from({length: 256}, () => f.authority.openSession(peers[1]));
  assert.throws(() => f.authority.openSession(peers[1]), code('AUTHORITY_LIMIT_EXCEEDED'));
  assert.equal(f.authority.closeSession(caps[0]), true); assert.equal(f.authority.closeSession(caps[0]), false);
  const renewed = f.authority.openSession(peers[1]); f.authority.revokePeer(peers[1]);
  denied(() => context(f.authority, renewed));
  for (let index = 0; index < 256; index++) f.authority.openSession(peers[2]);
  f.authority.setEnabled(false); f.authority.setEnabled(true);
  assert.deepEqual(context(f.authority, f.authority.openSession(peers[2])), {projectGrants: []});
});

test('grant and dataset row bounds are exact and fail without a partial context', () => {
  const f = fixture(), thousand = Array.from({length: 1000}, (_, index) => `p${index}`);
  f.data({epoch: A, projectIds: [...thousand, 'overflow']});
  const cap = session(f, thousand);
  assert.equal(context(f.authority, cap).projectGrants.length, 1000);
  assert.throws(() => f.authority.approvePeer(f.peer, {projectIds: [...thousand, 'overflow']}), code('INVALID_AUTHORITY_REQUEST'));
  const maximum = Array.from({length: 100000}, (_, index) => `p${index}`);
  f.data({epoch: A, projectIds: maximum}); assert.equal(context(f.authority, cap).projectGrants.length, 1000);
  f.data({epoch: A, projectIds: [...maximum, 'overflow']}); let reads = 0;
  denied(() => f.authority.withReadContext(cap, () => { reads++; })); assert.equal(reads, 0);
});

test('constructor requires exact synchronous provider functions', () => {
  for (const input of [undefined, {}, {verifyPeerHandle() {}},
    {verifyPeerHandle() {}, currentDataset() {}, grants: []}, {verifyPeerHandle: true, currentDataset() {}}])
    assert.throws(() => createPeerReadAuthority(input), code('INVALID_AUTHORITY_CONFIG'));
});
