import React from 'react';

// Public window metadata is display-only; never retain a resume proof or grant.
export function qaControllerMetadata(value,projectId){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='contract,generation,label,projectId,state'||value.contract!=='logical-qa-controller-v1'||value.projectId!==projectId||typeof value.label!=='string'||!value.label.trim()||value.label.length>128||/[\x00-\x1f\x7f]/.test(value.label)||!['attached','detached','released','unknown'].includes(value.state)||!Number.isSafeInteger(value.generation)||value.generation<1||value.state==='released')return null;
 return {contract:value.contract,label:value.label,projectId:value.projectId,state:value.state,generation:value.generation};
}
export function QaControllerBadge({projectId,projectName,controller,t}){
 const metadata=qaControllerMetadata(controller,projectId),base=t('프로젝트 QA');
 if(!metadata)return React.createElement('span',{className:'workspace-qa-scope',role:'status'},base);
 const state=t(metadata.state==='attached'?'QA 제어 연결됨':metadata.state==='detached'?'QA 제어 연결 끊김':'QA 제어 상태 확인 필요');
 const text=base+' · '+(projectName||projectId)+' · '+t('QA 제어자: {0}',[metadata.label])+' · '+state;
 return React.createElement('span',{className:'workspace-qa-scope',role:'status',title:text,'aria-label':text,'data-qa-controller-state':metadata.state},React.createElement('span',{style:{maxWidth:'min(40vw,32rem)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},text));
}
