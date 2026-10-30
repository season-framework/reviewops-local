import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPublicationCI, REPOSITORY } from './test-release.mjs';
const packageName = /^reviewops-test-build-(?:darwin-arm64|darwin-x64|win32-x64)$/;
export async function cleanupArtifacts({ remove = false, keepCurrent = false, keepCandidate = false, env = process.env, fetchImpl = fetch } = {}) {
  assertPublicationCI(null, env);
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('Actions 임시 파일 정리 토큰이 없습니다.');
  const currentRun = Number(env.GITHUB_RUN_ID);
  if (!Number.isSafeInteger(currentRun) || currentRun < 1) throw new Error('현재 Actions 실행 ID가 올바르지 않습니다.');
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  async function request(suffix, method = 'GET') {
    const response = await fetchImpl(api + suffix, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Actions 임시 파일 요청이 실패했습니다: HTTP ${response.status}`);
    return response.status === 204 ? true : response.json();
  }
  const workflow = await request('/actions/workflows/test-release.yml');
  if (!workflow) throw new Error('테스트 배포 workflow를 찾을 수 없습니다.');
  const candidates = [];
  // Gather first: deleting while paging can skip entries as the list contracts.
  for (let page = 1; ; page++) {
    const result = await request(`/actions/artifacts?per_page=100&page=${page}`);
    if (!result || !Array.isArray(result.artifacts)) throw new Error('Actions 임시 파일 목록이 올바르지 않습니다.');
    candidates.push(...result.artifacts.filter(item => packageName.test(item.name)));
    if (result.artifacts.length < 100) break;
  }
  const eligible = [], runs = new Map();
  for (const artifact of candidates) {
    const id = artifact.workflow_run?.id;
    if (!Number.isSafeInteger(id)) continue;
    if (!runs.has(id)) runs.set(id, await request(`/actions/runs/${id}`));
    const run = runs.get(id);
    if (!run || run.workflow_id !== workflow.id || id !== currentRun && run.status !== 'completed') continue;
    eligible.push({ id: artifact.id, name: artifact.name, run: id });
  }
  let retainedRun = keepCurrent ? currentRun : null;
  const unexpired = new Set(candidates.filter(item => !item.expired).map(item => item.id));
  if (keepCurrent || keepCandidate) {
    const successful = [...runs.entries()].filter(([id, run]) => id !== currentRun && run?.workflow_id === workflow.id && run.conclusion === 'success' && new Set(eligible.filter(item => item.run === id && unexpired.has(item.id)).map(item => item.name)).size === 3);
    retainedRun = Math.max(retainedRun || 0, successful.sort(([left], [right]) => right - left)[0]?.[0] || 0) || null;
  }
  const selected = eligible.filter(item => item.run !== retainedRun);
  if (remove) for (const artifact of selected) {
    await request(`/actions/artifacts/${artifact.id}`, 'DELETE');
    if (await request(`/actions/artifacts/${artifact.id}`)) throw new Error('삭제한 Actions 임시 파일이 아직 조회됩니다.');
  }
  return { dryRun: !remove, retainedRun, artifacts: selected };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--delete', '--dry-run', '--keep-current', '--keep-candidate'].includes(arg))) throw new Error('임시 파일 정리 옵션을 확인하십시오.');
  cleanupArtifacts({ remove: args.includes('--delete') && !args.includes('--dry-run'), keepCurrent: args.includes('--keep-current'), keepCandidate: args.includes('--keep-candidate') }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
