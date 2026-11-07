'use strict';

const VIEWS = ['home', 'groups', 'group', 'project', 'ops', 'settings', 'accounts', 'hosts'];
const SECTIONS = ['', 'projects', 'services', 'review', 'dashboard', 'file', 'terminal', 'settings', 'conversation', 'goals', 'info', 'schedules', 'prompts'];
const INPUT_FIELDS = ['view', 'section', 'groupId', 'projectId', 'reviewId', 'documentId', 'goalId'];
const CONTEXT_FIELDS = [...INPUT_FIELDS, 'groupName', 'projectName', 'reviewTitle', 'documentName', 'datasetEpoch', 'projectBirth', 'reviewGeneration', 'windowId'];
function invalid() { throw Object.assign(new Error('작업할 화면과 대상을 다시 선택하십시오.'), {code: 'INVALID_OPS_CONTEXT'}); }
function validateManagementContext(value, input = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !(input ? INPUT_FIELDS : CONTEXT_FIELDS).includes(key))) invalid();
  for (const [key, item] of Object.entries(value)) {
    if (['projectBirth', 'reviewGeneration'].includes(key)) { if (!Number.isSafeInteger(item) || item < 1) invalid(); }
    else if (typeof item !== 'string' || item.includes('\0') || item.length > (['groupName', 'projectName', 'reviewTitle', 'documentName'].includes(key) ? 500 : 128)) invalid();
  }
  if (!VIEWS.includes(value.view) || !SECTIONS.includes(value.section || '')) invalid();
  return structuredClone(value);
}
module.exports = {validateManagementContext, VIEWS, SECTIONS};
