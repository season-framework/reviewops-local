import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateBuildInfo}=require('../electron/build-info.cjs');
export const DEVELOPMENT_MARKER='<!-- reviewops-test-development:';
export const historyName=build=>`reviewops-development-${build.version}-dev-${build.developmentNumber}.json`;
export const historyAsset=/^reviewops-development-\d+\.\d+\.\d+-dev-[1-9]\d*\.json$/;
const commit=value=>/^[a-f0-9]{40}$/.test(value||'');
const identity=build=>JSON.stringify(validateBuildInfo(build));
export function validateLedger(value) {
 if(!value||value.schema!==1||!Array.isArray(value.allocations)||value.allocations.length>150)throw new Error('개발 버전 이력이 올바르지 않습니다.');
 const numbers=new Set(),builds=new Set();
 const allocations=value.allocations.map(item=>{
  const build=validateBuildInfo(item?.build);
  if(!build.developmentNumber||!(item.baseCommit===null||commit(item.baseCommit)))throw new Error('개발 버전 할당 정보가 올바르지 않습니다.');
  const key=`${build.version}:${build.developmentNumber}`;
  if(numbers.has(key)||builds.has(build.buildNumber))throw new Error('개발 번호 또는 빌드 번호가 중복되었습니다.');
  numbers.add(key);builds.add(build.buildNumber);
  let history=null;
  if(item.history!==null){
   if(!item.history||item.history.name!==historyName(build)||!Number.isSafeInteger(item.history.size)||item.history.size<1||item.history.size>1024**2||!/^[a-f0-9]{64}$/.test(item.history.sha256||''))throw new Error('개발 버전 변경 이력 파일이 올바르지 않습니다.');
   history={name:item.history.name,size:item.history.size,sha256:item.history.sha256};
  }
  return {build,baseCommit:item.baseCommit,history};
 });
 return {schema:1,allocations};
}
export function ledgerFromBody(body) {
 const matches=[...String(body||'').matchAll(/<!-- reviewops-test-development:(.*?) -->/g)];
 if(!matches.length){if(String(body||'').includes(DEVELOPMENT_MARKER))throw new Error('개발 버전 이력이 손상되어 번호를 다시 지정할 수 없습니다.');return validateLedger({schema:1,allocations:[]});}
 if(matches.length!==1)throw new Error('개발 버전 이력이 중복되었습니다.');
 let value;try{value=JSON.parse(matches[0][1])}catch{throw new Error('개발 버전 이력을 읽을 수 없습니다.');}
 return validateLedger(value);
}
export function ledgerComment(ledger) {
 const text=`${DEVELOPMENT_MARKER}${JSON.stringify(validateLedger(ledger))} -->`;
 if(Buffer.byteLength(text)>90000)throw new Error('개발 버전 할당 이력의 허용 크기를 초과했습니다.');
 return text;
}
export function replaceLedger(body,ledger) {
 ledgerFromBody(body);
 const clean=String(body||'').replace(/\n?<!-- reviewops-test-development:.*? -->\n?/g,'').trimEnd();
 const result=clean+'\n\n'+ledgerComment(ledger)+'\n';
 if(Buffer.byteLength(result)>120000)throw new Error('테스트 릴리즈 설명의 허용 크기를 초과했습니다.');
 return result;
}
export function allocateDevelopment(ledger,input,baseCommit) {
 ledger=validateLedger(ledger);const clean=validateBuildInfo(input);
 if(Object.hasOwn(clean,'developmentNumber'))throw new Error('개발 번호는 공개 할당 이력에서 지정합니다.');
 if(!(baseCommit===null||commit(baseCommit)))throw new Error('이전 공개 커밋이 올바르지 않습니다.');
 const previous=ledger.allocations.find(item=>item.build.buildNumber===clean.buildNumber);
 if(previous){
  if(previous.build.version!==clean.version||previous.build.commit!==clean.commit)throw new Error('같은 빌드 번호가 다른 소스에 사용되었습니다.');
  // A metadata-job retry reuses its original timestamp as well as its number.
  return {ledger,record:previous,reused:true};
 }
 const developmentNumber=1+Math.max(0,...ledger.allocations.filter(item=>item.build.version===clean.version).map(item=>item.build.developmentNumber));
 if(!Number.isSafeInteger(developmentNumber))throw new Error('개발 번호의 허용 범위를 초과했습니다.');
 const record={build:validateBuildInfo({...clean,developmentNumber}),baseCommit,history:null};
 return {ledger:validateLedger({schema:1,allocations:[...ledger.allocations,record]}),record,reused:false};
}
export function requireAllocation(ledger,build,baseCommit) {
 const clean=validateBuildInfo(build),record=validateLedger(ledger).allocations.find(item=>item.build.buildNumber===clean.buildNumber);
 if(!record||identity(record.build)!==identity(clean)||record.baseCommit!==baseCommit)throw new Error('공개 예약한 개발 버전과 패키지 정보가 다릅니다.');
 return record;
}
export function publishDevelopment(ledger,build,baseCommit,history) {
 const record=requireAllocation(ledger,build,baseCommit);
 if(record.history&&JSON.stringify(record.history)!==JSON.stringify(history))throw new Error('이미 공개한 개발 버전의 내용은 변경할 수 없습니다.');
 return validateLedger({schema:1,allocations:ledger.allocations.map(item=>item.build.buildNumber===build.buildNumber?{...item,history}:item)});
}
