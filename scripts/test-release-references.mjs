const REPOSITORY='season-framework/reviewops-local';
const api=`https://api.github.com/repos/${REPOSITORY}`;
export function explicitReferences(text){
 const numbers=new Set();
 for(const match of String(text||'').matchAll(/(?:^|[^A-Za-z0-9_./-])#([1-9]\d{0,8})\b/g))numbers.add(Number(match[1]));
 for(const match of String(text||'').matchAll(/(?:^|[^A-Za-z0-9_./-])(?:https:\/\/github\.com\/season-framework\/reviewops-local\/(?:issues|pull)\/|season-framework\/reviewops-local#)([1-9]\d{0,8})\b/g))numbers.add(Number(match[1]));
 return [...numbers];
}
export function githubReferenceLookup({token=process.env.GITHUB_TOKEN,fetchImpl=fetch}={}){
 const cache=new Map();let requests=0;
 const get=suffix=>{
  if(cache.has(suffix))return cache.get(suffix);
  const task=(async()=>{
   if(++requests>500)throw new Error('관련 이슈·PR 조회의 허용 횟수를 초과했습니다.');
   const response=await fetchImpl(api+suffix,{headers:{Accept:'application/vnd.github+json','User-Agent':'ReviewOps-Release-References','Cache-Control':'no-cache',...(token?{Authorization:`Bearer ${token}`}:{})},redirect:'error',signal:AbortSignal.timeout(30000)});
   if(response.status===404)return null;
   if(!response.ok)throw new Error('관련 이슈·PR을 조회하지 못했습니다.');
   const bytes=await response.arrayBuffer();if(bytes.byteLength>8*1024**2)throw new Error('관련 이슈·PR 응답의 허용 크기를 초과했습니다.');
   return JSON.parse(Buffer.from(bytes).toString('utf8'));
  })();cache.set(suffix,task);return task;
 };
 const reference=value=>{
  const kind=value.pull_request?'pull_request':'issue',number=value.number,url=`https://github.com/${REPOSITORY}/${kind==='issue'?'issues':'pull'}/${number}`;
  if(!Number.isSafeInteger(number)||number<1||number>999999999||value.html_url!==url||typeof value.title!=='string'||!value.title.trim())throw new Error('관련 이슈·PR의 공개 주소가 올바르지 않습니다.');
  return {kind,number,url,title:value.title.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240)};
 };
 return async item=>{
  if(!item||!/^[a-f0-9]{40}$/.test(item.commit||'')||typeof item.subject!=='string')throw new Error('관련 정보에 연결할 커밋이 올바르지 않습니다.');
  const refs=new Map(),issueNumbers=new Map(explicitReferences(item.subject).map(number=>[number,{via:'commit_subject'}]));let partial=false,publicCommit=false;
  try{
   for(let page=1;page<=3;page++){
    const pulls=await get(`/commits/${item.commit}/pulls?per_page=100&page=${page}`);
    if(pulls===null)return {...item,references:[],referenceStatus:'unavailable'};
    if(!Array.isArray(pulls))throw new Error('관련 PR 목록이 올바르지 않습니다.');publicCommit=true;
    for(const pull of pulls){
     if(pull.base?.repo?.full_name!==REPOSITORY)continue;
     const ref={...reference({...pull,pull_request:{}}),via:'commit_association'};if(refs.size<12)refs.set('pull_request:'+ref.number,ref);else partial=true;
     for(const number of explicitReferences(`${pull.title||''}\n${pull.body||''}`))if(!issueNumbers.has(number))issueNumbers.set(number,{via:'pull_request_body',sourcePullRequest:pull.number});
    }
    if(pulls.length<100)break;if(page===3)partial=true;
   }
   const requested=[...issueNumbers];if(requested.length>24)partial=true;
   for(const [number,provenance] of requested.slice(0,24)){
    const value=await get(`/issues/${number}`);if(value===null)continue;
    // PR associations come from the commit API. A PR body can also mention its
    // dependency PRs; do not turn those mentions into commit associations.
    if(value.pull_request&&!explicitReferences(item.subject).includes(number))continue;
    if(provenance.via==='pull_request_body'&&!refs.has('pull_request:'+provenance.sourcePullRequest)){partial=true;continue;}
    const ref={...reference(value),...provenance},key=ref.kind+':'+ref.number;
    if(refs.has(key))continue;if(refs.size>=12){partial=true;continue;}refs.set(key,ref);
   }
  }catch{partial=true;}
  return {...item,references:[...refs.values()],referenceStatus:partial?(refs.size?'partial':'unavailable'):publicCommit?'verified':'unavailable'};
 };
}
