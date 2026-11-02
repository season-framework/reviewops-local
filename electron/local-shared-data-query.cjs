'use strict';
const { querySharedData } = require('./shared-data-query.cjs');

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function fail(code) {
  throw Object.assign(new Error(code === 'ACCESS_DENIED' ?
    'A current owned local window is required.' : 'Shared data is unavailable.'), { code });
}
function currentProjectIds(snapshot) {
  const descriptor = snapshot && Object.getOwnPropertyDescriptor(snapshot, 'projects');
  const projects = descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value;
  if (!Array.isArray(projects) || projects.length > 100000) fail('INVALID_SNAPSHOT');
  const seen = new Set();
  return projects.map(project => {
    const descriptor = project && typeof project === 'object' && Object.getOwnPropertyDescriptor(project, 'id');
    const id = descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value;
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) fail('INVALID_SNAPSHOT');
    seen.add(id);
    return id;
  });
}

// ownerProjectId comes only from the current main-process window record. The
// empty string denotes its unbound main window; missing never means unbound.
function queryLocalSharedData(snapshot, ownerProjectId, operation, payload) {
  if (typeof ownerProjectId !== 'string' || ownerProjectId !== '' && !ID.test(ownerProjectId)) fail('ACCESS_DENIED');
  const projectIds = ownerProjectId === '' ? currentProjectIds(snapshot) : [ownerProjectId];
  const callerContext = { projectGrants: projectIds.map(projectId => ({ projectId, read: true })) };
  return querySharedData(snapshot, callerContext, operation, payload);
}

module.exports = { queryLocalSharedData };
