export const runtimeKindLabels = {
  available: '실행 확인', missing: '실행 파일 없음', permissions: '실행 권한 부족',
  'invalid-version': 'CLI 버전 확인 실패', 'owned-timeout': '실행 시간 초과',
  'abnormal-exit': '비정상 종료', architecture: '아키텍처 불일치',
};
export function runtimeDiagnostics(value) {
  const source = Array.isArray(value?.records) ? value.records : [];
  let omitted = Number.isSafeInteger(value?.omitted) && value.omitted >= 0 ? value.omitted : 0;
  const text = (item, limit) => typeof item === 'string' && item.length <= limit && !/[\x00-\x1f\x7f]/.test(item) ? item : null;
  const records = [];
  for (const item of source.slice(0, 16)) {
    if (!item || !Object.hasOwn(runtimeKindLabels, item.kind)) { omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1); continue; }
    const path = text(item.path, 1024);
    if (!path && !(item.kind === 'missing' && item.path == null)) { omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1); continue; }
    const version = text(item.version, 128), architecture = text(item.architecture, 64), signal = text(item.signal, 32);
    records.push({
      kind: item.kind, path,
      version: version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null,
      architecture: ['arm64', 'x64', 'arm64,x64', 'x64,arm64'].includes(architecture) ? architecture : null,
      code: Number.isSafeInteger(item.code) ? item.code : null,
      signal: signal && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null,
      elapsedMs: Number.isSafeInteger(item.elapsedMs) && item.elapsedMs >= 0 && item.elapsedMs <= 300000 ? item.elapsedMs : null,
    });
  }
  omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + Math.max(0, source.length - 16));
  // Copy only the backend's sanitized diagnostic schema, never runtime errors,
  // raw output, account data, or the unredacted selected runtime path.
  while (new TextEncoder().encode(JSON.stringify({records, omitted}, null, 2)).length > 16 * 1024) { records.shift(); omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1); }
  return {records, omitted};
}

