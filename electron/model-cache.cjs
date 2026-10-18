'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./vault.cjs');

const MAX_TARGETS = 500;
const MAX_MODELS = 100;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERVAL_MINUTES = 60;
const CONCURRENCY = 3;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const READ_ERROR = '모델 정보를 불러오지 못했습니다. 다시 조회하십시오.';
const SAVE_ERROR = '모델 정보를 파일에 저장하지 못했습니다.';
const DEFAULT_ERROR = '모델 목록은 불러왔지만 기본 설정을 모두 읽지 못했습니다.';

function safeText(value, limit, fallback = '') {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) return fallback;
  return value.trim() || fallback;
}
function modelId(value) {
  const result = safeText(value, 256);
  return /\s/.test(result) ? '' : result;
}
function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), result = [];
  for (const row of value.slice(0, 500)) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.hidden === true || row.visibility === 'hidden') continue;
    const id = modelId(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reasoning = Array.isArray(row.reasoning) ? [...new Set(row.reasoning.slice(0, 32).filter(level => EFFORTS.has(level)))] : [];
    result.push({ id, label: safeText(row.label, 256, id), reasoning,
      defaultReasoningEffort: reasoning.includes(row.defaultReasoningEffort) ? row.defaultReasoningEffort : '' });
    if (result.length === MAX_MODELS) break;
  }
  return result;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}
function intervalValue(value) {
  if (!Number.isSafeInteger(value) || value < 5 || value > 1440) throw new Error('모델 목록 수집 주기는 5~1440분 사이의 정수로 입력하십시오.');
  return value;
}
function entryFor(target, saved) {
  const models = normalizeModels(saved?.models), cachedAt = timestamp(saved?.cachedAt), failedAt = timestamp(saved?.failedAt);
  return { id: target.id, label: target.label, signature: target.signature, generation: Symbol(target.id), models,
    defaultModel: modelId(saved?.defaultModel), defaultReasoningEffort: EFFORTS.has(saved?.defaultReasoningEffort) ? saved.defaultReasoningEffort : '',
    cachedAt, lastAttemptAt: timestamp(saved?.lastAttemptAt), failedAt, refreshing: false, metadata: {},
    status: failedAt ? (models.length || cachedAt ? 'stale' : 'error') : !cachedAt && models.length ? 'stale' : cachedAt ? 'ready' : 'empty',
    error: failedAt ? READ_ERROR : '' };
}

function createModelCache({ dataPath, listTargets, collect, onChange = () => {}, now = Date.now }) {
  if (typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) throw new Error('모델 정보 저장 폴더의 전체 경로가 필요합니다.');
  if (typeof listTargets !== 'function' || typeof collect !== 'function' || typeof now !== 'function') throw new Error('모델 정보 조회 설정이 올바르지 않습니다.');
  const filename = path.join(dataPath, 'model-cache.json');
  const entries = new Map(), targets = new Map(), pending = new Map();
  let intervalMinutes = DEFAULT_INTERVAL_MINUTES, timer = null, started = false, closed = false, active = 0, queue = [], storageError = '';
  const stamp = () => { const value = now(); return new Date(value instanceof Date ? value.getTime() : value).toISOString(); };

  function readDisk() {
    let descriptor;
    try {
      if (fs.lstatSync(filename).isSymbolicLink()) return [];
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > MAX_CACHE_BYTES) return [];
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const size = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!size) return [];
        offset += size;
      }
      if (fs.fstatSync(descriptor).size !== info.size) return [];
      const value = JSON.parse(bytes.toString('utf8'));
      if (value?.schema !== 1 || !Array.isArray(value.targets) || value.targets.length > MAX_TARGETS) return [];
      try { intervalMinutes = intervalValue(value.intervalMinutes); } catch { /* Use the default for an invalid saved setting. */ }
      return value.targets.filter(row => row && typeof row === 'object' && !Array.isArray(row)
        && safeText(row.id, 256) === row.id && /^[a-f0-9]{64}$/.test(row.signature));
    } catch { return []; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  const saved = new Map(readDisk().map(row => [row.id, row]));

  function currentTargets() {
    const value = listTargets();
    if (!Array.isArray(value)) throw new Error('모델 정보를 조회할 호스트 목록이 올바르지 않습니다.');
    const result = new Map();
    for (const row of value.slice(0, MAX_TARGETS)) {
      const id = safeText(row?.id, 256), signature = typeof row?.signature === 'string' && row.signature.length <= 65536 ? row.signature : '';
      if (!id || !signature || result.has(id)) continue;
      result.set(id, { id, label: safeText(row.label, 256, id), signature,
        signatureHash: /^[a-f0-9]{64}$/.test(signature) ? signature : crypto.createHash('sha256').update(signature).digest('hex'),
        config: row.config, settings: row.settings });
    }
    return result;
  }
  function writeDisk() {
    if (closed) return;
    const value = { schema: 1, intervalMinutes, targets: [...entries.values()].map(entry => ({
      id: entry.id, label: entry.label, signature: entry.signature, models: entry.models,
      defaultModel: entry.defaultModel, defaultReasoningEffort: entry.defaultReasoningEffort,
      cachedAt: entry.cachedAt, lastAttemptAt: entry.lastAttemptAt, failedAt: entry.failedAt,
    })) };
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_CACHE_BYTES) throw new Error(SAVE_ERROR);
    atomicWrite(filename, bytes);
    storageError = '';
  }
  function saveQuietly() {
    try { writeDisk(); } catch { storageError = SAVE_ERROR; }
  }
  function get(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    const error = entry.error || storageError;
    return { id: entry.id, label: entry.label, ...entry.metadata,
      models: entry.models.map(model => ({ ...model, reasoning: [...model.reasoning] })),
      defaultModel: entry.defaultModel, defaultReasoningEffort: entry.defaultReasoningEffort,
      modelSource: entry.models.length ? 'cache' : 'none', modelError: error,
      cachedAt: entry.cachedAt, updatedAt: entry.cachedAt, lastAttemptAt: entry.lastAttemptAt,
      refreshing: entry.refreshing, cacheStatus: entry.refreshing ? 'refreshing' : entry.status, error };
  }
  function snapshot() {
    return { intervalMinutes, refreshing: pending.size > 0,
      targets: [...entries.keys()].map(id => { const value = get(id); return { id: value.id, label: value.label, models: value.models,
        updatedAt: value.cachedAt, cachedAt: value.cachedAt, lastAttemptAt: value.lastAttemptAt, refreshing: value.refreshing,
        status: value.cacheStatus, error: value.error, defaultModel: value.defaultModel, defaultReasoningEffort: value.defaultReasoningEffort }; }) };
  }
  function emit() {
    if (!closed) try { onChange(snapshot()); } catch { /* A listener cannot interrupt cache maintenance. */ }
  }
  function validTask(task) {
    return !closed && entries.get(task.id)?.generation === task.generation;
  }
  function finishTask(task) {
    if (pending.get(task.id) === task) pending.delete(task.id);
    task.resolve(get(task.id));
  }
  function discardInvalidTasks() {
    queue = queue.filter(task => { if (validTask(task)) return true; finishTask(task); return false; });
    for (const [id, task] of pending) if (!validTask(task)) { pending.delete(id); task.resolve(get(id)); }
  }
  function enqueue(id) {
    const entry = entries.get(id);
    if (!entry || closed) return Promise.resolve(get(id));
    const existing = pending.get(id);
    if (existing?.generation === entry.generation) return existing.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const task = { id, generation: entry.generation, target: targets.get(id), entry, promise, resolve };
    entry.refreshing = true; pending.set(id, task); queue.push(task); emit(); drain();
    return promise;
  }
  function applyResult(entry, value, failed) {
    const models = normalizeModels(value?.models);
    entry.metadata = {};
    for (const key of ['installed', 'loggedIn']) if (typeof value?.[key] === 'boolean') entry.metadata[key] = value[key];
    if (safeText(value?.version, 160)) entry.metadata.version = safeText(value.version, 160);
    if (['authenticated', 'not_authenticated', 'not_installed', 'unknown'].includes(value?.authState)) entry.metadata.authState = value.authState;
    const usable = Array.isArray(value?.models) && (!value.models.length || models.length > 0);
    const unavailable = failed || !usable || value?.installed === false || value?.modelSource === 'none'
      || value?.modelSource === 'manual' || (value?.modelSource === 'cache' && Boolean(value?.modelError));
    if (unavailable) {
      if (!entry.cachedAt && !entry.models.length && value?.modelSource === 'cache' && models.length) {
        entry.models = models; entry.defaultModel = modelId(value.defaultModel);
        entry.defaultReasoningEffort = EFFORTS.has(value.defaultReasoningEffort) ? value.defaultReasoningEffort : '';
      }
      entry.failedAt = stamp(); entry.status = entry.models.length || entry.cachedAt ? 'stale' : 'error'; entry.error = READ_ERROR;
      return;
    }
    entry.models = models; entry.defaultModel = modelId(value.defaultModel);
    entry.defaultReasoningEffort = EFFORTS.has(value.defaultReasoningEffort) ? value.defaultReasoningEffort : '';
    entry.cachedAt = stamp(); entry.failedAt = null; entry.status = 'ready';
    entry.error = value?.modelError ? DEFAULT_ERROR : '';
  }
  function drain() {
    while (!closed && active < CONCURRENCY && queue.length) {
      const task = queue.shift();
      if (!validTask(task)) { finishTask(task); continue; }
      active++; task.entry.lastAttemptAt = stamp();
      Promise.resolve().then(() => validTask(task) ? collect({ id: task.target.id, label: task.target.label, signature: task.target.signature,
        config: task.target.config, settings: task.target.settings }) : null)
        .then(value => { if (validTask(task)) applyResult(task.entry, value, false); }, () => { if (validTask(task)) applyResult(task.entry, null, true); })
        .finally(() => {
          active--;
          const current = validTask(task);
          if (current) { task.entry.refreshing = false; saveQuietly(); }
          finishTask(task); if (current) emit(); drain();
        });
    }
  }
  function reconcileTargets(initial = false) {
    const next = currentTargets(), changed = [];
    let dirty = false;
    for (const [id, entry] of entries) if (!next.has(id)) { entries.delete(id); dirty = true; }
    for (const [id, target] of next) {
      const previous = entries.get(id);
      if (!previous || previous.signature !== target.signatureHash) {
        const restored = initial && saved.get(id)?.signature === target.signatureHash ? saved.get(id) : null;
        entries.set(id, entryFor({ ...target, signature: target.signatureHash }, restored)); changed.push(id); dirty = true;
      } else if (previous.label !== target.label) { previous.label = target.label; dirty = true; }
    }
    targets.clear(); for (const [id, target] of next) targets.set(id, target);
    discardInvalidTasks();
    if (!initial && dirty) { saveQuietly(); emit(); }
    if (started) for (const id of changed) enqueue(id);
    return snapshot();
  }
  function resetTimer() {
    clearInterval(timer); timer = null;
    if (started && !closed) { timer = setInterval(() => { manager.refresh().catch(() => {}); }, intervalMinutes * 60 * 1000); timer.unref?.(); }
  }
  const manager = {
    get, snapshot,
    start() {
      if (closed || started) return Promise.resolve(snapshot());
      started = true; resetTimer(); return manager.refresh();
    },
    configure({ intervalMinutes: requested } = {}) {
      if (closed) throw new Error('모델 정보 조회가 종료되었습니다.');
      const previous = intervalMinutes;
      intervalMinutes = intervalValue(requested);
      try { writeDisk(); } catch { intervalMinutes = previous; storageError = SAVE_ERROR; throw new Error(SAVE_ERROR); }
      resetTimer(); emit(); return snapshot();
    },
    refresh(id) {
      if (closed) return Promise.resolve(id === undefined ? snapshot() : get(id));
      try { reconcileTargets(); } catch { return Promise.reject(new Error('모델 정보를 조회할 호스트 목록을 읽지 못했습니다.')); }
      if (id !== undefined) return entries.has(id) ? enqueue(id) : Promise.reject(new Error('모델 정보를 조회할 호스트를 찾지 못했습니다.'));
      return Promise.all([...entries.keys()].map(enqueue)).then(snapshot);
    },
    invalidate(id) {
      if (closed) return Promise.resolve(get(id));
      try { reconcileTargets(); } catch { return Promise.reject(new Error('모델 정보를 조회할 호스트 목록을 읽지 못했습니다.')); }
      const target = targets.get(id);
      if (!target) return Promise.reject(new Error('모델 정보를 조회할 호스트를 찾지 못했습니다.'));
      entries.set(id, entryFor({ ...target, signature: target.signatureHash }, null));
      discardInvalidTasks(); saveQuietly();
      return enqueue(id);
    },
    reconcile() { return closed ? snapshot() : reconcileTargets(); },
    close() {
      if (closed) return;
      closed = true; clearInterval(timer); timer = null; queue = [];
      for (const entry of entries.values()) entry.refreshing = false;
      for (const task of pending.values()) task.resolve(get(task.id));
      pending.clear();
    },
  };
  reconcileTargets(true);
  return manager;
}

module.exports = { createModelCache };
