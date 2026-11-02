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

test('only three operations and their exact required payloads are accepted', () => {
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
