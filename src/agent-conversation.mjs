// Keep clipboard content separate from every label rendered around a message.
export async function copyMessageText(value,{writeText,streaming=false}={}){
 if(typeof value!=='string'||!value.trim())return {status:'empty'};
 try{
  const write=writeText||(globalThis.window?.reviewops?.copyText?text=>globalThis.window.reviewops.copyText(text):globalThis.navigator?.clipboard?.writeText?text=>globalThis.navigator.clipboard.writeText(text):null);
  if(!write)throw new Error('Clipboard unavailable');
  await write(value);
  return {status:streaming?'streaming':'copied'};
 }catch(error){return {status:'failed',error};}
}

export function shouldFollowLatest({nearBottom,detailsOpen=false,readingEarlier=false}={}){
 return Boolean(nearBottom&&!detailsOpen&&!readingEarlier);
}

export function executionSettingsView(run={}){
 const settings=run.executionSettings;
 const reported={};
 for(const key of ['model','reasoningEffort'])if(typeof run.reportedSettings?.[key]==='string'&&run.reportedSettings[key])reported[key]=run.reportedSettings[key];
 if(!settings||settings.version!==1)return {recorded:false,selected:{},automatic:{},sent:{},reported};
 return {recorded:true,selected:{...settings.selected},automatic:{...settings.automatic},sent:{...settings.sent},reported};
}

export function pendingSettingsForEdit(settings,patch,defaults={}){
 const base=settings||{version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:defaults.model||'',reasoningEffort:defaults.reasoningEffort||''}};
 const next={...base,selected:{...base.selected},automatic:{...base.automatic},sent:{...base.sent}};
 for(const key of ['model','reasoningEffort'])if(Object.hasOwn(patch,key)){
  next.selected[key]=patch[key];next.automatic[key]=!patch[key];
  next.sent[key]=key==='model'?(patch[key]||defaults.model||''):patch[key];
 }
 return next;
}
