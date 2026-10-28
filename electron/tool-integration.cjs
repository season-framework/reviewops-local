'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const MAX_BYTES = 512 * 1024;
const REQUEST_FIELDS = new Set(['requestId', 'projectId', 'workspacePath', 'serviceId', 'reviewId', 'title', 'body', 'tool']);
const STATES = new Set(['pending', 'needs_project', 'opening', 'shown', 'display_failed']);
const fail = (message, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), { code }); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON 객체로 요청하십시오.'); };
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`${name}이 올바르지 않습니다.`);
  return value;
}
function text(value, name, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || required && !value.trim()) fail(`${name}이 올바르지 않습니다.`);
  return value;
}
function normalizeRequest(value) {
  object(value);
  if (Object.keys(value).some(key => !REQUEST_FIELDS.has(key))) fail('지원하지 않는 요청 항목이 있습니다.');
  const result = { requestId: identifier(value.requestId, '요청 ID') };
  if (value.projectId !== undefined) result.projectId = identifier(value.projectId, '프로젝트 ID');
  if (value.workspacePath !== undefined) {
    result.workspacePath = text(value.workspacePath, '작업 폴더', 4096, true);
    if (!path.isAbsolute(result.workspacePath)) fail('작업 폴더는 전체 경로로 지정하십시오.');
  }
  if (result.projectId && result.workspacePath) fail('프로젝트 ID 또는 작업 폴더 중 하나만 지정하십시오.');
  if (value.serviceId !== undefined) result.serviceId = identifier(value.serviceId, '연결 ID');
  if (value.reviewId !== undefined) {
    result.reviewId = identifier(value.reviewId, '리뷰 ID');
    if (value.title !== undefined || value.body !== undefined) fail('기존 리뷰 ID와 새 리뷰 내용을 함께 지정할 수 없습니다.');
  } else {
    result.title = text(value.title, '리뷰 제목', 300, true);
    result.body = text(value.body ?? '', '리뷰 내용', 100000);
  }
  if (value.tool !== undefined) result.tool = text(value.tool, '요청 도구 이름', 80, true);
  return result;
}
const fingerprint = payload => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function toolSocketPath(dataPath, platform = process.platform) {
  const resolved = platform === 'win32' ? path.win32.resolve(dataPath).toLowerCase() : path.resolve(dataPath);
  if (platform === 'win32') return `\\\\.\\pipe\\reviewops-tools-${crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 32)}`;
  const socketPath = path.join(resolved, 'integrations', 'tools.sock');
  if (Buffer.byteLength(socketPath) > 103) fail('앱 데이터 경로가 너무 길어 외부 도구 연결을 열 수 없습니다.', 'SOCKET_PATH_TOO_LONG');
  return socketPath;
}
function linkedServices(snapshot, project) {
  const ids = Array.isArray(project.serviceIds) ? project.serviceIds : project.connection?.id ? [project.connection.id] : [];
  return [...new Set(ids)].map(id => snapshot.services.find(service => service.id === id && service.groupId === project.groupId)).filter(Boolean);
}
async function localPath(service) {
  const value = service.agentWorkPath || service.rootPath;
  if (service.kind !== 'local' || typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { const real = await fs.realpath(value); return (await fs.stat(real)).isDirectory() ? real : null; } catch { return null; }
}
const publicRecord = record => ({ requestId: record.payload.requestId, status: record.status, payload: structuredClone(record.payload),
  projectId: record.projectId || null, serviceId: record.serviceId || null, reviewId: record.reviewId || null,
  windowId: record.windowId ?? null, shown: record.status === 'shown', message: record.message || '', createdAt: record.createdAt, updatedAt: record.updatedAt });

async function createToolIntegration({ dataPath, dispatch, showReview, platform = process.platform, displayTimeoutMs = 20000 } = {}) {
  if (!path.isAbsolute(dataPath || '') || typeof dispatch !== 'function' || typeof showReview !== 'function') fail('외부 도구 연결 설정이 올바르지 않습니다.');
  const directory = path.join(dataPath, 'integrations');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  const socketPath = toolSocketPath(dataPath, platform), connectionPath = path.join(directory, 'tools.json'), statePath = path.join(directory, 'tools-state.json');
  const records = new Map(), inFlight = new Map();
  let closed = false, queue = Promise.resolve();
  const exclusive = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const save = async () => {
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ version: 1, requests: [...records.values()] }), { mode: 0o600 }); await fs.rename(temporary, statePath); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  const update = (record, status, message = '') => { record.status = status; record.message = message; record.updatedAt = new Date().toISOString(); if (status !== 'shown') record.windowId = null; };
  try {
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.requests)) fail('외부 요청 기록 형식이 올바르지 않습니다.', 'INVALID_STATE');
    for (const record of saved.requests) {
      object(record); const payload = normalizeRequest(record.payload);
      if (records.has(payload.requestId) || record.fingerprint !== fingerprint(payload) || !STATES.has(record.status)) fail('외부 요청 기록이 올바르지 않습니다.', 'INVALID_STATE');
      for (const field of ['projectId', 'serviceId', 'reviewId']) if (record[field]) identifier(record[field], field);
      record.payload = payload;
      if (['opening', 'shown', 'pending'].includes(record.status)) update(record, 'display_failed', '앱이 다시 시작되었습니다. 같은 요청 ID와 내용으로 다시 열 수 있습니다.');
      records.set(payload.requestId, record);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (records.size) await save();

  async function resolveTarget(payload, snapshot) {
    if (!payload.projectId && !payload.workspacePath) return { message: '프로젝트 ID 또는 작업 폴더를 지정하십시오.' };
    let candidates;
    if (payload.projectId) {
      const project = snapshot.projects.find(item => item.id === payload.projectId);
      if (!project) return { message: '지정한 프로젝트를 찾을 수 없습니다.' };
      const services = linkedServices(snapshot, project);
      const review = payload.reviewId && snapshot.reviews.find(item => item.id === payload.reviewId && item.projectId === project.id);
      const selectedId = payload.serviceId || review?.serviceId;
      if (payload.serviceId && review?.serviceId && payload.serviceId !== review.serviceId) return { message: '지정한 연결이 기존 리뷰의 연결과 다릅니다.' };
      if (selectedId) {
        const service = services.find(item => item.id === selectedId);
        if (!service) return { message: '지정한 연결이 이 프로젝트에 속하지 않습니다.' };
        candidates = [{ project, service }];
      } else if (services.length > 1) return { message: '프로젝트에 연결이 여러 개 있습니다. 연결 ID를 지정하십시오.' };
      else candidates = [{ project, service: services[0] || null }];
    } else {
      let requested;
      try { requested = await fs.realpath(payload.workspacePath); if (!(await fs.stat(requested)).isDirectory()) throw new Error(); }
      catch { return { message: '지정한 작업 폴더를 읽을 수 없습니다. 프로젝트를 확인하십시오.' }; }
      candidates = [];
      for (const project of snapshot.projects) for (const service of linkedServices(snapshot, project)) {
        if (payload.serviceId && service.id !== payload.serviceId) continue;
        if (await localPath(service) === requested) candidates.push({ project, service });
      }
      if (candidates.length !== 1) return { message: candidates.length ? '이 작업 폴더에 연결된 프로젝트가 여러 개입니다. 프로젝트 ID와 연결 ID를 지정하십시오.' : '이 작업 폴더에 연결된 로컬 프로젝트를 찾을 수 없습니다.' };
    }
    const { project, service } = candidates[0];
    const review = payload.reviewId ? snapshot.reviews.find(item => item.id === payload.reviewId) : null;
    if (payload.reviewId && (!review || review.projectId !== project.id || review.serviceId && review.serviceId !== service?.id)) return { message: '기존 리뷰와 지정한 프로젝트 또는 연결이 일치하지 않습니다.' };
    const configuredPath = service?.agentWorkPath || service?.rootPath || '';
    if (typeof configuredPath !== 'string' || configuredPath.length > 4096 || configuredPath.includes('\0')) return { message: '프로젝트의 작업 폴더 설정이 올바르지 않습니다.' };
    const realPath = service?.kind === 'local' ? await localPath(service) : null;
    // An explicit project opens a review without starting work. Keep unavailable
    // paths as stored; resolving a relative value against this process is unsafe.
    const workPath = service?.kind === 'local' ? realPath ?? (payload.projectId ? configuredPath : null) : configuredPath;
    if (service?.kind === 'local' && workPath === null) return { message: '프로젝트 작업 폴더를 읽을 수 없습니다. 연결 설정을 확인하십시오.' };
    const remote = service?.kind === 'ssh';
    return { project, service, review, binding: { projectId: project.id, serviceId: service?.id || null, kind: service?.kind || 'none', workPath: workPath || '',
      host: remote ? service.host || '' : '', hostAlias: remote ? service.hostAlias || '' : '', port: remote ? service.port || 22 : 0,
      username: remote ? service.username || '' : '', sshConfigPath: remote ? service.sshConfigPath || '' : '' } };
  }

  async function prepare(payload, hash) {
    let record = records.get(payload.requestId);
    if (record && record.fingerprint !== hash) fail('이미 사용한 요청 ID입니다. 내용을 바꾸려면 새 요청 ID를 사용하십시오.', 'REQUEST_ID_CONFLICT');
    const snapshot = await dispatch('snapshot');
    const matches = payload.reviewId ? [] : snapshot.reviews.filter(review => review.evidence?.toolIntegration?.requestId === payload.requestId);
    if (matches.some(review => review.evidence.toolIntegration.fingerprint !== hash)) fail('이미 사용한 요청 ID입니다. 내용을 바꾸려면 새 요청 ID를 사용하십시오.', 'REQUEST_ID_CONFLICT');
    if (matches.length > 1) fail('같은 요청 ID가 여러 리뷰에 저장되어 있습니다. 리뷰 기록을 확인하십시오.', 'REQUEST_ID_CONFLICT');
    if (!record) {
      const timestamp = new Date().toISOString();
      record = { payload, fingerprint: hash, status: 'pending', reviewId: null, projectId: null, serviceId: null, binding: null, createdAt: timestamp, updatedAt: timestamp };
      records.set(payload.requestId, record); await save();
    }
    const target = await resolveTarget(payload, snapshot);
    if (target.message) { update(record, 'needs_project', target.message); await save(); return { record }; }
    if (record.binding && JSON.stringify(record.binding) !== JSON.stringify(target.binding)) {
      update(record, 'needs_project', '프로젝트 연결이나 작업 폴더가 변경되었습니다. 대상을 확인하고 새 요청 ID를 사용하십시오.'); await save(); return { record };
    }
    const existing = record.reviewId ? snapshot.reviews.find(review => review.id === record.reviewId) : target.review || matches[0];
    if (record.reviewId && !existing) { update(record, 'needs_project', '저장된 리뷰가 삭제되었습니다. 새 요청 ID로 요청하십시오.'); await save(); return { record }; }
    if (existing && (existing.projectId !== target.project.id || existing.serviceId && existing.serviceId !== target.service?.id)) {
      update(record, 'needs_project', '저장된 리뷰의 프로젝트 또는 연결이 변경되었습니다. 새 요청 ID로 요청하십시오.'); await save(); return { record };
    }
    record.projectId = target.project.id; record.serviceId = target.service?.id || null; record.binding = target.binding;
    const review = existing || await dispatch('review.save', { projectId: record.projectId, serviceId: record.serviceId,
      title: payload.title, body: payload.body, category: 'other', status: 'open',
      evidence: { toolIntegration: { version: 1, requestId: payload.requestId, fingerprint: hash, tool: payload.tool || '' } } });
    record.reviewId = review.id;
    update(record, 'opening'); await save();
    return { record, display: { projectId: record.projectId, reviewId: record.reviewId, fullscreen: false } };
  }

  async function open(payload, hash) {
    let prepared;
    try { prepared = await exclusive(() => prepare(payload, hash)); }
    catch (error) {
      if (error.code === 'REQUEST_ID_CONFLICT') throw error;
      return exclusive(async () => {
        const record = records.get(payload.requestId); if (!record) throw error;
        update(record, 'display_failed', `리뷰를 준비하지 못했습니다. 같은 요청 ID로 다시 시도하십시오. ${String(error.message).slice(0, 500)}`); await save(); return publicRecord(record);
      });
    }
    if (!prepared.display) return publicRecord(prepared.record);
    let result, displayError, timer;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => showReview(prepared.display)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('작업 창을 여는 시간이 초과되었습니다.')), displayTimeoutMs); timer.unref?.(); })
      ]);
      if (!result?.shown || result.projectId !== prepared.display.projectId || result.reviewId !== prepared.display.reviewId || typeof result.windowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.windowId)) throw new Error('요청한 리뷰의 작업 창이 표시되지 않았습니다.');
    } catch (error) { displayError = error; } finally { clearTimeout(timer); }
    return exclusive(async () => {
      const record = records.get(payload.requestId);
      if (closed) return publicRecord(record);
      update(record, displayError ? 'display_failed' : 'shown', displayError ? String(displayError.message).slice(0, 1000) : '프로젝트 작업 창을 열었습니다.');
      if (!displayError) record.windowId = result.windowId;
      await save(); return publicRecord(record);
    });
  }
  function handle(action, payload = {}) {
    if (closed) return Promise.reject(Object.assign(new Error('외부 도구 연결이 종료되었습니다.'), { code: 'CLOSED' }));
    object(payload);
    if (action === 'projects.list') return exclusive(async () => {
      const snapshot = await dispatch('snapshot');
      return snapshot.projects.map(project => {
        const services = linkedServices(snapshot, project);
        const connections = services.map(service => ({ id: service.id, name: service.name, kind: service.kind, workPath: service.agentWorkPath || service.rootPath || '' }));
        return { id: project.id, name: project.name, kind: services.length === 1 ? services[0].kind : services.length ? 'multiple' : 'none',
          workPath: services.length === 1 ? services[0].agentWorkPath || services[0].rootPath || '' : '', connections };
      });
    });
    if (action === 'review.status') {
      const id = identifier(payload.requestId, '요청 ID');
      return exclusive(() => { const record = records.get(id); if (!record) fail('요청 ID에 해당하는 기록이 없습니다.', 'NOT_FOUND'); return publicRecord(record); });
    }
    if (action !== 'review.open') return Promise.reject(Object.assign(new Error('지원하지 않는 외부 요청입니다.'), { code: 'UNKNOWN_ACTION' }));
    const request = normalizeRequest(payload), hash = fingerprint(request), current = inFlight.get(request.requestId);
    if (current) {
      if (current.hash !== hash) fail('이미 사용한 요청 ID입니다. 내용을 바꾸려면 새 요청 ID를 사용하십시오.', 'REQUEST_ID_CONFLICT');
      return current.promise;
    }
    const promise = open(request, hash); inFlight.set(request.requestId, { hash, promise });
    promise.finally(() => { if (inFlight.get(request.requestId)?.promise === promise) inFlight.delete(request.requestId); }).catch(() => {});
    return promise;
  }

  const token = crypto.randomBytes(32).toString('hex'), connections = new Set();
  if (platform !== 'win32') {
    try { const existing = await fs.lstat(socketPath); if (!existing.isSocket()) fail('외부 도구 소켓 위치에 다른 파일이 있습니다.', 'INVALID_SOCKET'); await fs.rm(socketPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const server = net.createServer(socket => {
    connections.add(socket); socket.setEncoding('utf8'); socket.setTimeout(45000, () => socket.destroy());
    socket.on('close', () => connections.delete(socket)); socket.on('error', () => {});
    let input = '', accepted = false;
    const reply = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
    socket.on('data', chunk => {
      if (accepted) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_BYTES) { accepted = true; reply({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 내용이 너무 큽니다.' } }); return; }
      const end = input.indexOf('\n'); if (end < 0) return; accepted = true;
      let request;
      try {
        request = JSON.parse(input.slice(0, end));
        if (!request || !/^[a-f0-9]{64}$/.test(request.token || '') || !crypto.timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw new Error();
      } catch { reply({ ok: false, error: { code: 'UNAUTHORIZED', message: '허용되지 않은 연결입니다.' } }); return; }
      Promise.resolve().then(() => handle(request.action, request.payload || {})).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: { code: error.code || 'REQUEST_FAILED', message: String(error.message).slice(0, 1000) } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    if (platform !== 'win32') await fs.chmod(socketPath, 0o600);
    await fs.writeFile(connectionPath, JSON.stringify({ version: 1, socketPath, token, pid: process.pid }), { mode: 0o600 }); await fs.chmod(connectionPath, 0o600);
  } catch (error) { await new Promise(resolve => server.close(resolve)); if (platform !== 'win32') await fs.rm(socketPath, { force: true }); throw error; }
  return { handle, connectionPath, close: async () => {
    if (closed) return;
    closed = true; for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await exclusive(async () => {
      for (const record of records.values()) if (record.status === 'opening' || record.status === 'pending') update(record, 'display_failed', '앱이 종료되었습니다. 같은 요청 ID와 내용으로 다시 열 수 있습니다.');
      await save();
    });
    await fs.rm(connectionPath, { force: true }); if (platform !== 'win32') await fs.rm(socketPath, { force: true });
  } };
}
module.exports = { createToolIntegration, toolSocketPath };
