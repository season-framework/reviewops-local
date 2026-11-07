'use strict';

const {createPeerReadStoreBridge} = require('./store.cjs');
const {createPeerReadAuthority} = require('./peer-read-authority.cjs');

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_GRANTS = 1000;
const MAX_PEERS = 64;
const MESSAGES = Object.freeze({
  INVALID_AUTHORITY_CONFIG: 'Peer read authority is unavailable.',
  INVALID_AUTHORITY_REQUEST: 'Invalid peer read authority request.',
  ACCESS_DENIED: 'Peer read access is unavailable.',
  AUTHORITY_LIMIT_EXCEEDED: 'Peer read authority limit exceeded.',
  INVALID_QUERY: 'Invalid shared-data query.'
});
const handle = value => value !== null && ['object', 'function'].includes(typeof value);
const token = () => Object.freeze(Object.create(null));
function fail(code) { throw Object.assign(new Error(MESSAGES[code]), {code}); }
function captureRecord(value, keys, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const actual = Reflect.ownKeys(value), result = Object.create(null);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}
function captureApproval(input) {
  const request = captureRecord(input, ['projectIds'], 'INVALID_AUTHORITY_REQUEST');
  const values = request.projectIds;
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) fail('INVALID_AUTHORITY_REQUEST');
  const length = Object.getOwnPropertyDescriptor(values, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > MAX_GRANTS || Reflect.ownKeys(values).length !== length.value + 1) fail('INVALID_AUTHORITY_REQUEST');
  const captured = [], seen = new Set();
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' ||
        !ID.test(descriptor.value) || seen.has(descriptor.value)) fail('INVALID_AUTHORITY_REQUEST');
    seen.add(descriptor.value); captured.push(descriptor.value);
  }
  return Object.freeze({projectIds: Object.freeze(captured)});
}
function captureQuery(operation, payload) {
  const keys = operation === 'projects.list' ? [] : operation === 'reviews.list' ? ['projectId'] :
    ['reviews.get','reviews.timeline'].includes(operation) ? ['projectId', 'reviewId'] : null;
  if (!keys) fail('INVALID_QUERY');
  const captured = captureRecord(payload, keys, 'INVALID_QUERY');
  for (const key of keys) if (typeof captured[key] !== 'string' || !ID.test(captured[key])) fail('INVALID_QUERY');
  return Object.freeze({operation, payload: Object.freeze(captured)});
}

// Application-only composition. The trusted verifier recognizes an original
// identity handle; this module supplies no TLS, keys, listener or wire methods.
function createPeerReadBrowsing(options) {
  if (arguments.length !== 1) fail('INVALID_AUTHORITY_CONFIG');
  const {store, verifyPeerHandle} = captureRecord(options, ['store', 'verifyPeerHandle'], 'INVALID_AUTHORITY_CONFIG');
  if (typeof verifyPeerHandle !== 'function') fail('INVALID_AUTHORITY_CONFIG');
  const owner = token(), bindings = new Map(), capabilities = new WeakMap();
  let enabled = false, activation = token(), retired = false, closeAttempted = false, closed = false;
  let pending = null, scope = null, core;

  function available() { if (retired) fail('ACCESS_DENIED'); }
  function begin(kind, peer = null, capability = null) {
    available();
    if (pending) fail('INVALID_AUTHORITY_REQUEST');
    const operation = {kind, peer, capability, binding: null, cancelled: false, phase: 'capture'};
    pending = operation;
    return operation;
  }
  function current(operation) {
    if (retired || pending !== operation || operation.cancelled) fail('ACCESS_DENIED');
  }
  function finish(operation) {
    operation.phase = 'expired';
    if (pending === operation) pending = null;
  }
  function cancelPeer(peer) { if (pending && pending.peer === peer) pending.cancelled = true; }
  function removeBinding(peer, binding) {
    binding.retired = true;
    if (bindings.get(peer) === binding) bindings.delete(peer);
    if (pending && pending.binding === binding) pending.cancelled = true;
    return core.revokePeer(peer);
  }
  function synchronize(operation, dataset) {
    current(operation);
    const existing = new Map(dataset.projects.map(project => [project.projectId, project.birth]));
    for (const [peer, binding] of bindings) {
      if (binding.store !== store || binding.epoch !== dataset.epoch ||
          binding.projects.some(project => existing.get(project.projectId) !== project.birth)) removeBinding(peer, binding);
    }
    current(operation);
    return existing;
  }
  function published(binding) {
    return binding && !binding.retired && binding.store === store && bindings.get(binding.peer) === binding;
  }
  function known(capability) {
    const record = handle(capability) && capabilities.get(capability);
    if (!record || record.owner !== owner) fail('ACCESS_DENIED');
    return record;
  }
  function live(record) {
    available();
    if (!enabled || record.closed || !published(record.binding) || record.activation !== activation ||
        record.verification !== record.binding.verification) fail('ACCESS_DENIED');
  }
  function checkSession(operation, record) {
    current(operation); live(record);
    if (operation.binding !== record.binding || operation.peer !== record.peer) fail('ACCESS_DENIED');
  }
  function scopeAllowed(operation, kind) {
    return kind === 'admission' && ['approve', 'open'].includes(operation.kind) && operation.phase === 'admission' ||
      kind === 'content' && operation.kind === 'query' && operation.phase === 'content' ||
      kind === 'release' && operation.kind === 'query' && operation.phase === 'release';
  }
  function withScope(operation, kind, dataset, action) {
    current(operation);
    if (scope || !scopeAllowed(operation, kind)) fail('ACCESS_DENIED');
    const original = Object.freeze({owner, store, operation, kind, phase: operation.phase,
      dataset: Object.freeze({epoch: dataset.epoch,
        projectIds: Object.freeze(dataset.projects.map(project => project.projectId))})});
    scope = original;
    try { current(operation); return action(); }
    finally { if (scope === original) scope = null; }
  }
  function currentDataset() {
    const original = scope;
    if (!original || original.owner !== owner || original.store !== store ||
        original.operation !== pending || original.phase !== original.operation.phase ||
        !scopeAllowed(original.operation, original.kind)) fail('ACCESS_DENIED');
    current(original.operation);
    return original.dataset;
  }
  function delegatedVerifier(peer) {
    let result;
    try { result = Reflect.apply(verifyPeerHandle, undefined, [peer]); }
    catch (error) {
      const binding = bindings.get(peer);
      if (binding) binding.verification = token();
      cancelPeer(peer);
      throw error;
    }
    if (result !== true) {
      const binding = bindings.get(peer);
      if (binding) binding.verification = token();
      cancelPeer(peer);
    }
    return result;
  }
  const bridge = createPeerReadStoreBridge(store, view => {
    const operation = pending;
    if (!operation || operation.kind !== 'query' || operation.phase !== 'content') fail('ACCESS_DENIED');
    const dataset = view.dataset();
    synchronize(operation, dataset);
    checkSession(operation, operation.record);
    const result = withScope(operation, 'content', dataset, () => core.withReadContext(operation.record.inner,
      context => view.query(context, operation.request.operation, operation.request.payload)));
    checkSession(operation, operation.record);
    return result;
  });
  try { core = createPeerReadAuthority({verifyPeerHandle: delegatedVerifier, currentDataset}); }
  catch (primary) {
    try { bridge.retireAndClose(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], MESSAGES.ACCESS_DENIED, {cause: primary}); }
    throw primary;
  }

  return Object.freeze({
    setEnabled(value) {
      if (arguments.length !== 1 || typeof value !== 'boolean') fail('INVALID_AUTHORITY_REQUEST');
      available();
      if (value && pending) fail('INVALID_AUTHORITY_REQUEST');
      if (!value && pending) pending.cancelled = true;
      const previous = enabled;
      enabled = core.setEnabled(value);
      if (previous !== enabled) activation = token();
      return enabled;
    },
    approvePeer(peer, input) {
      if (arguments.length !== 2) fail('INVALID_AUTHORITY_REQUEST');
      const operation = begin('approve', peer);
      let changed = false, candidate, previous;
      try {
        if (!handle(peer)) fail('ACCESS_DENIED');
        const request = captureApproval(input);
        current(operation);
        operation.phase = 'sample';
        const dataset = bridge.sample();
        const existing = synchronize(operation, dataset);
        if (request.projectIds.some(projectId => !existing.has(projectId))) fail('ACCESS_DENIED');
        previous = bindings.get(peer);
        if (!previous && bindings.size >= MAX_PEERS) fail('AUTHORITY_LIMIT_EXCEEDED');
        candidate = {store, peer, epoch: dataset.epoch, retired: false, verification: token(),
          projects: Object.freeze(request.projectIds.map(projectId => Object.freeze({projectId, birth: existing.get(projectId)})))};
        operation.phase = 'admission';
        withScope(operation, 'admission', dataset, () => core.approvePeer(peer, request));
        changed = true;
        current(operation);
        if (previous) previous.retired = true;
        bindings.set(peer, candidate);
      } catch (primary) {
        if (changed) {
          if (previous) previous.retired = true;
          if (candidate) candidate.retired = true;
          if (bindings.get(peer) === previous || bindings.get(peer) === candidate) bindings.delete(peer);
          try { core.revokePeer(peer); }
          catch (cleanup) { throw new AggregateError([primary, cleanup], MESSAGES.ACCESS_DENIED, {cause: primary}); }
        }
        throw primary;
      } finally { finish(operation); }
    },
    revokePeer(peer) {
      if (arguments.length !== 1 || !handle(peer)) fail('INVALID_AUTHORITY_REQUEST');
      available(); cancelPeer(peer);
      const binding = bindings.get(peer);
      return binding ? removeBinding(peer, binding) : core.revokePeer(peer);
    },
    openSession(peer) {
      if (arguments.length !== 1) fail('INVALID_AUTHORITY_REQUEST');
      const operation = begin('open', peer);
      let inner;
      try {
        if (!handle(peer) || !enabled) fail('ACCESS_DENIED');
        const binding = bindings.get(peer);
        if (!published(binding)) fail('ACCESS_DENIED');
        operation.binding = binding;
        operation.phase = 'sample';
        const dataset = bridge.sample();
        synchronize(operation, dataset);
        operation.phase = 'admission';
        inner = withScope(operation, 'admission', dataset, () => core.openSession(peer));
        current(operation);
        if (!published(binding)) fail('ACCESS_DENIED');
        const capability = token();
        capabilities.set(capability, {owner, peer, inner, binding, activation,
          verification: binding.verification, closed: false});
        return capability;
      } catch (primary) {
        if (inner) {
          try { core.closeSession(inner); }
          catch (cleanup) { throw new AggregateError([primary, cleanup], MESSAGES.ACCESS_DENIED, {cause: primary}); }
        }
        throw primary;
      } finally { finish(operation); }
    },
    closeSession(capability) {
      if (arguments.length !== 1) fail('INVALID_AUTHORITY_REQUEST');
      available();
      const record = known(capability);
      if (pending && pending.capability === capability) pending.cancelled = true;
      if (record.closed) return false;
      record.closed = true;
      return core.closeSession(record.inner);
    },
    query(capability, operationName, payload) {
      if (arguments.length !== 3) fail('INVALID_QUERY');
      const operation = begin('query', null, capability);
      try {
        const record = known(capability);
        operation.record = record; operation.peer = record.peer; operation.binding = record.binding;
        operation.request = captureQuery(operationName, payload);
        checkSession(operation, record);
        operation.phase = 'content';
        const result = bridge.read();
        checkSession(operation, record);
        operation.phase = 'release-sample';
        const dataset = bridge.sample();
        synchronize(operation, dataset);
        checkSession(operation, record);
        operation.phase = 'release';
        const released = withScope(operation, 'release', dataset, () => core.withReadContext(record.inner, () => result));
        checkSession(operation, record);
        return released;
      } finally { finish(operation); }
    },
    retireAndClose() {
      if (arguments.length) fail('INVALID_AUTHORITY_REQUEST');
      if (pending) fail('INVALID_AUTHORITY_REQUEST');
      if (closed) return;
      if (closeAttempted) fail('ACCESS_DENIED');
      retired = true; enabled = false; activation = token();
      core.setEnabled(false);
      for (const [peer, binding] of bindings) removeBinding(peer, binding);
      closeAttempted = true;
      bridge.retireAndClose();
      closed = true;
    }
  });
}

module.exports = {createPeerReadBrowsing};
