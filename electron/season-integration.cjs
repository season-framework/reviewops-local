'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { constants } = require('node:fs');

async function resolveSeasonCodexBinary({ env = process.env, isExecutable = async filename => {
  try { await fs.access(filename, constants.X_OK); return (await fs.stat(filename)).isFile(); } catch { return false; }
} } = {}) {
  const candidates = [env.SEASON_CODEX_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex'];
  for (const filename of candidates) if (typeof filename === 'string' && path.isAbsolute(filename) && await isExecutable(filename)) return filename;
  return 'codex';
}
function localWorkspaceTime(date = new Date()) {
  const two = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('연결 요청 ID가 올바르지 않습니다.');
  return value;
};
const bounded = (value, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('연결 요청 내용이 올바르지 않습니다.');
  return value.trim();
};
const inside = (root, target) => target !== root && target.startsWith(root + path.sep);
const final = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const reviewUrl = id => `reviewops-local://review/${identifier(id)}`;
const publicJob = job => ({ id: job.id, reviewId: job.reviewId, status: job.status,
  response: String(job.response || '').slice(-32000), error: String(job.error || '').slice(0, 4000),
  progress: (job.progress || []).slice(-100), finishedAt: job.finishedAt,
  cancelRequested: !!job.cancelRequested, terminationConfirmed: job.terminationConfirmed === true });

// A same-user Unix socket, not a network API. Only integration-owned resources
// and the normal application operations are available through this endpoint.
async function createSeasonIntegration({ dataPath, workspaceRoot, dispatch, showReview, resolveAgentBinary = resolveSeasonCodexBinary, now = () => new Date() } = {}) {
  const directory = path.join(dataPath, 'integrations');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'season-ai.sock');
  if (Buffer.byteLength(socketPath) > 103) throw new Error('앱 데이터 경로가 너무 길어 Season AI 연결을 열 수 없습니다.');
  const statePath = path.join(directory, 'season-ai-state.json');
  const connectionPath = path.join(directory, 'season-ai.json');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { sessions: {} }; }
  if (!state || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw new Error('Season AI 연결 기록을 읽을 수 없습니다.');
  const token = crypto.randomBytes(32).toString('hex');
  const save = async () => {
    const temp = `${statePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, statePath);
  };
  const ownedSession = sessionId => {
    const session = state.sessions[identifier(sessionId)];
    if (!session?.projectId) throw new Error('Season AI에서 생성한 작업 공간이 아닙니다.');
    return session;
  };
  const ownedReview = (sessionId, id) => {
    const session = ownedSession(sessionId);
    if (!Object.values(session.reviews || {}).includes(identifier(id))) throw new Error('Season AI에서 등록한 리뷰가 아닙니다.');
    return session;
  };
  const context = (sessionId, session) => ({ sessionId, groupId: session.groupId, serviceId: session.serviceId, projectId: session.projectId,
    workspacePath: session.workspacePath, previewUrl: session.previewUrl, authenticationSyncRequired: false, kind: 'local' });
  async function handle(action, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('연결 요청 형식이 올바르지 않습니다.');
    if (action === 'capabilities') return { version: 1, kind: 'reviewops-local', workHistory: true, localExecution: true, projectPresentation: true };
    if (action === 'prepare') {
      const sessionId = identifier(payload.sessionId);
      const root = await fs.realpath(workspaceRoot);
      const workspacePath = await fs.realpath(bounded(payload.runtime?.workspacePath, 4096));
      if (!inside(root, workspacePath) || !(await fs.stat(workspacePath)).isDirectory()) throw new Error('Season AI 전용 작업 폴더만 연결할 수 있습니다.');
      const preview = new URL(payload.runtime?.previewUrl);
      if (preview.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(preview.hostname) || preview.username || preview.password || preview.search || preview.hash) throw new Error('이 Mac의 결과물 주소만 연결할 수 있습니다.');
      let session = state.sessions[sessionId];
      if (session && (session.workspacePath !== workspacePath || session.previewUrl !== preview.href)) throw new Error('이미 사용 중인 작업 공간 ID입니다.');
      session ||= state.sessions[sessionId] = { workspacePath, previewUrl: preview.href, reviews: {} };
      const snapshot = await dispatch('snapshot');
      const label = `season-session:${sessionId}`;
      const labels = ['season-ai', label];
      const name = `Season AI ${localWorkspaceTime(now())}`;
      const group = snapshot.groups.find(item => item.id === session.groupId) || snapshot.groups.find(item => item.labels?.includes(label)) || await dispatch('group.save', { name, description: 'Season AI 제작 작업과 실행 기록', labels });
      session.groupId = group.id; await save();
      const service = snapshot.services.find(item => item.id === session.serviceId) || snapshot.services.find(item => item.groupId === group.id && item.labels?.includes(label)) || await dispatch('service.save', {
        groupId: group.id, name: '웹 결과물', kind: 'local', rootPath: workspacePath, viewerUrl: preview.href,
        agentEnabled: 1, agentWorkPath: workspacePath, agentBinary: await resolveAgentBinary(), labels,
        agentInstructions: '사용자가 요청한 결과물을 이 작업 폴더 안에 제작합니다. index.html에서 시작하는 HTML, CSS, JavaScript를 사용합니다. 실제 파일 변경과 검사 결과를 기록하고 실패한 작업을 완료로 표시하지 않습니다.'
      });
      if (service.groupId !== group.id || service.kind !== 'local' || await fs.realpath(service.rootPath) !== workspacePath || await fs.realpath(service.agentWorkPath || service.rootPath) !== workspacePath) throw new Error('저장된 작업 폴더 연결이 변경되었습니다.');
      session.serviceId = service.id; await save();
      const project = snapshot.projects.find(item => item.id === session.projectId) || snapshot.projects.find(item => item.groupId === group.id && item.labels?.includes(label)) || await dispatch('project.save', {
        groupId: group.id, name: '제작 작업', description: '요청 내용, 파일 변경, 명령 실행과 결과물을 리뷰별로 관리합니다.', serviceIds: [service.id], labels
      });
      if (project.groupId !== group.id || !project.serviceIds.includes(service.id)) throw new Error('저장된 프로젝트 연결이 변경되었습니다.');
      session.projectId = project.id; await save();
      return context(sessionId, session);
    }
    if (action === 'review.create') {
      const session = ownedSession(payload.sessionId), requestId = identifier(payload.requestId);
      const title = bounded(payload.title, 300), body = bounded(payload.body, 100000);
      const snapshot = await dispatch('snapshot');
      let id = session.reviews[requestId];
      if (id) {
        const existing = snapshot.reviews.find(item => item.id === id);
        if (!existing || existing.title !== title || existing.body !== body) throw new Error('이미 사용한 리뷰 요청 ID입니다.');
      }
      if (!id) {
        const existing = snapshot.reviews.find(item => item.projectId === session.projectId && item.evidence?.seasonIntegration?.requestId === requestId && item.evidence.seasonIntegration.sessionId === payload.sessionId);
        if (existing && (existing.title !== title || existing.body !== body)) throw new Error('이미 사용한 리뷰 요청 ID입니다.');
        const review = existing || await dispatch('review.save', { projectId: session.projectId, serviceId: session.serviceId,
          title, body, category: 'feature', priority: 'normal', targetUrl: session.previewUrl,
          evidence: { seasonIntegration: { sessionId: payload.sessionId, requestId } }
        });
        id = review.id; session.reviews[requestId] = id; await save();
      }
      return { ...context(payload.sessionId, session), reviewId: id, reviewUrl: reviewUrl(id) };
    }
    if (action === 'review.show') {
      if (payload.view !== undefined && payload.view !== 'project') throw new Error('프로젝트 화면으로만 작업을 안내할 수 있습니다.');
      const sessionId = payload.sessionId || Object.keys(state.sessions).find(id => Object.values(state.sessions[id].reviews || {}).includes(payload.reviewId));
      const session = ownedReview(sessionId, payload.reviewId);
      if (payload.projectId !== undefined && payload.projectId !== session.projectId) throw new Error('요청한 리뷰의 프로젝트가 일치하지 않습니다.');
      const snapshot = await dispatch('snapshot');
      if (!snapshot.reviews.some(review => review.id === payload.reviewId && review.projectId === session.projectId)) throw new Error('리뷰옵스에서 해당 리뷰를 찾을 수 없습니다. 삭제된 리뷰는 열 수 없습니다.');
      if (!snapshot.projects.some(project => project.id === session.projectId)) throw new Error('리뷰옵스에서 해당 프로젝트를 찾을 수 없습니다.');
      return showReview({ view: 'project', projectId: session.projectId, reviewId: payload.reviewId, fullscreen: payload.fullscreen !== false, displayBounds: payload.displayBounds });
    }
    if (action === 'task.start') {
      const session = ownedReview(payload.sessionId, payload.reviewId);
      const snapshot = await dispatch('snapshot');
      const review = snapshot.reviews.find(item => item.id === payload.reviewId);
      const project = snapshot.projects.find(item => item.id === session.projectId);
      const service = snapshot.services.find(item => item.id === session.serviceId);
      const workspacePath = await fs.realpath(session.workspacePath);
      const root = await fs.realpath(workspaceRoot);
      if (!inside(root, workspacePath) || !review || !project || !service || review.projectId !== project.id || review.serviceId !== service.id
        || project.groupId !== session.groupId || service.groupId !== session.groupId || !project.serviceIds.includes(service.id)
        || service.kind !== 'local' || await fs.realpath(service.rootPath) !== workspacePath || await fs.realpath(service.agentWorkPath || service.rootPath) !== workspacePath) throw new Error('리뷰 또는 작업 폴더 연결이 변경되었습니다. 새 작업을 시작하십시오.');
      // Only migrate the old automatic PATH default. A user-selected executable
      // remains unchanged, and no model or account setting is replaced.
      if (!service.agentBinary || service.agentBinary === 'codex') {
        const agentBinary = await resolveAgentBinary();
        if (agentBinary !== (service.agentBinary || 'codex')) await dispatch('service.save', { id: service.id, agentBinary });
      }
      const job = await dispatch('agent.start', { reviewId: payload.reviewId, requestId: identifier(payload.requestId), prompt: bounded(payload.prompt, 100000), ...(payload.displayPrompt === undefined ? {} : { displayPrompt: bounded(payload.displayPrompt, 100000) }), context: { instruction: true, attachmentIds: [], logIds: [] }, independentExecution: false });
      return publicJob(job);
    }
    if (action === 'task.status' || action === 'task.cancel') {
      ownedReview(payload.sessionId, payload.reviewId);
      const job = await dispatch('agent.read', { id: identifier(payload.jobId) });
      if (job.reviewId !== payload.reviewId) throw new Error('같은 리뷰의 작업만 조회하거나 중지할 수 있습니다.');
      return publicJob(action === 'task.cancel' && !final.has(job.status) ? await dispatch('agent.cancel', { id: job.id }) : job);
    }
    throw new Error('지원하지 않는 연결 기능입니다.');
  }
  let queue = Promise.resolve();
  const connections = new Set();
  await fs.rm(socketPath, { force: true });
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(45000, () => socket.destroy());
    let input = '', accepted = false;
    socket.on('data', chunk => {
      if (accepted) return;
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 512 * 1024) { socket.destroy(); return; }
      const end = input.indexOf('\n'); if (end < 0) return;
      accepted = true;
      let request;
      try {
        request = JSON.parse(input.slice(0, end));
        if (typeof request.token !== 'string' || request.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw new Error('허용되지 않은 연결입니다.');
      } catch { socket.end(JSON.stringify({ ok: false, error: '허용되지 않은 연결입니다.' }) + '\n'); return; }
      const execute = () => handle(request.action, request.payload || {});
      const result = ['task.status', 'task.cancel', 'capabilities'].includes(request.action) ? execute() : queue.then(execute);
      if (!['task.status', 'task.cancel', 'capabilities'].includes(request.action)) queue = result.catch(() => {});
      result.then(data => socket.end(JSON.stringify({ ok: true, data }) + '\n'), error => socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  await fs.writeFile(connectionPath, JSON.stringify({ version: 1, socketPath, token, pid: process.pid }), { mode: 0o600 });
  await fs.chmod(connectionPath, 0o600);
  return { handle, connectionPath, close: async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(connectionPath, { force: true }); await fs.rm(socketPath, { force: true });
  } };
}
module.exports = { createSeasonIntegration, resolveSeasonCodexBinary, localWorkspaceTime };
