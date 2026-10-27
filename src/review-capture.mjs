export function captureTargetKind(targetPath, evidence) {
  return targetPath || evidence?.source === 'file' ? 'file' : 'web';
}

export function capturePreferenceKey(projectId, kind) {
  return `reviewops.capture.${projectId}.${kind}`;
}

export function captureTargetKey(serviceId, kind, targetPath, targetUrl) {
  let url = kind === 'file' ? '' : targetUrl;
  try { url = new URL(url).href; } catch {}
  return JSON.stringify([serviceId, kind, targetPath, url]);
}

export function selectedCaptureMode({kind, available, draftMode, savedMode}) {
  const modes = ['auto', 'browser-partial', 'none'];
  if (modes.includes(draftMode)) return draftMode;
  if (modes.includes(savedMode)) return savedMode;
  return kind === 'file' || available === false ? 'none' : 'browser-partial';
}
