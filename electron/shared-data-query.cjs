'use strict';

const MAX_ROWS = 100000;
const MAX_COMMENTS = 1000;
const MAX_COMMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 1000;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const ACTIVITY_TYPES = new Set(['comment', 'created', 'updated', 'status']);
const ACTIVITY_ROLES = new Set(['user', 'agent', 'system']);
const STATUSES = new Set(['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGES = Object.freeze({
  INVALID_QUERY: 'Invalid shared-data query.',
  ACCESS_DENIED: 'A valid server-owned read grant context is required.',
  NOT_FOUND: 'Shared resource not found.',
  INVALID_SNAPSHOT: 'Shared data is unavailable.',
  QUERY_LIMIT_EXCEEDED: 'Shared comments exceed the local query limit.',
  ATTACHMENT_QUERY_LIMIT_EXCEEDED: 'Shared review attachments exceed the local query limit.',
  COMMENT_ATTACHMENT_QUERY_LIMIT_EXCEEDED: 'Shared comment attachments exceed the local query limit.'
});

function fail(code) {
  throw Object.assign(new Error(MESSAGES[code]), { code });
}
function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value;
}
function field(value, key, code) {
  record(value, code);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}
function closed(value, keys, code) {
  record(value, code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(code);
  for (const key of keys) field(value, key, code);
  return value;
}
function identifier(value, code) {
  if (typeof value !== 'string' || !ID.test(value)) fail(code);
  return value;
}
function rows(value, code) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(code);
  return value;
}
function grants(callerContext) {
  closed(callerContext, ['projectGrants'], 'ACCESS_DENIED');
  const permitted = new Set();
  for (const grant of rows(field(callerContext, 'projectGrants', 'ACCESS_DENIED'), 'ACCESS_DENIED')) {
    closed(grant, ['projectId', 'read'], 'ACCESS_DENIED');
    const projectId = identifier(field(grant, 'projectId', 'ACCESS_DENIED'), 'ACCESS_DENIED');
    if (field(grant, 'read', 'ACCESS_DENIED') !== true || permitted.has(projectId)) fail('ACCESS_DENIED');
    permitted.add(projectId);
  }
  return permitted;
}
function queryPayload(operation, payload) {
  const keys = operation === 'projects.list' ? [] : operation === 'reviews.list' ? ['projectId'] :
    operation === 'commentAttachments.list' ? ['projectId', 'reviewId', 'commentId'] :
    operation === 'reviews.get' || operation === 'comments.list' || operation === 'attachments.list' ? ['projectId', 'reviewId'] : null;
  if (!keys) fail('INVALID_QUERY');
  closed(payload, keys, 'INVALID_QUERY');
  for (const key of keys) identifier(field(payload, key, 'INVALID_QUERY'), 'INVALID_QUERY');
}
function storedText(row, key, max, required = false) {
  const value = field(row, key, 'INVALID_SNAPSHOT');
  if (typeof value !== 'string' || value.length > max || value.includes('\0') ||
      required && !value.trim()) fail('INVALID_SNAPSHOT');
  return value;
}
function storedId(row, key) {
  return identifier(field(row, key, 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
}
function storedDate(row, key) {
  const value = field(row, key, 'INVALID_SNAPSHOT');
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) fail('INVALID_SNAPSHOT');
  return value;
}
function projectDto(row) {
  return { id: storedId(row, 'id'), name: storedText(row, 'name', 120, true),
    description: storedText(row, 'description', 10000),
    createdAt: storedDate(row, 'createdAt'), updatedAt: storedDate(row, 'updatedAt') };
}
function reviewDto(row) {
  const number = field(row, 'number', 'INVALID_SNAPSHOT');
  const status = field(row, 'status', 'INVALID_SNAPSHOT');
  const priority = field(row, 'priority', 'INVALID_SNAPSHOT');
  if (!Number.isSafeInteger(number) || number < 1 || !STATUSES.has(status) || !PRIORITIES.has(priority)) fail('INVALID_SNAPSHOT');
  return { id: storedId(row, 'id'), projectId: storedId(row, 'projectId'), number,
    title: storedText(row, 'title', 300, true), body: storedText(row, 'body', 100000), status, priority,
    category: storedId(row, 'category'), createdAt: storedDate(row, 'createdAt'), updatedAt: storedDate(row, 'updatedAt') };
}
function unique(rowsToProject, projector) {
  const seen = new Set();
  return rowsToProject.map(row => {
    const dto = projector(row);
    if (seen.has(dto.id)) fail('INVALID_SNAPSHOT');
    seen.add(dto.id);
    return dto;
  });
}

function commentList(snapshot, projectId, reviewId) {
  const activities = rows(field(snapshot, 'activities', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  const result = { version: 1, projectId, reviewId, comments: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const seen = new Set();
  for (const row of activities) {
    if (storedId(row, 'reviewId') !== reviewId) continue;
    const id = storedId(row, 'id');
    if (seen.has(id)) fail('INVALID_SNAPSHOT');
    seen.add(id);
    const type = field(row, 'type', 'INVALID_SNAPSHOT'), role = field(row, 'role', 'INVALID_SNAPSHOT');
    if (!ACTIVITY_TYPES.has(type) || !ACTIVITY_ROLES.has(role)) fail('INVALID_SNAPSHOT');
    if (type !== 'comment' || role !== 'user') continue;
    const run = field(row, 'agentRunId', 'INVALID_SNAPSHOT');
    if (typeof run !== 'string' || run !== '' && !ID.test(run)) fail('INVALID_SNAPSHOT');
    // Agent prompts also use the user role; their nonempty run link excludes them.
    if (run !== '') continue;
    if (result.comments.length === MAX_COMMENTS) fail('QUERY_LIMIT_EXCEEDED');
    const comment = { id, reviewId, body: storedText(row, 'body', 100000),
      createdAt: storedDate(row, 'createdAt'), updatedAt: storedDate(row, 'updatedAt') };
    const addition = Buffer.byteLength(JSON.stringify(comment), 'utf8') + (result.comments.length ? 1 : 0);
    if (bytes + addition > MAX_COMMENT_BYTES) fail('QUERY_LIMIT_EXCEEDED');
    bytes += addition;
    result.comments.push(comment);
  }
  return result;
}

// Only direct review attachments are eligible. Non-null activity links are
// excluded without inspecting activities, comment bodies, roles or run data.
function attachmentList(snapshot, projectId, reviewId) {
  const attachments = rows(field(snapshot, 'attachments', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  const result = { version: 1, projectId, reviewId, attachments: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const seen = new Set();
  for (const row of attachments) {
    if (storedId(row, 'reviewId') !== reviewId) continue;
    const id = storedId(row, 'id');
    if (seen.has(id)) fail('INVALID_SNAPSHOT');
    seen.add(id);
    const activityId = field(row, 'activityId', 'INVALID_SNAPSHOT');
    if (activityId !== null) {
      identifier(activityId, 'INVALID_SNAPSHOT');
      continue;
    }
    if (result.attachments.length === MAX_ATTACHMENTS) fail('ATTACHMENT_QUERY_LIMIT_EXCEEDED');
    const name = storedText(row, 'name', 255, true);
    if (name === '.' || name === '..' || /[/\\]/.test(name)) fail('INVALID_SNAPSHOT');
    const mimeType = storedText(row, 'mimeType', 255, true);
    const size = field(row, 'size', 'INVALID_SNAPSHOT');
    const sha256 = storedText(row, 'sha256', 64, true);
    if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/i.test(sha256)) fail('INVALID_SNAPSHOT');
    const attachment = { id, reviewId, name, mimeType, size, sha256,
      createdAt: storedDate(row, 'createdAt'), updatedAt: storedDate(row, 'updatedAt') };
    const addition = Buffer.byteLength(JSON.stringify(attachment), 'utf8') + (result.attachments.length ? 1 : 0);
    if (bytes + addition > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_QUERY_LIMIT_EXCEEDED');
    bytes += addition;
    result.attachments.push(attachment);
  }
  return result;
}

// Authorize the selected ordinary user comment before reading attachment rows.
// Comment content is not part of this metadata projection.
function commentAttachmentList(snapshot, projectId, reviewId, commentId) {
  const activities = rows(field(snapshot, 'activities', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  const seenActivities = new Set();
  let selected = null;
  for (const row of activities) {
    if (storedId(row, 'reviewId') !== reviewId) continue;
    const id = storedId(row, 'id');
    if (seenActivities.has(id)) fail('INVALID_SNAPSHOT');
    seenActivities.add(id);
    if (id === commentId) selected = row;
  }
  if (!selected) fail('NOT_FOUND');
  const type = field(selected, 'type', 'INVALID_SNAPSHOT');
  const role = field(selected, 'role', 'INVALID_SNAPSHOT');
  const run = field(selected, 'agentRunId', 'INVALID_SNAPSHOT');
  if (!ACTIVITY_TYPES.has(type) || !ACTIVITY_ROLES.has(role) ||
      typeof run !== 'string' || run !== '' && !ID.test(run)) fail('INVALID_SNAPSHOT');
  if (type !== 'comment' || role !== 'user' || run !== '') fail('NOT_FOUND');

  const attachments = rows(field(snapshot, 'attachments', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  const result = { version: 1, projectId, reviewId, commentId, attachments: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const seen = new Set();
  for (const row of attachments) {
    if (storedId(row, 'reviewId') !== reviewId) continue;
    const id = storedId(row, 'id');
    if (seen.has(id)) fail('INVALID_SNAPSHOT');
    seen.add(id);
    const activityId = field(row, 'activityId', 'INVALID_SNAPSHOT');
    if (activityId !== null) identifier(activityId, 'INVALID_SNAPSHOT');
    if (activityId !== commentId) continue;
    if (result.attachments.length === MAX_ATTACHMENTS) fail('COMMENT_ATTACHMENT_QUERY_LIMIT_EXCEEDED');
    const name = storedText(row, 'name', 255, true);
    if (name === '.' || name === '..' || /[/\\]/.test(name)) fail('INVALID_SNAPSHOT');
    const mimeType = storedText(row, 'mimeType', 255, true);
    const size = field(row, 'size', 'INVALID_SNAPSHOT');
    const sha256 = storedText(row, 'sha256', 64, true);
    if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/i.test(sha256)) fail('INVALID_SNAPSHOT');
    const attachment = { id, reviewId, name, mimeType, size, sha256,
      createdAt: storedDate(row, 'createdAt'), updatedAt: storedDate(row, 'updatedAt') };
    const addition = Buffer.byteLength(JSON.stringify(attachment), 'utf8') + (result.attachments.length ? 1 : 0);
    if (bytes + addition > MAX_ATTACHMENT_BYTES) fail('COMMENT_ATTACHMENT_QUERY_LIMIT_EXCEEDED');
    bytes += addition;
    result.attachments.push(attachment);
  }
  return result;
}

// Caller context is application-owned. Future adapters must never take grants
// from the operation payload or treat this pure function as device authentication.
function querySharedData(snapshot, callerContext, operation, payload) {
  const permitted = grants(callerContext);
  queryPayload(operation, payload);
  const projects = rows(field(snapshot, 'projects', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  const reviews = rows(field(snapshot, 'reviews', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT');
  if (operation === 'projects.list') {
    const visible = projects.filter(row => permitted.has(storedId(row, 'id')));
    return { version: 1, projects: unique(visible, projectDto) };
  }

  const projectId = payload.projectId;
  // Check the explicit project grant before looking up either resource. Missing,
  // unshared, and wrong-project resource IDs use the same fixed public error.
  if (!permitted.has(projectId)) fail('NOT_FOUND');
  const matchingProjects = projects.filter(row => storedId(row, 'id') === projectId);
  if (!matchingProjects.length) fail('NOT_FOUND');
  if (matchingProjects.length !== 1) fail('INVALID_SNAPSHOT');
  projectDto(matchingProjects[0]);
  const ownReviews = reviews.filter(row => storedId(row, 'projectId') === projectId);
  if (operation === 'reviews.list') return { version: 1, projectId, reviews: unique(ownReviews, reviewDto) };
  const matches = ownReviews.filter(row => storedId(row, 'id') === payload.reviewId);
  if (!matches.length) fail('NOT_FOUND');
  if (matches.length !== 1) fail('INVALID_SNAPSHOT');
  const review = reviewDto(matches[0]);
  if (operation === 'comments.list') return commentList(snapshot, projectId, review.id);
  if (operation === 'attachments.list') return attachmentList(snapshot, projectId, review.id);
  if (operation === 'commentAttachments.list') return commentAttachmentList(snapshot, projectId, review.id, payload.commentId);
  return { version: 1, projectId, review };
}

module.exports = { querySharedData };
