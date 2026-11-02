'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { readLocal } = require('./files.cjs');

// This is an observation from the ReviewOps computer, not an application health
// contract or a check from inside the project's SSH host. Do not follow redirects
// or reuse the embedded browser's cookies/credentials.
function checkHttp(input, { timeoutMs = 5000 } = {}) {
  let url;
  try {
    if (typeof input !== 'string' || input.length > 4096) throw new Error();
    url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    url.hash = '';
  } catch { throw new Error('인증 정보가 없는 http:// 또는 https:// 주소를 입력하십시오.'); }
  const startedAt = new Date().toISOString(), started = Date.now();
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ url: url.href, startedAt, checkedAt: new Date().toISOString(), durationMs: Date.now() - started, observedFrom: 'reviewops-computer', ...result });
    };
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', agent: false, headers: { 'User-Agent': 'ReviewOps-readiness', 'Accept': '*/*' } }, response => {
      const statusCode = response.statusCode;
      finish({ status: statusCode >= 200 && statusCode < 300 ? 'responding' : 'http-error', statusCode });
      response.destroy(); // Headers suffice; never buffer an unbounded response.
    });
    request.on('error', error => finish({ status: 'unreachable', errorCode: error.code || 'REQUEST_FAILED' }));
    timer = setTimeout(() => { finish({ status: 'unreachable', errorCode: 'TIMEOUT' }); request.destroy(); }, timeoutMs);
    request.end();
  });
}

async function compareFile(service, relative) {
  if (!relative) return null;
  const checkedAt = new Date().toISOString();
  if (service.kind !== 'local') return { path: relative, checkedAt, error: '파일 비교는 로컬 프로젝트에서만 지원합니다.' };
  try {
    const file = await readLocal(service, relative, { raw: true });
    return { path: file.path, size: file.size, sha256: crypto.createHash('sha256').update(file.bytes).digest('hex'), checkedAt, role: 'comparison-only' };
  } catch (error) { return { path: relative, checkedAt, error: error.message }; }
}

function summarizeAgents(runs, reviewIds) {
  const projectRuns = runs.filter(run => reviewIds.has(run.reviewId));
  return {
    checkedAt: new Date().toISOString(),
    running: projectRuns.filter(run => ['running', 'queued'].includes(run.status)).length,
    latest: projectRuns[0] ? { id: projectRuns[0].id, status: projectRuns[0].status, startedAt: projectRuns[0].startedAt, finishedAt: projectRuns[0].finishedAt } : null
  };
}

module.exports = { checkHttp, compareFile, summarizeAgents };
