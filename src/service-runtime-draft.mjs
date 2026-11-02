const fields=['executable','entry','argsText','readinessUrl'];
export const emptyServiceRuntimeDraft=()=>({executable:'',entry:'',argsText:'[]',readinessUrl:''});
const fromConfig=config=>({executable:config?.executable||'',entry:config?.entry||'',argsText:JSON.stringify(config?.args||[],null,2),readinessUrl:config?.readinessUrl||''});
const argsIdentity=text=>{try{const value=JSON.parse(text);if(Array.isArray(value)&&value.every(item=>typeof item==='string'))return ['args',value];}catch{}return ['invalid',text];};
const same=(a,b)=>fields.every(key=>key==='argsText'?JSON.stringify(argsIdentity(a[key]))===JSON.stringify(argsIdentity(b[key])):a[key]===b[key]);
const target=(binding,value={})=>({binding,projectId:value.projectId||'',connectionId:value.connectionId||'',rootPath:value.rootPath||'',kind:value.kind||'local',name:value.name||''});
const sameTarget=(a,b)=>['projectId','connectionId','rootPath','kind'].every(key=>a[key]===b[key]);

// The request epoch may change while this owner retains an unsaved draft. Never
// silently retarget executable/entry/arguments into another connection/project.
export function createServiceRuntimeDraft(binding,onDirtyChange=()=>{},identity={}) {
 let active=true,baseline=emptyServiceRuntimeDraft(),value=emptyServiceRuntimeDraft(),reported=false,epoch=0;
 let current=target(binding,identity),origin={...current},originBaseline=emptyServiceRuntimeDraft(),reviewedEpoch=-1,retained=false,validationRequired=false,loaded=false,targetBaseline=emptyServiceRuntimeDraft();
 const changed=()=>!same(value,baseline);
 const reviewRequired=()=>retained||!sameTarget(origin,current)&&reviewedEpoch!==epoch;
 const canConfigure=()=>active&&current.kind==='local'&&origin.projectId===current.projectId&&!reviewRequired();
 const snapshot=()=>({binding:current.binding,draft:{...value},dirty:active&&(changed()||retained||validationRequired),origin:{...origin},current:{...current},reviewRequired:reviewRequired(),canConfigure:canConfigure(),canReview:active&&loaded&&current.kind==='local'&&origin.projectId===current.projectId});
 const notify=()=>{const dirty=snapshot().dirty;if(dirty!==reported){reported=dirty;onDirtyChange(dirty);}return snapshot();};
 return {
  get binding(){return current.binding;},snapshot,
  transition(nextBinding,identity={}){
   if(!active||nextBinding===current.binding)return snapshot();
   const preserve=changed()||retained||validationRequired;epoch++;current=target(nextBinding,identity);loaded=false;targetBaseline=emptyServiceRuntimeDraft();reviewedEpoch=-1;validationRequired=false;
   if(!preserve){origin={...current};originBaseline=emptyServiceRuntimeDraft();baseline=emptyServiceRuntimeDraft();value=emptyServiceRuntimeDraft();retained=false;}
   else{retained=!sameTarget(origin,current);if(!retained)baseline={...originBaseline};}
   return notify();
  },
  change(name,text){if(!active)return snapshot();if(!fields.includes(name)||typeof text!=='string')throw new TypeError('Invalid service draft field');value={...value,[name]:text};return notify();},
  accept(config){
   if(!active)return snapshot();loaded=true;targetBaseline=fromConfig(config);
   if(!reviewRequired()){const dirty=changed()||validationRequired;baseline={...targetBaseline};if(sameTarget(origin,current))originBaseline={...baseline};if(!dirty)value={...baseline};}
   return notify();
  },
  review(){if(!snapshot().canReview)return snapshot();reviewedEpoch=epoch;retained=false;validationRequired=!sameTarget(origin,current);baseline={...targetBaseline};return notify();},
  discard(){if(!active)return snapshot();origin={...current};reviewedEpoch=-1;retained=false;validationRequired=false;baseline={...targetBaseline};originBaseline={...baseline};value={...baseline};return notify();},
  async save(persist){
   if(!active)return;
   if(!canConfigure())throw Object.assign(new Error('이전 연결의 초안을 검토한 뒤 현재 연결에 저장하십시오.'),{code:'SERVICE_DRAFT_REVIEW_REQUIRED'});
   const submitted={...value},requestedEpoch=epoch,result=await persist();
   if(active&&requestedEpoch===epoch&&result&&Object.hasOwn(result,'config')){
    loaded=true;baseline=fromConfig(result.config);targetBaseline={...baseline};origin={...current};originBaseline={...baseline};retained=false;validationRequired=false;reviewedEpoch=-1;
    // Normalize only unchanged submitted fields; later edits remain unsaved.
    value=Object.fromEntries(fields.map(key=>[key,value[key]===submitted[key]?baseline[key]:value[key]]));notify();
   }
   return result;
  },
  dispose(){active=false;notify();}
 };
}

// Consult the live owner at the unload event, before any React effect flush.
export const serviceRuntimeUnloadGuard=read=>event=>{
 if(read()?.snapshot().dirty){event.preventDefault();event.returnValue='';}
};
