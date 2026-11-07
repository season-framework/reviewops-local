import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Shared transport only. Each reviewed entry point supplies its own strict CI authority.
export function githubReleaseStore({token,fetchImpl=fetch,authorize,repository,tag}) {
  const api = `https://api.github.com/repos/${repository}`;
  async function request(url, { method = 'GET', body, binary = false, allow404 = false } = {}) {
    if (method !== 'GET') { authorize(null); if (!token) throw new Error('Actions 게시 토큰이 없습니다.'); }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(parsed.hostname)) throw new Error('게시 API 주소가 올바르지 않습니다.');
    const response = await fetchImpl(url, { method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json', 'User-Agent': 'ReviewOps-Test-Release', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache', ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) }, body: body ? binary ? body : JSON.stringify(body) : undefined });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 테스트 게시 요청이 실패했습니다: HTTP ${response.status}`);
    return response;
  }
  return {
    assertBuildAllowed(build) { authorize(build); },
    async getRelease() { const r = await request(`${api}/releases/tags/${tag}?cache=${Date.now()}`, { allow404: true }); return r ? r.json() : null; },
    async createRelease(commit) { return (await request(`${api}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: commit, name: 'ReviewOps Test builds', body: '', prerelease: true, draft: false, make_latest: 'false' } })).json(); },
    async listAssets(id) { const all = []; for (let page = 1; ; page++) { const result = await (await request(`${api}/releases/${id}/assets?per_page=100&page=${page}&cache=${Date.now()}`)).json(); all.push(...result); if (result.length < 100) return all; } },
    async upload(release, file) { const bytes = file.bytes || await fs.readFile(file.filename); if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('업로드 직전에 설치파일이 변경되었습니다.'); await request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: bytes, binary: true }); },
    async hashAsset(asset) {
      // Redirects are handled manually. Never forward the Actions token to CDN.
      let response = await fetchImpl(`${api}/releases/assets/${asset.id}?cache=${Date.now()}`, { redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const url = new URL(response.headers.get('location'));
        if (url.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('설치파일 검사 주소가 올바르지 않습니다.');
        response = await fetchImpl(url, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
      }
      if (!response.ok) throw new Error(`설치파일 재다운로드가 실패했습니다: HTTP ${response.status}`);
      const digest = crypto.createHash('sha256'); let total = 0;
      for await (const chunk of response.body) { total += chunk.length; if (total > asset.size) throw new Error('설치파일 크기가 다릅니다.'); digest.update(chunk); }
      if (total !== asset.size) throw new Error('설치파일 크기가 다릅니다.');
      return digest.digest('hex');
    },
    async setPointer(id, body, name) { await request(`${api}/releases/${id}`, { method: 'PATCH', body: { body, ...(name?{name}:{}), prerelease: true, make_latest: 'false' } }); },
    async deleteAsset(id) { await request(`${api}/releases/assets/${id}`, { method: 'DELETE', allow404: true }); },
    async assetExists(id) { return Boolean(await request(`${api}/releases/assets/${id}?cache=${Date.now()}`, { allow404: true })); },
  };
}
