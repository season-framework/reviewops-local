'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateBuildInfo(value, expectedVersion) {
  if (!value || value.channel !== 'test' || !/^\d+\.\d+\.\d+$/.test(value.version || '') ||
      !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(value.commit || '') || typeof value.builtAt !== 'string' ||
      !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt ||
      (expectedVersion && value.version !== expectedVersion)) throw new Error('테스트 빌드 정보가 올바르지 않습니다.');
  if (Object.hasOwn(value, 'developmentNumber') && (!Number.isSafeInteger(value.developmentNumber) || value.developmentNumber < 1)) throw new Error('개발 버전 번호가 올바르지 않습니다.');
  return { channel: 'test', version: value.version, buildNumber: value.buildNumber, commit: value.commit, builtAt: value.builtAt, ...(value.developmentNumber ? { developmentNumber: value.developmentNumber } : {}) };
}
function displayBuildVersion(build, fallback = '—') {
  const version = build?.version || fallback;
  return build?.channel !== 'test' ? version : build.developmentNumber ? `${version}-dev-${build.developmentNumber}` : build.buildNumber ? `${version}-test.${build.buildNumber}` : version;
}
function matchesLegacyBuild(actual, remembered) {
  // Only a remembered identity may omit a field discarded by an old client.
  // Core source/build identity remains exact in both directions.
  actual=validateBuildInfo(actual);remembered=validateBuildInfo(remembered);
  return actual.version===remembered.version&&actual.buildNumber===remembered.buildNumber&&actual.commit===remembered.commit&&actual.builtAt===remembered.builtAt&&(remembered.developmentNumber===undefined||actual.developmentNumber===remembered.developmentNumber);
}
function validateChangeNotes(value, expectedCommit) {
  const validCommit = commit => /^[a-f0-9]{40}$/.test(commit || '');
  if (!value || value.schema !== 1 || !validCommit(value.commit) || value.commit !== expectedCommit ||
      (value.baseCommit !== null && !validCommit(value.baseCommit)) || !Array.isArray(value.commits) || value.commits.length > 100 ||
      !Number.isSafeInteger(value.totalCommits) || value.totalCommits < value.commits.length ||
      (!value.baseCommit && (value.commits.length || value.totalCommits))) throw new Error('테스트 버전의 변경 내용이 올바르지 않습니다.');
  const seen = new Set();
  const commits = value.commits.map(item => {
    if (!item || !validCommit(item.commit) || seen.has(item.commit) || typeof item.subject !== 'string' || !item.subject.trim() || item.subject.length > 240 || /[\x00-\x1f\x7f]/.test(item.subject)) throw new Error('테스트 버전의 변경 커밋이 올바르지 않습니다.');
    let referenceFields={};
    if(item.references!==undefined||item.referenceStatus!==undefined){
      if(!Array.isArray(item.references)||item.references.length>12||!['verified','partial','unavailable'].includes(item.referenceStatus)||(item.referenceStatus==='unavailable'&&item.references.length))throw new Error('변경 내용의 관련 이슈·PR 정보가 올바르지 않습니다.');
      const refs=new Set(),references=item.references.map(ref=>{
        if(!ref||!['issue','pull_request'].includes(ref.kind)||!Number.isSafeInteger(ref.number)||ref.number<1||ref.number>999999999||typeof ref.title!=='string'||!ref.title.trim()||ref.title.length>240||/[\x00-\x1f\x7f]/.test(ref.title)||ref.url!==`https://github.com/season-framework/reviewops-local/${ref.kind==='issue'?'issues':'pull'}/${ref.number}`)throw new Error('변경 내용의 관련 이슈·PR 주소가 올바르지 않습니다.');
        if(!['commit_association','commit_subject','pull_request_body'].includes(ref.via)||(ref.via==='commit_association'&&ref.kind!=='pull_request')||(ref.via==='pull_request_body'&&(ref.kind!=='issue'||!Number.isSafeInteger(ref.sourcePullRequest)||!item.references.some(parent=>parent.kind==='pull_request'&&parent.number===ref.sourcePullRequest&&parent.via==='commit_association'))))throw new Error('관련 이슈·PR의 확인 경로가 올바르지 않습니다.');
        const key=ref.kind+':'+ref.number;if(refs.has(key))throw new Error('관련 이슈·PR 정보가 중복되었습니다.');refs.add(key);return {kind:ref.kind,number:ref.number,url:ref.url,title:ref.title,via:ref.via,...(ref.via==='pull_request_body'?{sourcePullRequest:ref.sourcePullRequest}:{})};
      });
      referenceFields={references,referenceStatus:item.referenceStatus};
    }
    seen.add(item.commit); return { commit: item.commit, subject: item.subject,...referenceFields };
  });
  return { schema: 1, baseCommit: value.baseCommit, commit: value.commit, totalCommits: value.totalCommits, commits };
}
function getBuildInfo(version) {
  try { return validateBuildInfo(JSON.parse(fs.readFileSync(path.join(__dirname, 'reviewops-build.json'), 'utf8')), version); }
  catch (error) { if (error.code === 'ENOENT') return { channel: 'stable', version, buildNumber: null, commit: null, builtAt: null }; throw error; }
}
module.exports = { validateBuildInfo, getBuildInfo, displayBuildVersion, validateChangeNotes, matchesLegacyBuild };
