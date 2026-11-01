// No native calls or dependencies: the launcher and its tests share this gate.
export const branch = 'refs/heads/codex/macos-virtual-display-prototype';
export const repository = 'season-framework/reviewops-local';
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
  if (!['before','during','after'].every(k => Array.isArray(result[k]))) return 'invalid-inventory';
  if (result.createdDisplays !== 1 || !Number.isInteger(result.ownedDisplayId) || result.ownedDisplayId < 1) return 'invalid-owned-display';
  if (result.before.some(x => x.id === result.ownedDisplayId)) return 'owned-id-was-preexisting';
  const owned = result.during.find(x => x.id === result.ownedDisplayId);
  if (!owned || !owned.online || !owned.active || owned.mirrored || owned.modeWidth !== 1920 || owned.modeHeight !== 1080 || owned.pixelWidth !== 1920 || owned.pixelHeight !== 1080 || owned.bounds.width !== 1920 || owned.bounds.height !== 1080) return 'owned-display-mode-not-observed';
  if (inventoryDifference(result.before, result.during, result.ownedDisplayId)) return 'preexisting-changed-during-lifecycle';
  if (inventoryDifference(result.before, result.afterWindow, result.ownedDisplayId)) return 'preexisting-changed-during-window-placement';
  if (inventoryDifference(result.before, result.after)) return 'cleanup-inventory-mismatch';
  if (!result.cleanupVerified || !result.windowPlacement?.verified || result.windowPlacement.observedScreenId !== result.ownedDisplayId || result.windowPlacement.windowNumber < 1) return 'cleanup-or-window-placement-unverified';
  if (result.capturedFrames !== 0 || result.injectedInputs !== 0 || result.requestedPermissions !== 0) return 'forbidden-side-effect';
  return null;
}
