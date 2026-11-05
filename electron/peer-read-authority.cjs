'use strict';

const MAX_PEERS = 64;
const MAX_GRANTS = 1000;
const MAX_SESSIONS = 256;
const MAX_PROJECTS = 100000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MESSAGES = Object.freeze({
  INVALID_AUTHORITY_CONFIG: 'Peer read authority is unavailable.',
  INVALID_AUTHORITY_REQUEST: 'Invalid peer read authority request.',
  ACCESS_DENIED: 'Peer read access is unavailable.',
  AUTHORITY_LIMIT_EXCEEDED: 'Peer read authority limit exceeded.',
  INVALID_READER: 'A synchronous application-owned read callback is required.'
});
function fail(code) { throw Object.assign(new Error(MESSAGES[code]), {code}); }
function closed(value, keys, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(code);
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    copy[key] = descriptor.value;
  }
  return copy;
}
function ids(values, limit, code) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype || values.length > limit ||
      Reflect.ownKeys(values).length !== values.length + 1) fail(code);
  const result = [], seen = new Set();
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    const value = descriptor.value;
    if (typeof value !== 'string' || !ID.test(value) || seen.has(value)) fail(code);
    seen.add(value); result.push(value);
  }
  return result;
}
const handle = value => value !== null && ['object', 'function'].includes(typeof value);
const token = () => Object.freeze(Object.create(null));

// Internal authority only. The injected verifier, not an ID/fingerprint string,
// must recognize the trusted identity handle. No TLS or key provider exists here.
function createPeerReadAuthority(options) {
  const {verifyPeerHandle, currentDataset} = closed(options, ['verifyPeerHandle', 'currentDataset'], 'INVALID_AUTHORITY_CONFIG');
  if (typeof verifyPeerHandle !== 'function' || typeof currentDataset !== 'function') fail('INVALID_AUTHORITY_CONFIG');
  const approvals = new Map(), sessions = new WeakMap(), live = new Set();
  let enabled = false, activation = token(), observedEpoch;

  function retire(record) { record.retired = true; live.delete(record); }
  function retirePeer(peer) { for (const record of live) if (record.peer === peer) retire(record); }
  function retireAll() { for (const record of live) retire(record); }
  function verified(peer) {
    if (!handle(peer)) fail('ACCESS_DENIED');
    let result;
    try { result = verifyPeerHandle(peer); } catch { retirePeer(peer); fail('ACCESS_DENIED'); }
    if (result !== true) { retirePeer(peer); fail('ACCESS_DENIED'); }
  }
  function dataset() {
    let value, projectIds;
    try {
      value = closed(currentDataset(), ['epoch', 'projectIds'], 'ACCESS_DENIED');
      if (typeof value.epoch !== 'string' || !EPOCH.test(value.epoch)) fail('ACCESS_DENIED');
      projectIds = ids(value.projectIds, MAX_PROJECTS, 'ACCESS_DENIED');
    } catch { fail('ACCESS_DENIED'); }
    if (observedEpoch !== undefined && observedEpoch !== value.epoch) {
      retireAll(); approvals.clear();
    }
    observedEpoch = value.epoch;
    const existing = new Set(projectIds);
    // An observed deletion permanently removes that grant. An unobserved
    // same-ID delete/recreate needs a future project-incarnation provider.
    for (const [peer, approval] of approvals) {
      const remaining = approval.projects.filter(id => existing.has(id));
      if (remaining.length !== approval.projects.length) {
        retirePeer(peer);
        approvals.set(peer, {epoch: value.epoch, projects: Object.freeze(remaining)});
      }
    }
    return {epoch: value.epoch, existing};
  }
  function owned(capability) {
    const record = handle(capability) && sessions.get(capability);
    if (!record || record.retired) fail('ACCESS_DENIED');
    return record;
  }
  function authorize(record) {
    if (!enabled || record.retired || record.activation !== activation) fail('ACCESS_DENIED');
    verified(record.peer);
    const current = dataset();
    if (!enabled || record.retired || record.activation !== activation || record.epoch !== current.epoch ||
        approvals.get(record.peer) !== record.approval) { retire(record); fail('ACCESS_DENIED'); }
    return Object.freeze({projectGrants: Object.freeze(record.approval.projects.map(projectId =>
      Object.freeze({projectId, read: true})))});
  }

  return Object.freeze({
    setEnabled(value) {
      if (typeof value !== 'boolean') fail('INVALID_AUTHORITY_REQUEST');
      if (value !== enabled) { enabled = value; activation = token(); retireAll(); }
      return enabled;
    },
    approvePeer(peer, input) {
      const request = closed(input, ['projectIds'], 'INVALID_AUTHORITY_REQUEST');
      const projects = ids(request.projectIds, MAX_GRANTS, 'INVALID_AUTHORITY_REQUEST');
      verified(peer);
      const current = dataset();
      if (projects.some(id => !current.existing.has(id))) fail('ACCESS_DENIED');
      if (!approvals.has(peer) && approvals.size >= MAX_PEERS) fail('AUTHORITY_LIMIT_EXCEEDED');
      retirePeer(peer);
      approvals.set(peer, {epoch: current.epoch, projects: Object.freeze(projects)});
    },
    revokePeer(peer) {
      if (!handle(peer)) fail('INVALID_AUTHORITY_REQUEST');
      retirePeer(peer); return approvals.delete(peer);
    },
    openSession(peer) {
      if (!enabled) fail('ACCESS_DENIED');
      verified(peer);
      const current = dataset(), approval = approvals.get(peer);
      if (!enabled || !approval || approval.epoch !== current.epoch) fail('ACCESS_DENIED');
      if (live.size >= MAX_SESSIONS) fail('AUTHORITY_LIMIT_EXCEEDED');
      const capability = token();
      const record = {peer, approval, epoch: current.epoch, activation, retired: false};
      sessions.set(capability, record); live.add(record);
      return capability;
    },
    closeSession(capability) {
      const record = handle(capability) && sessions.get(capability);
      if (!record) fail('ACCESS_DENIED');
      const wasLive = !record.retired; retire(record); return wasLive;
    },
    withReadContext(capability, reader) {
      const record = owned(capability);
      if (typeof reader !== 'function') fail('INVALID_READER');
      const context = authorize(record);
      const result = reader(context);
      // This rejects an asynchronous result, not effects already performed by
      // a trusted callback or a context that the trusted caller retained.
      if (result !== null && ['object', 'function'].includes(typeof result)) {
        let then;
        try { then = result.then; } catch { fail('INVALID_READER'); }
        if (typeof then === 'function') fail('INVALID_READER');
      }
      authorize(record);
      return result;
    }
  });
}

module.exports = {createPeerReadAuthority};
