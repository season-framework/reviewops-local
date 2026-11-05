'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryLocalSharedData } = require('../electron/local-shared-data-query.cjs');
const DATE = '2026-11-02T00:00:00.000Z';
const project = id => ({ id, name: id, description: '', createdAt: DATE, updatedAt: DATE, connection: { host: 'PRIVATE_HOST' } });
const review = (id, projectId) => ({ id, projectId, number: 1, title: id, body: 'Intended shared body', status: 'open', priority: 'normal', category: 'ux', createdAt: DATE, updatedAt: DATE, evidence: { token: 'PRIVATE_EVIDENCE' } });
const snapshot = () => ({ projects: [project('a'), project('b')], reviews: [review('ra', 'a'), review('rb', 'b')] });
function rejected(callback, code) { assert.throws(callback, error => error.code === code); }

test('local shared adapter builds unbound grants from only the current snapshot', () => {
  const source = snapshot();
  assert.deepEqual(queryLocalSharedData(source, '', 'projects.list', {}).projects.map(row => row.id), ['a', 'b']);
  assert.equal(queryLocalSharedData(source, '', 'reviews.get', { projectId: 'b', reviewId: 'rb' }).review.id, 'rb');
  source.projects = [source.projects[0]];
  assert.deepEqual(queryLocalSharedData(source, '', 'projects.list', {}).projects.map(row => row.id), ['a']);
  rejected(() => queryLocalSharedData(source, '', 'reviews.get', { projectId: 'b', reviewId: 'rb' }), 'NOT_FOUND');
});

test('local shared adapter bounds every project-window read to its owner', () => {
  const source = snapshot();
  assert.deepEqual(queryLocalSharedData(source, 'a', 'projects.list', {}).projects.map(row => row.id), ['a']);
  assert.equal(queryLocalSharedData(source, 'a', 'reviews.get', { projectId: 'a', reviewId: 'ra' }).review.id, 'ra');
  for (const [projectId, reviewId] of [['b', 'rb'], ['a', 'rb'], ['absent', 'ra']])
    rejected(() => queryLocalSharedData(source, 'a', 'reviews.get', { projectId, reviewId }), 'NOT_FOUND');
});

test('local shared adapter never broadens a deleted bound project', () => {
  const source = snapshot(); source.projects = [source.projects[1]];
  assert.deepEqual(queryLocalSharedData(source, 'a', 'projects.list', {}), { version: 1, projects: [] });
  rejected(() => queryLocalSharedData(source, 'a', 'reviews.list', { projectId: 'a' }), 'NOT_FOUND');
  rejected(() => queryLocalSharedData(source, 'a', 'reviews.list', { projectId: 'b' }), 'NOT_FOUND');
});

test('local shared adapter does not treat missing or malformed owner scope as unbound', () => {
  for (const owner of [undefined, null, false, 0, {}, ' ', '../a', '*', 'a'.repeat(129)])
    rejected(() => queryLocalSharedData(snapshot(), owner, 'projects.list', {}), 'ACCESS_DENIED');
});

test('local shared adapter keeps payload authorization and unsupported operations rejected', () => {
  const source = snapshot();
  for (const [operation, payload] of [['projects.list', { projectGrants: [{ projectId: 'b', read: true }] }],
    ['reviews.get', { projectId: 'a', reviewId: 'ra', ownerProjectId: '' }], ['reviews.update', { projectId: 'a', reviewId: 'ra' }]])
    rejected(() => queryLocalSharedData(source, 'a', operation, payload), 'INVALID_QUERY');
});

test('local shared adapter returns detached allowlists without mutating frozen inputs', () => {
  const source = snapshot();
  for (const row of [...source.projects, ...source.reviews]) Object.freeze(row);
  Object.freeze(source.projects); Object.freeze(source.reviews); Object.freeze(source);
  const before = JSON.stringify(source), result = queryLocalSharedData(source, 'a', 'reviews.get', { projectId: 'a', reviewId: 'ra' });
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  result.review.title = 'Caller-local change';
  assert.equal(JSON.stringify(source), before);
  assert.equal(queryLocalSharedData(source, 'a', 'reviews.get', { projectId: 'a', reviewId: 'ra' }).review.title, 'ra');
});

test('local shared adapter rejects malformed project indexes without reading accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'projects', { get() { reads++; return []; } });
  for (const source of [accessor, {}, { projects: null }, { projects: [{ id: 'a' }, { id: 'a' }] }, { projects: [{ id: '../a' }] }])
    rejected(() => queryLocalSharedData(source, '', 'projects.list', {}), 'INVALID_SNAPSHOT');
  const row = Object.defineProperty({}, 'id', { get() { reads++; return 'a'; } });
  rejected(() => queryLocalSharedData({ projects: [row], reviews: [] }, '', 'projects.list', {}), 'INVALID_SNAPSHOT');
  assert.equal(reads, 0);
});

test('local shared adapter supports stored prototype-shaped IDs without object traversal', () => {
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    const source = { projects: [project(id)], reviews: [review('ra', id)] };
    assert.deepEqual(queryLocalSharedData(source, '', 'projects.list', {}).projects.map(row => row.id), [id]);
    assert.equal(queryLocalSharedData(source, id, 'reviews.get', { projectId: id, reviewId: 'ra' }).review.projectId, id);
  }
});

test('local comment reads inherit current window grants without payload authority', () => {
  const source = snapshot();
  source.activities = ['a', 'b'].map(projectId => ({ id: 'comment-' + projectId, reviewId: 'r' + projectId,
    type: 'comment', role: 'user', agentRunId: '', body: 'Shared comment ' + projectId, createdAt: DATE, updatedAt: DATE }));
  const a = { projectId: 'a', reviewId: 'ra' }, b = { projectId: 'b', reviewId: 'rb' };
  assert.equal(queryLocalSharedData(source, '', 'comments.list', b).comments[0].id, 'comment-b');
  const result = queryLocalSharedData(source, 'a', 'comments.list', a);
  assert.deepEqual(Object.keys(result.comments[0]).sort(), ['body', 'createdAt', 'id', 'reviewId', 'updatedAt']);
  result.comments[0].body = 'Caller-only edit';
  assert.equal(queryLocalSharedData(source, 'a', 'comments.list', a).comments[0].body, 'Shared comment a');
  rejected(() => queryLocalSharedData(source, 'a', 'comments.list', b), 'NOT_FOUND');
  rejected(() => queryLocalSharedData(source, 'a', 'comments.list', { ...a, projectGrants: [{ projectId: 'b', read: true }] }), 'INVALID_QUERY');
  source.projects = [source.projects[1]];
  for (const target of [a, b]) rejected(() => queryLocalSharedData(source, 'a', 'comments.list', target), 'NOT_FOUND');
});
