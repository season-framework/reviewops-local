'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { querySharedData } = require('../electron/shared-data-query.cjs');

const DATE = '2026-11-02T00:00:00.000Z';
const PROJECT_KEYS = ['createdAt', 'description', 'id', 'name', 'updatedAt'];
const REVIEW_KEYS = ['body', 'category', 'createdAt', 'id', 'number', 'priority', 'projectId', 'status', 'title', 'updatedAt'];
const caller = (...projectIds) => ({ projectGrants: projectIds.map(projectId => ({ projectId, read: true })) });
const project = id => ({ id, name: 'Shared project', description: 'Intended shared description', createdAt: DATE, updatedAt: DATE,
  groupId: 'PRIVATE_GROUP', serviceIds: ['PRIVATE_SERVICE'], connection: { privateKeyPath: 'PRIVATE_KEY_PATH' },
  intro: 'PRIVATE_INTRO', memo: 'PRIVATE_MEMO', labels: ['PRIVATE_LABEL'], operationalStatus: 'disabled' });
const review = (id, projectId) => ({ id, projectId, number: 1, title: 'Shared title', body: 'Intended shared body',
  status: 'open', priority: 'normal', category: 'ux', createdAt: DATE, updatedAt: DATE,
  serviceId: 'PRIVATE_SERVICE', targetPath: 'PRIVATE_TARGET_PATH', targetUrl: 'https://PRIVATE_TARGET_URL.invalid',
  evidence: { network_log: [{ authorization: 'PRIVATE_AUTH' }] }, executionSettings: { binary: 'PRIVATE_BINARY' } });
const snapshot = () => ({ projects: [project('a'), project('b')], reviews: [review('review-a', 'a'), review('review-b', 'b')],
  settings: { token: 'PRIVATE_SETTINGS' }, services: [{ host: 'PRIVATE_HOST' }],
  activities: [{ body: 'PRIVATE_AGENT_OUTPUT' }], attachments: [{ storageName: 'PRIVATE_STORAGE' }],
  agentRuns: [{ prompt: 'PRIVATE_PROMPT', error: 'PRIVATE_ERROR' }] });
function errorOf(callback) {
  try { callback(); } catch (error) { return { code: error.code, message: error.message }; }
  assert.fail('Expected a rejected query');
}
function frozen(value) {
  for (const entry of Object.values(value)) if (entry && typeof entry === 'object') frozen(entry);
  return Object.freeze(value);
}
function noPrivateFields(value) {
  assert.equal(JSON.stringify(value).includes('PRIVATE_'), false);
}

test('only explicitly readable projects are listed in fresh exact DTOs', () => {
  const source = snapshot();
  const result = querySharedData(source, caller('a'), 'projects.list', {});
  assert.deepEqual(Object.keys(result).sort(), ['projects', 'version']);
  assert.equal(result.version, 1);
  assert.deepEqual(result.projects.map(row => row.id), ['a']);
  assert.deepEqual(Object.keys(result.projects[0]).sort(), PROJECT_KEYS);
  assert.deepEqual(result.projects[0], { id: 'a', name: 'Shared project', description: 'Intended shared description', createdAt: DATE, updatedAt: DATE });
  assert.notEqual(result.projects[0], source.projects[0]);
  noPrivateFields(result);
});

test('list and get use one exact review projection and explicit project scope', () => {
  const source = snapshot();
  const listed = querySharedData(source, caller('a'), 'reviews.list', { projectId: 'a' });
  const got = querySharedData(source, caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-a' });
  assert.deepEqual(Object.keys(listed).sort(), ['projectId', 'reviews', 'version']);
  assert.deepEqual(Object.keys(got).sort(), ['projectId', 'review', 'version']);
  assert.deepEqual(listed.reviews.map(row => row.id), ['review-a']);
  assert.deepEqual(Object.keys(got.review).sort(), REVIEW_KEYS);
  assert.deepEqual(listed.reviews[0], got.review);
  assert.notEqual(listed.reviews[0], got.review);
  assert.notEqual(got.review, source.reviews[0]);
  noPrivateFields(listed);
  noPrivateFields(got);
});

test('missing, unshared and wrong-project resources have the same non-echoing error', () => {
  const source = snapshot();
  const expected = { code: 'NOT_FOUND', message: 'Shared resource not found.' };
  for (const [context, operation, payload] of [
    [caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-b' }],
    [caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'absent' }],
    [caller('a'), 'reviews.get', { projectId: 'b', reviewId: 'review-b' }],
    [caller('a'), 'reviews.get', { projectId: 'absent', reviewId: 'review-b' }],
    [caller('absent'), 'reviews.get', { projectId: 'absent', reviewId: 'review-b' }],
    [caller(), 'reviews.list', { projectId: 'a' }],
    [caller(), 'reviews.list', { projectId: 'absent' }]
  ]) assert.deepEqual(errorOf(() => querySharedData(source, context, operation, payload)), expected);
});

test('empty grants and grants for deleted projects disclose no project existence', () => {
  const source = snapshot();
  assert.deepEqual(querySharedData(source, caller(), 'projects.list', {}), { version: 1, projects: [] });
  assert.deepEqual(querySharedData(source, caller('absent'), 'projects.list', {}), { version: 1, projects: [] });
  assert.deepEqual(querySharedData({ projects: [project('a')], reviews: [] }, caller('a'), 'reviews.list', { projectId: 'a' }), { version: 1, projectId: 'a', reviews: [] });
});

test('missing, malformed, duplicate or broadened grants fail closed', () => {
  const source = snapshot();
  const invalid = [undefined, null, {}, [], { projectGrants: null }, { projectGrants: {} },
    { projectGrants: [{ projectId: 'a' }] }, { projectGrants: [{ projectId: 'a', read: false }] },
    { projectGrants: [{ projectId: 'a', read: 'true' }] }, { projectGrants: [{ projectId: '*', read: true }] },
    { projectGrants: [{ projectId: 'a', read: true, write: true }] },
    { projectGrants: [{ projectId: 'a', read: true }, { projectId: 'a', read: true }] },
    { projectGrants: [{ projectId: 'a', read: true }, null] }, { ...caller('a'), authenticated: true }];
  for (const context of invalid) assert.equal(errorOf(() => querySharedData(source, context, 'projects.list', {})).code, 'ACCESS_DENIED');
});

test('existing operation payloads remain exact and unsupported operations stay rejected', () => {
  const source = snapshot();
  const invalid = [
    ['snapshot', {}], ['dispatch', {}], ['reviews.update', { projectId: 'a', reviewId: 'review-a' }],
    ['projects.list', undefined], ['projects.list', []], ['projects.list', { projectId: 'a' }],
    ['projects.list', { projectGrants: caller('b').projectGrants }],
    ['reviews.list', {}], ['reviews.list', { projectId: 'a', deviceId: 'trusted' }],
    ['reviews.get', { projectId: 'a' }], ['reviews.get', { reviewId: 'review-a' }],
    ['reviews.get', { projectId: 'a', reviewId: 'review-a', role: 'owner' }],
    ['reviews.get', { projectId: 'a', reviewId: 'review-a', requestId: 'ignored' }]
  ];
  for (const [operation, payload] of invalid) assert.equal(errorOf(() => querySharedData(source, caller('a'), operation, payload)).code, 'INVALID_QUERY');
});

test('malformed identifiers are rejected without normalization or fallback', () => {
  for (const bad of ['', ' a', 'a ', '../a', 'a/b', 'a\0', '*', 'a'.repeat(129), 1, null]) {
    assert.equal(errorOf(() => querySharedData(snapshot(), caller('a'), 'reviews.list', { projectId: bad })).code, 'INVALID_QUERY');
    assert.equal(errorOf(() => querySharedData(snapshot(), caller('a'), 'reviews.get', { projectId: 'a', reviewId: bad })).code, 'INVALID_QUERY');
  }
});

test('payload accessors, symbols and hidden extra fields are not evaluated or accepted', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'projectId', { enumerable: true, get() { reads++; return 'a'; } });
  const hidden = Object.defineProperty({ projectId: 'a' }, 'deviceId', { value: 'trusted' });
  const symbol = { projectId: 'a', [Symbol('grants')]: caller('b') };
  for (const payload of [accessor, hidden, symbol]) assert.equal(errorOf(() => querySharedData(snapshot(), caller('a'), 'reviews.list', payload)).code, 'INVALID_QUERY');
  assert.equal(reads, 0);
});

test('stored private getters and nested private records are never read or serialized', () => {
  const source = snapshot(); let reads = 0;
  Object.defineProperty(source.reviews[0], 'evidence', { enumerable: true, get() { reads++; throw new Error('PRIVATE_GETTER'); } });
  Object.defineProperty(source.projects[0], 'connection', { enumerable: true, get() { reads++; throw new Error('PRIVATE_GETTER'); } });
  noPrivateFields(querySharedData(source, caller('a'), 'projects.list', {}));
  noPrivateFields(querySharedData(source, caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-a' }));
  assert.equal(reads, 0);
});

test('frozen snapshots and caller contexts are unchanged and returned DTOs are detached', () => {
  const source = frozen(snapshot()), context = frozen(caller('a'));
  const beforeSource = JSON.stringify(source), beforeContext = JSON.stringify(context);
  const result = querySharedData(source, context, 'reviews.get', { projectId: 'a', reviewId: 'review-a' });
  result.review.title = 'Caller-local edit';
  const again = querySharedData(source, context, 'reviews.get', { projectId: 'a', reviewId: 'review-a' });
  assert.equal(again.review.title, 'Shared title');
  assert.equal(JSON.stringify(source), beforeSource);
  assert.equal(JSON.stringify(context), beforeContext);
});

test('title and body are shared content, not heuristically scanned or rewritten', () => {
  const source = snapshot();
  source.reviews[0].title = 'User-provided password example';
  source.reviews[0].body = 'Example user text: token=not-a-real-secret\n한국어 日本語';
  const result = querySharedData(source, caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-a' });
  assert.equal(result.review.title, source.reviews[0].title);
  assert.equal(result.review.body, source.reviews[0].body);
});

test('stored enum, text, timestamp and positive integer contracts fail closed', () => {
  for (const [key, value] of [['number', 0], ['number', 1.5], ['number', Number.MAX_SAFE_INTEGER + 1],
    ['status', 'unknown'], ['priority', 'highest'], ['title', ''], ['title', 'x'.repeat(301)],
    ['body', 'x'.repeat(100001)], ['body', null], ['body', 'bad\0text'], ['createdAt', 'yesterday'],
    ['updatedAt', '2026-11-02'], ['category', 'display category name']]) {
    const source = snapshot(); source.reviews[0][key] = value;
    assert.deepEqual(errorOf(() => querySharedData(source, caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-a' })), { code: 'INVALID_SNAPSHOT', message: 'Shared data is unavailable.' });
  }
  for (const [key, value] of [['name', ''], ['name', 'x'.repeat(121)], ['description', null], ['updatedAt', 'invalid']]) {
    const source = snapshot(); source.projects[0][key] = value;
    assert.equal(errorOf(() => querySharedData(source, caller('a'), 'projects.list', {})).code, 'INVALID_SNAPSHOT');
  }
  const source = snapshot(); source.reviews[0].category = 'custom_00000000-0000-0000-0000-000000000000';
  assert.equal(querySharedData(source, caller('a'), 'reviews.get', { projectId: 'a', reviewId: 'review-a' }).review.category, source.reviews[0].category);
});

test('duplicates within the requested project are rejected instead of choosing one row', () => {
  const source = snapshot(); source.reviews.push({ ...source.reviews[0] });
  for (const [operation, payload] of [['reviews.list', { projectId: 'a' }], ['reviews.get', { projectId: 'a', reviewId: 'review-a' }]]) {
    assert.equal(errorOf(() => querySharedData(source, caller('a'), operation, payload)).code, 'INVALID_SNAPSHOT');
  }
  const projects = snapshot(); projects.projects.push({ ...projects.projects[0] });
  assert.equal(errorOf(() => querySharedData(projects, caller('a'), 'projects.list', {})).code, 'INVALID_SNAPSHOT');
  assert.equal(errorOf(() => querySharedData(projects, caller('a'), 'reviews.list', { projectId: 'a' })).code, 'INVALID_SNAPSHOT');
});

test('grant revocation is applied on each query without cached authorization', () => {
  const source = snapshot(), context = caller('a');
  assert.equal(querySharedData(source, context, 'reviews.list', { projectId: 'a' }).reviews.length, 1);
  context.projectGrants = [];
  assert.deepEqual(querySharedData(source, context, 'projects.list', {}), { version: 1, projects: [] });
  assert.equal(errorOf(() => querySharedData(source, context, 'reviews.get', { projectId: 'a', reviewId: 'review-a' })).code, 'NOT_FOUND');
});


test('prototype-shaped stored IDs remain exact IDs without object-key traversal', () => {
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    const source = { projects: [project(id)], reviews: [review('review-a', id)] };
    assert.deepEqual(querySharedData(source, caller(id), 'projects.list', {}).projects.map(row => row.id), [id]);
    assert.equal(querySharedData(source, caller(id), 'reviews.get', { projectId: id, reviewId: 'review-a' }).review.projectId, id);
    assert.equal(errorOf(() => querySharedData(snapshot(), caller('a'), 'reviews.get', { projectId: 'a', reviewId: id })).code, 'NOT_FOUND');
  }
});

const comment = (id, extra = {}) => ({ id, reviewId: 'review-a', type: 'comment', role: 'user', agentRunId: '',
  body: '', createdAt: DATE, updatedAt: DATE, ...extra });
const commentSnapshot = activities => ({ ...snapshot(), activities });
const comments = source => querySharedData(source, caller('a'), 'comments.list', { projectId: 'a', reviewId: 'review-a' });
const commentEnvelope = activities => ({ version: 1, projectId: 'a', reviewId: 'review-a', comments: activities.map(row =>
  ({ id: row.id, reviewId: row.reviewId, body: row.body, createdAt: row.createdAt, updatedAt: row.updatedAt })) });

test('comments expose only unlinked user comment DTOs in the supplied equal-time order', () => {
  let reads = 0;
  const first = comment('z-first', { body: '  Intended user text: token=example\n한국어 日本語 🙂  ', updatedAt: '2026-11-03T00:00:00.000Z' });
  const second = comment('a-second');
  Object.defineProperty(first, 'evidence', { get() { reads++; throw new Error('Private evidence'); } });
  Object.defineProperty(second, 'attachments', { get() { reads++; throw new Error('Private attachments'); } });
  const omitted = [comment('prompt', { agentRunId: 'owned-run' }), comment('reply', { role: 'agent' }),
    comment('system', { role: 'system' }), ...['created', 'updated', 'status'].map(type => comment(type, { type })),
    { reviewId: 'review-b' }];
  for (const row of omitted) for (const key of ['body', 'createdAt', 'updatedAt', 'evidence', 'path'])
    Object.defineProperty(row, key, { get() { reads++; throw new Error('Excluded material'); } });
  const source = commentSnapshot([first, ...omitted, second]);
  const result = comments(source);
  assert.deepEqual(result, commentEnvelope([first, second]));
  assert.deepEqual(Object.keys(result).sort(), ['comments', 'projectId', 'reviewId', 'version']);
  assert.deepEqual(Object.keys(result.comments[0]).sort(), ['body', 'createdAt', 'id', 'reviewId', 'updatedAt']);
  assert.equal(reads, 0);
  result.comments[0].body = 'Caller-only change';
  assert.equal(comments(source).comments[0].body, first.body);
  assert.deepEqual(comments(commentSnapshot([])).comments, []);
  assert.deepEqual(comments(commentSnapshot([comment('agent-only', { role: 'agent' })])).comments, []);
});

test('old reads and denied comment targets do not inspect activities', () => {
  let reads = 0;
  const source = snapshot();
  Object.defineProperty(source, 'activities', { get() { reads++; throw new Error('Activities not admitted'); } });
  for (const [operation, payload] of [['projects.list', {}], ['reviews.list', { projectId: 'a' }],
    ['reviews.get', { projectId: 'a', reviewId: 'review-a' }]]) {
    const without = snapshot(); delete without.activities;
    assert.deepEqual(querySharedData(source, caller('a'), operation, payload), querySharedData(without, caller('a'), operation, payload));
  }
  const expected = { code: 'NOT_FOUND', message: 'Shared resource not found.' };
  for (const payload of [{ projectId: 'b', reviewId: 'review-b' }, { projectId: 'a', reviewId: 'review-b' },
    { projectId: 'a', reviewId: 'missing' }, { projectId: 'missing', reviewId: 'review-a' }])
    assert.deepEqual(errorOf(() => querySharedData(source, caller('a'), 'comments.list', payload)), expected);
  assert.equal(errorOf(() => querySharedData(source, {}, 'comments.list', { projectId: 'a', reviewId: 'review-a' })).code, 'ACCESS_DENIED');
  assert.equal(reads, 0);
});

test('comment payloads cannot add grants, selection controls or accessor fields', () => {
  const source = commentSnapshot([]); let reads = 0;
  const payload = { projectId: 'a', reviewId: 'review-a' };
  const accessor = Object.defineProperty({ reviewId: 'review-a' }, 'projectId', { get() { reads++; return 'a'; } });
  const hidden = Object.defineProperty({ ...payload }, 'limit', { value: 1 });
  for (const invalid of [undefined, {}, { projectId: 'a' }, { ...payload, role: 'user' },
    { ...payload, projectGrants: caller('b').projectGrants }, { ...payload, cursor: 'next' }, hidden, accessor,
    { ...payload, [Symbol('device')]: 'trusted' }, { ...payload, reviewId: '../other' }])
    assert.deepEqual(errorOf(() => querySharedData(source, caller('a'), 'comments.list', invalid)), { code: 'INVALID_QUERY', message: 'Invalid shared-data query.' });
  assert.equal(reads, 0);
});

test('comment classification and selected primitive fields fail closed without coercion', () => {
  const invalid = [['type', 'other'], ['role', 'unknown'], ['role', undefined], ['agentRunId', undefined],
    ['agentRunId', null], ['agentRunId', '../run'], ['id', 'bad/id'], ['body', null], ['body', 1],
    ['body', 'bad\0text'], ['body', 'x'.repeat(100001)], ['createdAt', 'yesterday'], ['updatedAt', '2026-11-02']];
  const expected = { code: 'INVALID_SNAPSHOT', message: 'Shared data is unavailable.' };
  for (const [key, value] of invalid)
    assert.deepEqual(errorOf(() => comments(commentSnapshot([comment('bad', { [key]: value })]))), expected);
  const missing = comment('missing-role'); delete missing.role;
  assert.deepEqual(errorOf(() => comments(commentSnapshot([missing]))), expected);
  const accessor = comment('accessor'); Object.defineProperty(accessor, 'body', { get() { throw new Error('Must not invoke getter'); } });
  assert.deepEqual(errorOf(() => comments(commentSnapshot([accessor]))), expected);
  for (const activities of [undefined, {}, Array(100001).fill(null)])
    assert.deepEqual(errorOf(() => comments(commentSnapshot(activities))), expected);
  assert.deepEqual(errorOf(() => comments(commentSnapshot([comment('duplicate'), comment('duplicate', { role: 'agent' })]))), expected);
  assert.equal(comments(commentSnapshot([comment('maximum', { body: 'x'.repeat(100000) })])).comments[0].body.length, 100000);
});

test('comment results preserve frozen source values and do not evaluate foreign classification', () => {
  let reads = 0;
  const foreign = { reviewId: 'review-b' };
  Object.defineProperty(foreign, 'role', { get() { reads++; throw new Error('Foreign role'); } });
  const source = commentSnapshot([comment('__proto__', { body: 'Exact\ntext' }), foreign]);
  Object.freeze(source.activities[0]); Object.freeze(foreign); Object.freeze(source.activities); Object.freeze(source);
  const result = comments(source);
  result.comments.push({ id: 'caller-only' }); result.comments[0].body = 'Changed locally';
  assert.deepEqual(comments(source), commentEnvelope([source.activities[0]]));
  assert.equal(reads, 0);
});

test('the 1001st eligible comment refuses before its body or dates are inspected', () => {
  const source = commentSnapshot(Array.from({ length: 1000 }, (_, i) => comment('comment-' + i)));
  assert.equal(comments(source).comments.length, 1000);
  const overflow = comment('overflow'); let reads = 0;
  for (const key of ['body', 'createdAt', 'updatedAt']) Object.defineProperty(overflow, key, { get() { reads++; throw new Error('Beyond count budget'); } });
  source.activities.push(overflow);
  assert.deepEqual(errorOf(() => comments(source)), { code: 'QUERY_LIMIT_EXCEEDED', message: 'Shared comments exceed the local query limit.' });
  assert.equal(reads, 0);
});

test('the exact UTF-8 JSON envelope budget includes escaping, Unicode and separators', () => {
  const limit = 4194304;
  const activities = Array.from({ length: 50 }, (_, i) => comment('bytes-' + i));
  activities[0].body = '한"\\\n🙂'.repeat(10000);
  let remaining = limit - Buffer.byteLength(JSON.stringify(commentEnvelope(activities)), 'utf8');
  for (const row of activities.slice(1)) {
    const length = Math.min(100000, remaining); row.body = 'x'.repeat(length); remaining -= length;
  }
  assert.equal(remaining, 0, 'The fixture must reach the exact public envelope boundary');
  const expected = commentEnvelope(activities);
  assert.equal(Buffer.byteLength(JSON.stringify(expected), 'utf8'), limit);
  assert.ok(JSON.stringify(expected).length < limit, 'Character counts are not UTF-8 byte counts');
  assert.deepEqual(comments(commentSnapshot(activities)), expected);
  activities.find(row => row.body.length < 100000).body += 'x';
  assert.deepEqual(errorOf(() => comments(commentSnapshot(activities))), { code: 'QUERY_LIMIT_EXCEEDED', message: 'Shared comments exceed the local query limit.' });
});

const attachment = (id, extra = {}) => ({ id, reviewId: 'review-a', activityId: null, name: 'Evidence.txt',
  mimeType: 'text/plain', size: 0, sha256: 'F'.repeat(64), createdAt: DATE, updatedAt: DATE,
  storageName: 'PRIVATE_STORAGE', ...extra });
const attachmentSnapshot = attachments => ({ ...snapshot(), attachments });
const attachments = source => querySharedData(source, caller('a'), 'attachments.list', { projectId: 'a', reviewId: 'review-a' });
const attachmentEnvelope = values => ({ version: 1, projectId: 'a', reviewId: 'review-a', attachments: values.map(row =>
  ({ id: row.id, reviewId: row.reviewId, name: row.name, mimeType: row.mimeType, size: row.size,
    sha256: row.sha256, createdAt: row.createdAt, updatedAt: row.updatedAt })) });

test('direct attachment metadata preserves exact fields, supplied order and detached values', () => {
  const first = attachment('z-first', { name: 'Report:한".txt', mimeType: 'application/x-own; label=한' });
  const second = attachment('a-second', { size: 1073741824, sha256: 'ab'.repeat(32), updatedAt: '2026-11-03T00:00:00.000Z' });
  const source = attachmentSnapshot([first, second]), context = caller('a');
  frozen(source); frozen(context);
  const before = JSON.stringify(source), result = querySharedData(source, context, 'attachments.list', { projectId: 'a', reviewId: 'review-a' });
  assert.deepEqual(result, attachmentEnvelope([first, second]));
  assert.deepEqual(Object.keys(result), ['version', 'projectId', 'reviewId', 'attachments']);
  assert.deepEqual(Object.keys(result.attachments[0]), ['id', 'reviewId', 'name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt']);
  assert.notEqual(result.attachments[0], first); noPrivateFields(result);
  result.attachments[0].name = 'Caller-only.txt'; result.attachments.push({ id: 'caller-only' });
  assert.deepEqual(attachments(source), attachmentEnvelope([first, second]));
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(attachments(attachmentSnapshot([])).attachments, []);
});

test('attachment classification never follows activities or evaluates omitted metadata and paths', () => {
  let reads = 0;
  const poison = row => {
    for (const key of ['name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt', 'storageName', 'path', 'bytes', 'url', 'evidence'])
      Object.defineProperty(row, key, { get() { reads++; throw new Error('Excluded or private attachment material'); } });
    return row;
  };
  const direct = attachment('direct');
  for (const key of ['storageName', 'path', 'bytes', 'url', 'evidence'])
    Object.defineProperty(direct, key, { get() { reads++; throw new Error('Private direct attachment material'); } });
  const linked = ['ordinary-user-comment', 'run-linked-user-prompt', 'agent-response', 'system-history'].map(id =>
    poison({ id: 'file-' + id, reviewId: 'review-a', activityId: id }));
  const foreign = poison({ reviewId: 'review-b' });
  for (const key of ['id', 'activityId']) Object.defineProperty(foreign, key, { get() { reads++; throw new Error('Foreign classification'); } });
  const source = attachmentSnapshot([linked[0], foreign, direct, ...linked.slice(1)]);
  Object.defineProperty(source, 'activities', { get() { reads++; throw new Error('Activities must not be consulted'); } });
  assert.deepEqual(attachments(source), attachmentEnvelope([direct]));
  assert.equal(reads, 0);
});

test('old reads and denied attachment targets do not inspect the attachment collection', () => {
  let reads = 0;
  const source = commentSnapshot([]), without = commentSnapshot([]);
  Object.defineProperty(source, 'attachments', { get() { reads++; throw new Error('Attachments not admitted'); } });
  for (const [operation, payload] of [['projects.list', {}], ['reviews.list', { projectId: 'a' }],
    ['reviews.get', { projectId: 'a', reviewId: 'review-a' }], ['comments.list', { projectId: 'a', reviewId: 'review-a' }]])
    assert.deepEqual(querySharedData(source, caller('a'), operation, payload), querySharedData(without, caller('a'), operation, payload));
  for (const payload of [{ projectId: 'b', reviewId: 'review-b' }, { projectId: 'a', reviewId: 'review-b' },
    { projectId: 'a', reviewId: 'missing' }, { projectId: 'missing', reviewId: 'review-a' }])
    assert.deepEqual(errorOf(() => querySharedData(source, caller('a'), 'attachments.list', payload)), { code: 'NOT_FOUND', message: 'Shared resource not found.' });
  assert.equal(errorOf(() => querySharedData(source, {}, 'attachments.list', { projectId: 'a', reviewId: 'review-a' })).code, 'ACCESS_DENIED');
  assert.equal(reads, 0);
});

test('attachment payloads cannot supply grants, selection controls or accessor values', () => {
  const source = attachmentSnapshot([]), payload = { projectId: 'a', reviewId: 'review-a' }; let reads = 0;
  const accessor = Object.defineProperty({ reviewId: 'review-a' }, 'projectId', { get() { reads++; return 'a'; } });
  const hidden = Object.defineProperty({ ...payload }, 'limit', { value: 1 });
  for (const invalid of [undefined, {}, { projectId: 'a' }, { ...payload, activityId: null },
    { ...payload, projectGrants: caller('b').projectGrants }, { ...payload, cursor: 'next' }, hidden, accessor,
    { ...payload, [Symbol('owner')]: 'trusted' }, { ...payload, reviewId: '../other' }])
    assert.deepEqual(errorOf(() => querySharedData(source, caller('a'), 'attachments.list', invalid)), { code: 'INVALID_QUERY', message: 'Invalid shared-data query.' });
  assert.equal(reads, 0);
});

test('attachment links, metadata primitives and duplicate IDs fail closed without coercion', () => {
  const expected = { code: 'INVALID_SNAPSHOT', message: 'Shared data is unavailable.' };
  for (const [key, value] of [['activityId', undefined], ['activityId', ''], ['activityId', false], ['activityId', '../activity'],
    ['id', 'bad/id'], ['name', '.'], ['name', '..'], ['name', 'a/b'], ['name', 'a\\b'], ['name', ''],
    ['name', '  '], ['name', 'bad\0name'], ['name', 'x'.repeat(256)], ['mimeType', ''], ['mimeType', ' '],
    ['mimeType', null], ['mimeType', 'bad\0type'], ['mimeType', 'x'.repeat(256)], ['size', '0'], ['size', -1],
    ['size', 1.5], ['size', 1073741825], ['size', Number.MAX_SAFE_INTEGER + 1], ['sha256', 'f'.repeat(63)],
    ['sha256', 'g'.repeat(64)], ['sha256', null], ['createdAt', 'yesterday'], ['updatedAt', '2026-11-02']])
    assert.deepEqual(errorOf(() => attachments(attachmentSnapshot([attachment('bad', { [key]: value })]))), expected);
  const missing = attachment('missing'); delete missing.activityId;
  assert.deepEqual(errorOf(() => attachments(attachmentSnapshot([missing]))), expected);
  let reads = 0;
  for (const key of ['activityId', 'name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt']) {
    const row = attachment('accessor'); Object.defineProperty(row, key, { get() { reads++; throw new Error('Must not invoke getter'); } });
    assert.deepEqual(errorOf(() => attachments(attachmentSnapshot([row]))), expected);
  }
  for (const values of [undefined, {}, Array(100001).fill(null),
    [attachment('duplicate'), attachment('duplicate')],
    [attachment('duplicate'), attachment('duplicate', { activityId: 'linked-comment' })]])
    assert.deepEqual(errorOf(() => attachments(attachmentSnapshot(values))), expected);
  assert.equal(reads, 0);
  const maximum = attachment('maximum', { name: 'x'.repeat(255), mimeType: 'y'.repeat(255) });
  assert.deepEqual(attachments(attachmentSnapshot([maximum])), attachmentEnvelope([maximum]));
});

test('the 1001st direct attachment refuses before its metadata getters are inspected', () => {
  const values = Array.from({ length: 1000 }, (_, i) => attachment('attachment-' + i, { name: 'x' }));
  const source = attachmentSnapshot([...values, attachment('linked', { activityId: 'ordinary-comment' }), { reviewId: 'review-b' }]);
  assert.equal(attachments(source).attachments.length, 1000);
  const overflow = attachment('overflow'); let reads = 0;
  for (const key of ['name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt'])
    Object.defineProperty(overflow, key, { get() { reads++; throw new Error('Beyond count budget'); } });
  source.attachments.push(overflow);
  assert.deepEqual(errorOf(() => attachments(source)), { code: 'ATTACHMENT_QUERY_LIMIT_EXCEEDED', message: 'Shared review attachments exceed the local query limit.' });
  assert.equal(reads, 0);
});

test('the attachment UTF-8 envelope accepts exactly 512 KiB and rejects one valid byte more', () => {
  const limit = 524288;
  const values = Array.from({ length: 1000 }, (_, i) => attachment('attachment-' + String(i).padStart(4, '0'),
    { name: 'x', mimeType: 'application/octet-stream' }));
  values[0].name = '한"'.repeat(30);
  let remaining = limit - Buffer.byteLength(JSON.stringify(attachmentEnvelope(values)), 'utf8');
  assert.ok(remaining > 0);
  for (const row of values) for (const key of ['name', 'mimeType']) {
    const length = Math.min(255 - row[key].length, remaining); row[key] += 'x'.repeat(length); remaining -= length;
  }
  assert.equal(remaining, 0, 'Valid metadata fields must reach the complete envelope boundary');
  const expected = attachmentEnvelope(values);
  assert.equal(Buffer.byteLength(JSON.stringify(expected), 'utf8'), limit);
  assert.ok(JSON.stringify(expected).length < limit, 'Character counts must not substitute for UTF-8 bytes');
  assert.deepEqual(attachments(attachmentSnapshot(values)), expected);
  const nonfull = values.find(row => row.name.length < 255); assert.ok(nonfull);
  nonfull.name += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(attachmentEnvelope(values)), 'utf8'), limit + 1);
  assert.equal(values.length, 1000); assert.ok(values.every(row => row.name.length <= 255 && row.mimeType.length <= 255));
  assert.deepEqual(errorOf(() => attachments(attachmentSnapshot(values))), { code: 'ATTACHMENT_QUERY_LIMIT_EXCEEDED', message: 'Shared review attachments exceed the local query limit.' });
});
