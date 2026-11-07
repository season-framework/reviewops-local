'use strict';
const path = require('node:path');

const BRANCH = 'codex/hidden-web-capture-probe';
const CAPTURE_TIMEOUT_MS = 5000;
const HIDDEN_SETTLE_MS = 5000;
const CHILD_TIMEOUT_MS = 35000;
const GEOMETRY = Object.freeze({width:310,height:207,viewportWidth:1200,viewportHeight:800,scale:310/1200});
const CASES = Object.freeze([
  {id:'native-hidden',method:'native',backgroundThrottling:true,options:{stayHidden:true}},
  {id:'native-default',method:'native',backgroundThrottling:true,options:null},
  {id:'native-unthrottled',method:'native',backgroundThrottling:false,options:{stayHidden:true}},
  {id:'cdp-surface',method:'cdp',backgroundThrottling:true,fromSurface:true},
  {id:'cdp-view',method:'cdp',backgroundThrottling:true,fromSurface:false},
  {id:'native-hidden-focus-emulated',method:'native',backgroundThrottling:true,focusEmulated:true,options:{stayHidden:true}},
  {id:'native-default-focus-emulated',method:'native',backgroundThrottling:true,focusEmulated:true,options:null},
  {id:'native-temporary-unthrottled',method:'native',backgroundThrottling:true,temporaryUnthrottled:true,options:{stayHidden:true},requires:'native-unthrottled'}
].map(value=>Object.freeze(value)));

function hostedOnly(env=process.env,platform=process.platform,arch=process.arch) {
  const prototype=env.GITHUB_REF===`refs/heads/${BRANCH}`&&env.GITHUB_EVENT_NAME==='push';
  const manual=env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.REVIEWOPS_MANUAL_CAPTURE_PROBE==='1';
  if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.GITHUB_REPOSITORY!=='season-framework/reviewops-local'||(!prototype&&!manual)||env.REVIEWOPS_HOSTED_CAPTURE_PROBE!=='1'||!['win32','darwin'].includes(platform)||arch!=='x64') {
    throw new Error('This diagnostic runs only on the reviewed probe push or explicit main dispatch in GitHub-hosted Windows/Intel macOS jobs.');
  }
}

function inside(parent,child) {
  const relative=path.relative(parent,child);
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}

function validateConfig(value) {
  if(!value||!CASES.some(item=>item.id===value.id)||!path.isAbsolute(value.runDirectory)||!path.basename(value.runDirectory).startsWith('rvhcap-')||!inside(value.runDirectory,value.profile)||!inside(value.runDirectory,value.result))throw new Error('Invalid owned probe configuration.');
  return CASES.find(item=>item.id===value.id);
}

// Child processes do not inherit API tokens, SSH agents, application settings or model configuration.
function childEnvironment(env,profile) {
  const allowed=['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL','DISPLAY','XDG_RUNTIME_DIR','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_EVENT_NAME','REVIEWOPS_HOSTED_CAPTURE_PROBE','REVIEWOPS_MANUAL_CAPTURE_PROBE'];
  const result=Object.fromEntries(allowed.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
  return {...result,HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata')};
}

function sourcePreserved(before,after) {
  return Boolean(before&&after&&typeof before.instance==='string'&&before.instance.length>0&&typeof before.form==='string'&&before.form.length>0&&typeof before.url==='string'&&/^http:\/\/127\.0\.0\.1:\d+\/fixture$/.test(before.url)&&Number.isInteger(before.requests)&&before.requests>0&&Number.isInteger(before.webContentsId)&&before.webContentsId>0&&before.instance===after.instance&&before.form===after.form&&before.url===after.url&&before.requests===after.requests&&before.webContentsId===after.webContentsId);
}

function geometryPreserved(before,after) {
  const rectangle=value=>value&&['x','y','width','height'].every(key=>Number.isFinite(value[key]))&&value.width>0&&value.height>0;
  const sameRect=(a,b)=>rectangle(a)&&rectangle(b)&&['x','y','width','height'].every(key=>a[key]===b[key]);
  return Boolean(before&&after&&['innerWidth','innerHeight','devicePixelRatio'].every(key=>Number.isFinite(before[key])&&before[key]>0&&before[key]===after[key])&&sameRect(before.viewBounds,after.viewBounds)&&sameRect(before.clipBounds,after.clipBounds));
}

module.exports={BRANCH,CASES,CAPTURE_TIMEOUT_MS,HIDDEN_SETTLE_MS,CHILD_TIMEOUT_MS,GEOMETRY,hostedOnly,inside,validateConfig,childEnvironment,sourcePreserved,geometryPreserved};
