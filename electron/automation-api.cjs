'use strict';
const crypto = require('node:crypto');

const fail = (message, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), { code }); };
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const string = maxLength => ({ type: 'string', maxLength });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const target = { projectId: ID, reviewId: ID };
const reviewFields = { title: { ...string(300), minLength: 1 }, body: string(100000), status: { type: 'string', enum: ['open','in_progress','in_review','resolved','recheck','closed'] }, priority: { type: 'string', enum: ['low','normal','high','critical'] }, category: string(128), targetPath: string(4096), targetUrl: string(8192) };
const dataTools = [
  ['projects_list', 'projects.list', 'List ReviewOps projects and connection names without opening a window.', schema({})],
  ['reviews_list', 'reviews.list', 'List reviews belonging to the specified project without changing a window.', schema({ projectId: ID }, ['projectId'])],
  ['review_get', 'reviews.get', 'Read one review and its activity history. Project and review must match.', schema(target, ['projectId','reviewId'])],
  ['review_create', 'reviews.create', 'Create a review without opening a window. Reuse requestId only for an identical retry.', schema({ projectId: ID, requestId: ID, serviceId: ID, ...reviewFields }, ['projectId','requestId','title'])],
  ['review_update', 'reviews.update', 'Edit a review in its existing project. Only supplied fields change.', schema({ ...target, ...reviewFields }, ['projectId','reviewId'])],
  ['run_start', 'runs.start', 'Start work in the review project using its configured agent. Returns immediately with a run ID; use run_get for progress, logs and result. Reuse requestId only for an identical retry.', schema({ ...target, requestId: ID, prompt: { ...string(100000), minLength: 1 }, model: string(256), reasoningEffort: { type: 'string', enum: ['','none','minimal','low','medium','high','xhigh','max','ultra'] }, newConversation: { type: 'boolean' } }, ['projectId','reviewId','requestId','prompt'])],
  ['run_list', 'runs.list', 'List runs belonging to a review, including their status. Project and review must match.', schema(target, ['projectId','reviewId'])],
  ['run_get', 'runs.get', 'Read status, progress, output log, response and error for one run. All three target IDs must match.', schema({ ...target, runId: ID }, ['projectId','reviewId','runId'])],
  ['run_cancel', 'runs.cancel', 'Cancel only the specified run after checking its project and review.', schema({ ...target, runId: ID }, ['projectId','reviewId','runId'])]
].map(([name, action, description, inputSchema]) => ({ name: 'reviewops_' + name, action: 'automation.' + action, description, inputSchema,
  annotations: { readOnlyHint: ['projects.list','reviews.list','reviews.get','runs.list','runs.get'].includes(action), destructiveHint: action === 'runs.cancel', openWorldHint: action === 'runs.start' } }));

function validate(schema, value, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key))) fail(`${label} contains an unsupported field.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) if (schema.properties?.[key]) validate(schema.properties[key], item, `${label}.${key}`);
    return;
  }
  if (schema.type === 'string' && (typeof value !== 'string' || value.includes('\0') || schema.minLength !== undefined && value.trim().length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value))) fail(`${label} is invalid.`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail(`${label} must be a boolean.`);
  if (['number','integer'].includes(schema.type) && (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) fail(`${label} is invalid.`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${label} is invalid.`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${label} is invalid.`);
    value.forEach((item, index) => validate(schema.items, item, `${label}[${index}]`));
  }
}
const id = value => { validate(ID, value, 'ID'); if (['__proto__','constructor','prototype'].includes(value)) fail('ID is invalid.'); return value; };
const hash = payload => crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a],[b]) => a.localeCompare(b))))).digest('hex');

function createAutomationApi({ dispatch, qa } = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('dispatch is required');
  let mutations = Promise.resolve();
  const exclusive = callback => { const operation = mutations.then(callback); mutations = operation.catch(() => {}); return operation; };
  async function perform(action, payload) {
    const snapshot = await dispatch('snapshot');
    if (action === 'automation.projects.list') return { projects: snapshot.projects.map(project => ({
      id: project.id, projectId: project.id, name: project.name, description: project.description || '',
      connections: (project.serviceIds || (project.connection?.id ? [project.connection.id] : [])).map(serviceId => snapshot.services.find(service => service.id === serviceId && service.groupId === project.groupId)).filter(Boolean).map(service => ({ serviceId: service.id, name: service.name, kind: service.kind, workPath: service.agentWorkPath || service.rootPath || '' }))
    })) };
    const project = snapshot.projects.find(item => item.id === id(payload.projectId));
    if (!project) fail('프로젝트를 찾을 수 없습니다.', 'NOT_FOUND');
    const projectId = project.id;
    if (action === 'automation.reviews.list') return { projectId, reviews: snapshot.reviews.filter(review => review.projectId === projectId) };
    if (action === 'automation.reviews.create') {
      const requestId = id(payload.requestId), fingerprint = hash(payload);
      const matches = snapshot.reviews.filter(review => review.evidence?.automation?.requestId === requestId);
      if (matches.length > 1 || matches.length && (matches[0].projectId !== projectId || matches[0].evidence.automation.fingerprint !== fingerprint)) fail('이미 사용한 요청 ID입니다. 새 요청 ID를 지정하십시오.', 'REQUEST_ID_CONFLICT');
      if (matches.length) return { projectId, reviewId: matches[0].id, review: matches[0], reused: true };
      const { requestId: unused, ...fields } = payload;
      const services = project.serviceIds || (project.connection?.id ? [project.connection.id] : []);
      if (fields.serviceId === undefined && services.length > 1) fail('프로젝트 연결이 여러 개입니다. serviceId를 지정하십시오.', 'AMBIGUOUS_TARGET');
      if (fields.serviceId !== undefined && !services.includes(fields.serviceId)) fail('연결이 지정한 프로젝트에 속하지 않습니다.', 'TARGET_MISMATCH');
      if (fields.serviceId === undefined && services.length === 1) fields.serviceId = services[0];
      const review = await dispatch('review.save', { ...fields, evidence: { automation: { version: 1, requestId, fingerprint } } });
      return { projectId, reviewId: review.id, review, reused: false };
    }
    const review = snapshot.reviews.find(item => item.id === id(payload.reviewId));
    if (!review || review.projectId !== projectId) fail('리뷰가 지정한 프로젝트에 속하지 않습니다.', 'TARGET_MISMATCH');
    const reviewId = review.id;
    if (action === 'automation.reviews.get') return { projectId, reviewId, review, activities: snapshot.activities.filter(item => item.reviewId === reviewId) };
    if (action === 'automation.reviews.update') {
      const { projectId: unusedProject, reviewId: unusedReview, ...fields } = payload;
      if (!Object.keys(fields).length) fail('수정할 내용을 지정하십시오.');
      return { projectId, reviewId, review: await dispatch('review.save', { id: reviewId, projectId, ...fields }) };
    }
    if (action === 'automation.runs.start') {
      const { projectId: unused, ...fields } = payload;
      const run = await dispatch('agent.start', fields);
      if (run.reviewId !== reviewId) fail('작업 실행이 지정한 리뷰에 속하지 않습니다.', 'TARGET_MISMATCH');
      return { projectId, reviewId, runId: run.id, run };
    }
    const runs = await dispatch('agent.list', { reviewId });
    if (action === 'automation.runs.list') return { projectId, reviewId, runs };
    const runId = id(payload.runId), belongs = runs.find(run => run.id === runId && run.reviewId === reviewId);
    if (!belongs) fail('작업 실행이 지정한 리뷰에 속하지 않습니다.', 'TARGET_MISMATCH');
    if (action === 'automation.runs.get') {
      const run = await dispatch('agent.read', { id: runId });
      if (run.reviewId !== reviewId) fail('작업 실행이 지정한 리뷰에 속하지 않습니다.', 'TARGET_MISMATCH');
      return { projectId, reviewId, runId, run };
    }
    if (action === 'automation.runs.cancel') return { projectId, reviewId, runId, result: await dispatch('agent.cancel', { id: runId }) };
    fail('지원하지 않는 외부 요청입니다.', 'UNKNOWN_ACTION');
  }
  async function handle(action, payload = {}) {
    if (action.startsWith('automation.qa.')) {
      if (typeof qa !== 'function') fail('창 조작 기능을 사용할 수 없습니다.', 'UNAVAILABLE');
      return qa(action.slice('automation.qa.'.length), payload);
    }
    const tool = dataTools.find(item => item.action === action);
    if (!tool) fail('지원하지 않는 외부 요청입니다.', 'UNKNOWN_ACTION');
    validate(tool.inputSchema, payload);
    return ['automation.reviews.create','automation.reviews.update','automation.runs.start','automation.runs.cancel'].includes(action) ? exclusive(() => perform(action, payload)) : perform(action, payload);
  }
  return { handle };
}
module.exports = { createAutomationApi, dataTools, validate, schema, ID, string };
