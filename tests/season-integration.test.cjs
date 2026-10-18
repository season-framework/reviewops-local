'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createSeasonIntegration, resolveSeasonCodexBinary, localWorkspaceTime } = require('../electron/season-integration.cjs');

async function fixture() {
  const directory = await fs.mkdtemp('/tmp/reviewops-season-');
  const workspaceRoot = path.join(directory, 'work'), workspacePath = path.join(workspaceRoot, 'one');
  await fs.mkdir(workspacePath, { recursive: true });
  const data = { groups: [], projects: [], services: [], reviews: [] }, jobs = new Map(), calls = [];
  const dispatch = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'snapshot') return structuredClone(data);
    if (action.endsWith('.save')) {
      const collection = action.split('.')[0] + 's';
      if (payload.id) { const item = data[collection].find(value => value.id === payload.id); Object.assign(item, payload); return structuredClone(item); }
      const item = { ...payload, id: `${collection}-${data[collection].length + 1}` };
      data[collection].push(item); return structuredClone(item);
    }
    if (action === 'agent.start') {
      if (!jobs.has(payload.requestId)) jobs.set(payload.requestId, { id: payload.requestId, reviewId: payload.reviewId, status: 'running', progress: [] });
      return structuredClone(jobs.get(payload.requestId));
    }
    if (action === 'agent.read') { if (!jobs.has(payload.id)) throw new Error('Missing job'); return structuredClone(jobs.get(payload.id)); }
    if (action === 'agent.cancel') { jobs.get(payload.id).status = 'cancelled'; return structuredClone(jobs.get(payload.id)); }
    throw new Error('Unexpected action ' + action);
  };
  let shown;
  const bridge = await createSeasonIntegration({ dataPath: directory, workspaceRoot, dispatch, resolveAgentBinary: async () => '/fixture/current-codex', now: () => new Date(2026, 9, 18, 16, 23), showReview: async value => { shown = value; return { shown: true, fullscreen: true }; } });
  const connection = JSON.parse(await fs.readFile(bridge.connectionPath, 'utf8'));
  const runtime = { workspacePath, previewUrl: 'http://127.0.0.1:32001/' };
  const invoke = (action, payload = {}, { token = connection.token, split } = {}) => new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socketPath); socket.setEncoding('utf8'); let input = '';
    socket.on('error', reject);
    socket.on('connect', () => {
      const bytes = Buffer.from(JSON.stringify({ token, action, payload }) + '\n');
      if (split) { const boundary = bytes.indexOf(Buffer.from(split)) + 1; socket.write(bytes.subarray(0, boundary)); setTimeout(() => socket.write(bytes.subarray(boundary)), 10); }
      else socket.write(bytes);
    });
    socket.on('data', chunk => { input += chunk; if (input.includes('\n')) { socket.destroy(); resolve(JSON.parse(input.trim())); } });
  });
  const prepare = () => invoke('prepare', { sessionId: 'session-1', runtime });
  const review = () => invoke('review.create', { sessionId: 'session-1', requestId: 'request-1', title: '웹 결과물', body: '카드 게임을 만듭니다.' });
  return { directory, bridge, data, calls, jobs, connection, runtime, invoke, prepare, review, shown: () => shown, close: async () => { await bridge.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('private socket creates real app records through dispatch and preserves IDs after label edits', async () => {
  const f = await fixture();
  try {
    const first = await f.prepare(); assert.equal(first.ok, true);
    assert.equal(f.data.services[0].agentBinary, '/fixture/current-codex');
    assert.equal(f.data.groups[0].name, 'Season AI 2026-10-18 16:23');
    assert.equal((await fs.stat(f.connection.socketPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.bridge.connectionPath)).mode & 0o777, 0o600);
    for (const collection of ['groups', 'projects', 'services']) f.data[collection][0].labels = [];
    const second = await f.prepare(); assert.deepEqual(second, first);
    assert.deepEqual(['groups', 'projects', 'services'].map(key => f.data[key].length), [1, 1, 1]);
    const created = await f.review();
    assert.equal(created.data.reviewUrl, 'reviewops-local://review/reviews-1');
    assert.deepEqual(await f.review(), created);
    assert.equal(f.data.reviews.length, 1);
    assert.equal((await f.invoke('review.create', { sessionId: 'session-1', requestId: 'request-1', title: '다른 제목', body: '다른 요청' })).ok, false);
    await f.invoke('review.show', { reviewId: created.data.reviewId, fullscreen: true });
    assert.equal(f.shown().reviewId, created.data.reviewId);
    assert.equal(f.shown().projectId,created.data.projectId);assert.equal(f.shown().view,'project');
    assert.equal((await f.invoke('capabilities')).data.projectPresentation,true);
    assert.equal((await f.invoke('review.show',{reviewId:created.data.reviewId,view:'home'})).ok,false);
    assert.equal((await f.invoke('review.show',{reviewId:created.data.reviewId,projectId:'another-project'})).ok,false);
    f.data.reviews.length = 0;
    const missing = await f.invoke('review.show', { reviewId: created.data.reviewId, fullscreen: true });
    assert.equal(missing.ok, false); assert.match(missing.error, /삭제된 리뷰/u);
  } finally { await f.close(); }
});

test('executable selection prioritizes an explicit fixture and bundled Codex without changing the model', async () => {
  const chatgpt = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const codexApp = '/Applications/Codex.app/Contents/Resources/codex';
  const exists = filenames => async filename => filenames.includes(filename);
  assert.equal(await resolveSeasonCodexBinary({ env: { SEASON_CODEX_PATH: '/fixture/codex' }, isExecutable: exists(['/fixture/codex', chatgpt, codexApp]) }), '/fixture/codex');
  assert.equal(await resolveSeasonCodexBinary({ env: {}, isExecutable: exists([chatgpt, codexApp]) }), chatgpt);
  assert.equal(await resolveSeasonCodexBinary({ env: {}, isExecutable: exists([codexApp]) }), codexApp);
  assert.equal(await resolveSeasonCodexBinary({ env: {}, isExecutable: exists([]) }), 'codex');
  assert.equal(localWorkspaceTime(new Date(2026, 9, 18, 16, 23)), '2026-10-18 16:23');
});

test('old automatic PATH binary migrates before execution but explicit service paths remain intact', async () => {
  const f = await fixture();
  try {
    await f.prepare(); const review = (await f.review()).data;
    const payload = { sessionId: 'session-1', reviewId: review.reviewId, requestId: 'job-1', prompt: '웹 결과물 제작' };
    f.data.services[0].agentBinary = 'codex'; f.data.services[0].agentModel = 'configured-model';
    assert.equal((await f.invoke('task.start', payload)).ok, true);
    assert.equal(f.data.services[0].agentBinary, '/fixture/current-codex');
    assert.equal(f.data.services[0].agentModel, 'configured-model');
    f.data.services[0].agentBinary = '/user/selected-codex';
    assert.equal((await f.invoke('task.start', { ...payload, requestId: 'job-2' })).ok, true);
    assert.equal(f.data.services[0].agentBinary, '/user/selected-codex');
    assert.equal(f.data.services[0].agentModel, 'configured-model');
  } finally { await f.close(); }
});

test('socket rejects invalid credentials and handles Korean split inside a UTF8 character', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.invoke('prepare', { sessionId: 'session-1', runtime: f.runtime }, { token: 'b'.repeat(64) })).ok, false);
    assert.equal(f.calls.length, 0);
    await f.prepare();
    const result = await f.invoke('review.create', { sessionId: 'session-1', requestId: 'request-1', title: '한글 日本語', body: '한국어와 일본어 입력' }, { split: '한글' });
    assert.equal(result.ok, true); assert.equal(f.data.reviews[0].title, '한글 日本語');
  } finally { await f.close(); }
});

test('execution rejects changed review relationships and paths outside the integration workspace', async () => {
  const f = await fixture();
  try {
    await f.prepare(); const review = (await f.review()).data;
    const payload = { sessionId: 'session-1', reviewId: review.reviewId, requestId: 'job-1', prompt: '카드 게임을 제작합니다.' };
    f.data.services[0].agentWorkPath = f.directory;
    assert.equal((await f.invoke('task.start', payload)).ok, false);
    assert.equal(f.calls.some(item => item.action === 'agent.start'), false);
    f.data.services[0].agentWorkPath = f.runtime.workspacePath;
    f.data.reviews[0].serviceId = 'unrelated-service';
    assert.equal((await f.invoke('task.start', payload)).ok, false);
    f.data.reviews[0].serviceId = f.data.services[0].id;
    assert.equal((await f.invoke('task.start', payload)).ok, true);
    assert.equal((await f.invoke('task.status', { sessionId: 'session-1', reviewId: review.reviewId, jobId: 'job-1' })).data.status, 'running');
    assert.equal((await f.invoke('task.cancel', { sessionId: 'session-1', reviewId: review.reviewId, jobId: 'job-1' })).data.status, 'cancelled');
    assert.equal((await f.invoke('task.start', { ...payload, reviewId: 'other-review' })).ok, false);
  } finally { await f.close(); }
});

test('external and symlinked workspace paths and non-loopback previews are rejected', async () => {
  const f = await fixture();
  try {
    const link = path.join(path.dirname(f.runtime.workspacePath), 'escape'); await fs.symlink(f.directory, link);
    for (const runtime of [{ ...f.runtime, workspacePath: f.directory }, { ...f.runtime, workspacePath: link }, { ...f.runtime, previewUrl: 'https://example.com/' }]) {
      assert.equal((await f.invoke('prepare', { sessionId: 'new-session', runtime })).ok, false);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
