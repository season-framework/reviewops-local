// No native calls or dependencies: the launcher and its tests share this gate.
export const branch = 'refs/heads/codex/macos-virtual-display-prototype';
export const repository = 'season-framework/reviewops-local';
// This helper catches Objective-C exceptions and continues into owned cleanup.
export const objectiveCOwnershipFlags = ['-fobjc-arc', '-fobjc-arc-exceptions'];
export function encodeProbeJSON(value) {
  const limit=128*1024;
  let failure='LAUNCHER_JSON_BUDGET_EXCEEDED';
  try {
    const bytes=JSON.stringify(value)+'\n';
    if(bytes!=='undefined\n'&&Buffer.byteLength(bytes)<=limit)return {bytes,ok:true};
  }catch{failure='LAUNCHER_JSON_ENCODING_FAILED'}
  const hadFailure=['failed','unsupported','refused'].includes(value?.outcome);
  const original=hadFailure&&(value?.code||value?.primaryCode||value?.native?.primaryCode||value?.native?.code);
  const code=typeof original==='string'&&original.length<=256?original:failure;
  return {bytes:JSON.stringify({schema:1,outcome:'failed',code,outputCode:failure,rawReportOmitted:true})+'\n',ok:false};
}
export function executionRefusal(env, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return 'unsupported-platform';
  const exact = {GITHUB_ACTIONS:'true', CI:'true', RUNNER_ENVIRONMENT:'github-hosted', RUNNER_OS:'macOS', GITHUB_REPOSITORY:repository, GITHUB_REF:branch, GITHUB_EVENT_NAME:'push'};
  for (const [name, expected] of Object.entries(exact)) if (env[name] !== expected) return `execution-gate:${name}`;
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) return 'execution-gate:GITHUB_SHA';
  return null;
}

// Compare every existing online display, without guessing which are physical.
// This is stronger than preserving just the physical subset.
export function inventoryDifference(before, after, ownedId = null) {
  const ids = values => values.map(x => x.id).sort((a,b) => a-b);
  if (!Array.isArray(before) || !Array.isArray(after)) return 'invalid-inventory';
  const canonical = value => JSON.stringify(Object.keys(value).sort().map(k => [k, typeof value[k] === 'object' ? canonical(value[k]) : value[k]]));
  const retained = after.filter(x => x.id !== ownedId);
  if (JSON.stringify(ids(before)) !== JSON.stringify(ids(retained))) return 'preexisting-display-ids-changed';
  for (const item of before) {
    const found = retained.find(x => x.id === item.id);
    if (canonical(found) !== canonical(item)) return `preexisting-display-changed:${item.id}`;
  }
  return null;
}

export function verifyNativeResult(result) {
  if (result.outcome !== 'passed') return `native:${result.outcome || 'missing-outcome'}:${result.code || 'unknown'}`;
  if (result.code || result.primaryCode || result.cleanupCode || result.observerCode || result.outputCode || result.diagnosticCode) return 'native-failure-must-not-be-masked';
  const trace=result.topologyDiagnostics;
  if(!trace?.registered || !trace.stopped || !trace.completeAtCutoff || !Number.isInteger(trace.reserved) || trace.reserved<0 || trace.reserved>128 || trace.ready!==trace.reserved) return 'native-topology-observation-incomplete';
  if (!['before','during','after'].every(k => Array.isArray(result[k]))) return 'invalid-inventory';
  if (result.createdDisplays !== 1 || !Number.isInteger(result.ownedDisplayId) || result.ownedDisplayId < 1) return 'invalid-owned-display';
  if(result.settingsApplyCalls!==1)return 'unexpected-settings-apply-count';
  if (result.before.some(x => x.id === result.ownedDisplayId)) return 'owned-id-was-preexisting';
  const owned = result.during.find(x => x.id === result.ownedDisplayId);
  if (!owned || !owned.online || !owned.active || owned.mirrored || owned.modeWidth !== 1920 || owned.modeHeight !== 1080 || owned.pixelWidth !== 1920 || owned.pixelHeight !== 1080 || owned.bounds.width !== 1920 || owned.bounds.height !== 1080) return 'owned-display-mode-not-observed';
  if (owned.modeAvailable !== true || owned.vendor !== 505 || owned.serial !== result.requestedIdentity?.serial || result.requestedIdentity?.vendor !== 505) return 'owned-display-identity-not-observed';
  if (result.ownedModeSetCalls !== 0) return 'unexpected-public-mode-write';
  if (inventoryDifference(result.before, result.during, result.ownedDisplayId)) return 'preexisting-changed-during-lifecycle';
  if (inventoryDifference(result.before, result.afterWindow, result.ownedDisplayId)) return 'preexisting-changed-during-window-placement';
  if (inventoryDifference(result.before, result.after)) return 'cleanup-inventory-mismatch';
  if (!result.cleanupVerified || !result.windowPlacement?.verified || result.windowPlacement.observedScreenId !== result.ownedDisplayId || result.windowPlacement.windowNumber < 1) return 'cleanup-or-window-placement-unverified';
  if (result.capturedFrames !== 0 || result.injectedInputs !== 0 || result.requestedPermissions !== 0) return 'forbidden-side-effect';
  return null;
}

// Validate the separate bounded artifact, not just an optimistic native summary.
export function verifyTopologyTrace(trace,native) {
  if(!trace || trace.schema!==1 || trace.rawReportOmitted || trace.source!==native.source || trace.runId!==native.runId) return 'topology-result-identity-mismatch';
  if(trace.registrationError!==0 || trace.removalError!==0 || trace.failureCode || trace.overflow || trace.clockFailed || trace.completeAtCutoff!==true || trace.inFlightAtSnapshot!==0) return 'topology-observation-failed';
  if(!Array.isArray(trace.events) || trace.events.length>128 || trace.reserved!==trace.events.length || trace.ready!==trace.events.length || native.topologyDiagnostics?.reserved!==trace.reserved) return 'topology-records-incomplete';
  const unsigned=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
  const time=value=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
  for(const [index,event] of trace.events.entries())if(!Array.isArray(event)||event.length!==5||event[0]!==index+1||!time(event[1])||!unsigned(event[2])||!unsigned(event[3])||!Number.isInteger(event[4])||event[4]<0||event[4]>11)return 'topology-record-invalid';
  const expected=['baseline-first','baseline-confirmed','before-init','after-init','before-apply','after-apply','after-window'];
  if(!Array.isArray(trace.stages)||trace.stages.length!==expected.length||trace.stages.some((stage,index)=>stage.stage!==expected[index]||stage.preexistingMatches!==true))return 'topology-stages-incomplete';
  for(const stage of trace.stages){
    const q=stage.query;
    if(!q||!time(q.startNS)||!time(q.endNS)||BigInt(q.endNS)<BigInt(q.startNS)||!unsigned(q.sequenceBefore)||!unsigned(q.sequenceAfter)||q.sequenceBefore>q.sequenceAfter||q.sequenceAfter>trace.reserved)return 'topology-query-invalid';
    if(['after-init','before-apply','after-apply','after-window'].includes(stage.stage)&&(q.objectIDBefore!==native.ownedDisplayId||q.objectIDAfter!==native.ownedDisplayId))return 'topology-owned-id-changed';
  }
  return null;
}
