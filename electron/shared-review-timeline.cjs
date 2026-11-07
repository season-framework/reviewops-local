'use strict';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_BYTES = 1024 * 1024;
function fail(code = 'INVALID_SNAPSHOT') {
  throw Object.assign(new Error(code === 'BROWSING_QUERY_LIMIT_EXCEEDED' ?
    'Shared browsing response exceeds the read limit.' : 'Shared data is unavailable.'), {code});
}
function projectReviewTimeline(projectId, reviewId, source) {
  const result = {version: 1, projectId, reviewId, activities: [], attachments: [], agentRuns: []};
  let bytes = Buffer.byteLength(JSON.stringify(result));
  const id = value => typeof value === 'string' && ID.test(value);
  const date = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value));
  const text = max => value => typeof value === 'string' && value.length <= max && !value.includes('\0');
  const oneOf = values => value => values.includes(value);
  const status = oneOf(['open','in_progress','in_review','resolved','recheck','closed']);
  const fields = {
    activities: {id, reviewId: value => value === reviewId, type: oneOf(['comment','created','updated','status']),
      role: oneOf(['user','agent','system']), body: text(100000),
      fromStatus: value => value === '' || status(value), toStatus: value => value === '' || status(value),
      createdAt: date, updatedAt: date},
    attachments: {id, reviewId: value => value === reviewId, activityId: value => value === null || id(value),
      name: value => text(255)(value) && Boolean(value.trim()) && value !== '.' && value !== '..' && !/[/\\]/.test(value),
      mimeType: text(255), size: value => Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 3,
      sha256: value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value), createdAt: date, updatedAt: date},
    agentRuns: {id, reviewId: value => value === reviewId,
      status: oneOf(['queued','running','completed','failed','cancelled','interrupted']), response: text(100000),
      startedAt: date, finishedAt: value => value === null || date(value), createdAt: date, updatedAt: date}
  };
  if (!id(projectId) || !id(reviewId)) fail();
  for (const name of Object.keys(fields)) {
    const rows = source[name], seen = new Set();
    if (!Array.isArray(rows)) fail();
    if (rows.length > 1000) fail('BROWSING_QUERY_LIMIT_EXCEEDED');
    for (const row of rows) {
      const value = {};
      for (const [key, valid] of Object.entries(fields[name])) {
        const descriptor = row && Object.getOwnPropertyDescriptor(row, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !valid(descriptor.value)) fail();
        value[key] = descriptor.value;
      }
      if (seen.has(value.id)) fail();
      seen.add(value.id);
      bytes += Buffer.byteLength(JSON.stringify(value)) + (result[name].length ? 1 : 0);
      if (bytes > MAX_BYTES) fail('BROWSING_QUERY_LIMIT_EXCEEDED');
      result[name].push(value);
    }
  }
  return result;
}
module.exports = {projectReviewTimeline};
