'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 8;
const STATUSES = ['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const CATEGORIES = ['bug', 'ux', 'feature', 'content', 'performance', 'accessibility', 'security', 'structure', 'design', 'data', 'message', 'typo', 'other'];
const CATEGORY_NAMES = require('./review-categories.json');
const BUILTIN_CATEGORIES = [...CATEGORY_NAMES.defaults, ...CATEGORY_NAMES.legacy];
const categoryNameKey = value => value.normalize('NFKC').toLowerCase();
const TABLES = ['groups', 'projects', 'services', 'project_services', 'reviews', 'agent_runs', 'activities', 'attachments', 'settings'];
const AGENT_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
const AGENT_FINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const AGENT_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const AGENT_METADATA = ['cancelRequested', 'terminationConfirmed', 'errorCode', 'trust', 'usage', 'outputTruncated', 'context', 'requestId', 'requestSignature', 'newConversation','retryOf','independentExecution','remoteExecution'];
const LOG_FIELDS = ['navigation_log','input_log','network_log','console_log','fingerprint_log'];
const SECRET_KEY = /^(password|passphrase|private[_-]?key|ssh[_-]?password|ssh[_-]?private[_-]?key|access[_-]?token|api[_-]?key|secret|credential)$/i;
const MAX_ITEMS = 100000;

function fail(message, code = 'INVALID_INPUT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function object(value, label = '입력값') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
  return value;
}
function text(value, label, max = 10000, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail(`${label}은 문자열로 입력해야 합니다.`);
  const result = value.trim();
  if (required && !result) fail(`${label}을 입력하십시오.`);
  if (result.length > max) fail(`${label}은 ${max}자까지 입력할 수 있습니다.`);
  if (result.includes('\0')) fail(`${label}에 사용할 수 없는 문자가 있습니다.`);
  return result;
}
function choice(value, choices, fallback, label) {
  const result = value === undefined ? fallback : value;
  if (!choices.includes(result)) fail(`${label} 값이 올바르지 않습니다.`);
  return result;
}
function reviewCategoryName(value) {
  const name = text(value, '분류 이름', 60, true).normalize('NFC');
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('분류 이름에 사용할 수 없는 문자가 있습니다.');
  return name.replace(/\s+/gu, ' ');
}
function reviewCategories(value) {
  if (!Array.isArray(value) || value.length > 100) fail('직접 추가한 분류는 100개까지 저장할 수 있습니다.');
  const ids = new Set(), names = new Set();
  return value.map(entry => {
    object(entry, '리뷰 분류');
    if (Object.keys(entry).some(key => !['id', 'name'].includes(key)) || typeof entry.id !== 'string' || !/^custom_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.id)) fail('저장된 분류 정보가 올바르지 않습니다.');
    const name = reviewCategoryName(entry.name), key = categoryNameKey(name);
    if (ids.has(entry.id) || names.has(key) || BUILTIN_CATEGORIES.some(([id, label]) => [id, label].some(value => categoryNameKey(value) === key))) fail('같은 이름의 분류가 이미 있습니다.');
    ids.add(entry.id); names.add(key);
    return {id: entry.id, name};
  });
}
function integer(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${label} 값이 올바르지 않습니다.`);
  return result;
}
function id(value, label = '항목') {
  const result = text(value, label, 128, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail(`${label} ID가 올바르지 않습니다.`);
  return result;
}
function noSecrets(value, depth = 0) {
  if (depth > 16) fail('설정이 너무 깊게 중첩되어 있습니다.');
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && entry !== '' && entry !== undefined && entry !== null && entry !== false) {
      fail('비밀번호와 개인 키 내용은 로컬 자료에 저장할 수 없습니다.');
    }
    noSecrets(entry, depth + 1);
  }
}
function safeFilename(value) {
  const name = text(value, '첨부 파일명', 255, true);
  if (name === '.' || name === '..' || name !== path.basename(name) || /[/\\]/.test(name)) fail('첨부 파일명이 올바르지 않습니다.');
  return name;
}
function absolutePath(value, label, required = false, paths = path) {
  const result = text(value, label, 4096, required);
  if (!result) return '';
  if (!paths.isAbsolute(result) || /[\r\n]/.test(result) || result.split(paths === path.posix ? '/' : /[/\\]/).includes('..')) fail(`${label}은 상위 폴더 이동이 없는 절대 경로로 입력하십시오.`);
  return paths.normalize(result);
}
function safeUrl(value, label) {
  const result = text(value, label, 8192);
  if (!result) return '';
  let url;
  try { url = new URL(result); } catch { fail(`${label}가 올바르지 않습니다.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label}는 로그인 정보가 없는 HTTP 또는 HTTPS 주소로 입력하십시오.`);
  return result;
}
function timestamp() { return new Date().toISOString(); }
function freshId() { return crypto.randomUUID(); }
function plain(row) {
  if (!row) return null;
  const result = {...row};
  if (typeof result.labels === 'string') result.labels = JSON.parse(result.labels);
  if (typeof result.agentModels === 'string') result.agentModels = JSON.parse(result.agentModels);
  if (typeof result.progressJson === 'string') {result.progress = JSON.parse(result.progressJson); delete result.progressJson;}
  if (typeof result.metadataJson === 'string') {Object.assign(result, JSON.parse(result.metadataJson)); delete result.metadataJson;}
  if (typeof result.evidenceJson === 'string') {result.evidence=JSON.parse(result.evidenceJson);delete result.evidenceJson;}
  return result;
}
function evidenceValue(value = {}) {
  object(value,'리뷰 자료');noSecrets(value);
  let serialized;
  try {serialized=JSON.stringify(value);} catch {fail('리뷰 자료 형식이 올바르지 않습니다.');}
  if(Buffer.byteLength(serialized)>2*1024*1024)fail('리뷰 로그는 2 MB까지 저장할 수 있습니다.');
  const result=JSON.parse(serialized);
  for(const field of LOG_FIELDS)if(result[field]!==undefined && !(Array.isArray(result[field]) || (field==='fingerprint_log' && result[field] && typeof result[field]==='object')))fail('리뷰 로그 형식이 올바르지 않습니다.');
  for(const field of LOG_FIELDS)if(Array.isArray(result[field])&&result[field].length>1000)fail('종류별 리뷰 로그는 1000개까지 저장할 수 있습니다.');
  if(result.log_captures!==undefined) {
    if(!Array.isArray(result.log_captures)||result.log_captures.length>100)fail('저장된 리뷰 로그는 100개까지 지원합니다.');
    for(const capture of result.log_captures) {
      object(capture,'리뷰 로그');
      if(capture.log_captures!==undefined)fail('리뷰 로그를 중첩할 수 없습니다.');
      evidenceValue(capture);
      if(capture.id!==undefined)id(capture.id,'리뷰 로그');
    }
  }
  return result;
}
function mergeEvidence(previous, incoming, label) {
  const next=evidenceValue(incoming),base=evidenceValue(previous || {});
  const supplied=next.log_captures || [];
  if(!supplied.length && (next.capturedAt || LOG_FIELDS.some(key=>next[key]!==undefined))) {
    const capturedAt=next.capturedAt || timestamp();
    supplied.push({...next,id:freshId(),label:label || '리뷰 로그',capturedAt,captured_at:capturedAt});
    delete supplied[0].log_captures;
  }
  const captures=new Map((base.log_captures || []).map(item=>[item.id,item]));
  for(const item of supplied) {
    const capturedAt=item.capturedAt || item.captured_at || timestamp();
    const capture={...item,id:item.id || freshId(),label:item.label || label || '리뷰 로그',capturedAt,captured_at:capturedAt};
    captures.set(capture.id,capture);
  }
  return evidenceValue({...base,...next,log_captures:[...captures.values()]});
}
function sqlRow(row) { const result={...row, ...(Array.isArray(row.labels) ? {labels:JSON.stringify(row.labels)} : {}), ...(Array.isArray(row.agentModels) ? {agentModels:JSON.stringify(row.agentModels)} : {})};if(result.evidence!==undefined){result.evidenceJson=JSON.stringify(result.evidence);delete result.evidence;}return result; }
function agentModels(value = []) {
  if (!Array.isArray(value) || value.length > 100) fail('모델은 100개까지 등록할 수 있습니다.');
  const seen = new Set();
  return value.map(row => {
    object(row, '모델');
    const modelId = text(row.id, '모델 ID', 256, true);
    if (/\s/.test(modelId)) fail('모델 ID에 공백을 사용할 수 없습니다.');
    if (seen.has(modelId)) fail('같은 모델 ID를 두 번 등록할 수 없습니다.');
    seen.add(modelId);
    const levels = row.reasoning ?? [];
    if (!Array.isArray(levels) || levels.length > AGENT_EFFORTS.length - 1) fail('모델의 추론 수준 목록이 올바르지 않습니다.');
    const reasoning = [...new Set(levels.map(level => choice(level, AGENT_EFFORTS.slice(1), '', '모델의 추론 수준')))];
    const defaultReasoningEffort = choice(row.defaultReasoningEffort, ['', ...reasoning], '', '모델의 기본 추론 수준');
    return { id:modelId, label:text(row.label, '모델 표시 이름', 256) || modelId, reasoning, defaultReasoningEffort };
  });
}
function metadata(input, previous) {
  const labels = input.labels === undefined ? previous?.labels || [] : input.labels;
  if (!Array.isArray(labels) || labels.length > 30) fail('라벨은 30개까지 등록할 수 있습니다.');
  return { memo:text(input.memo ?? previous?.memo, '기록용 메모', 50000),
    labels:[...new Set(labels.map(item => text(item, '라벨', 80, true)))],
    operationalStatus:choice(input.operationalStatus, ['active','archived','disabled'], previous?.operationalStatus || 'active', '운영 상태') };
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('백업 파일의 날짜가 올바르지 않습니다.');
  return value;
}
function dataRow(input, previous, fields) {
  return { id: previous?.id || freshId(), ...fields, createdAt: previous?.createdAt || timestamp(), updatedAt: timestamp() };
}
function byteText(value, label, limit, strict = false) {
  const result = text(value, label, Math.max(limit, typeof value === 'string' ? value.length : 0));
  const buffer = Buffer.from(result);
  if (buffer.length <= limit) return result;
  if (strict) fail(`${label}의 크기가 너무 큽니다.`);
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}
function agentProgress(value, strict = false) {
  if (value === undefined || value === null || value === '') return '[]';
  let rows = value;
  if (typeof rows === 'string') {
    if (Buffer.byteLength(rows) > 1024 * 1024) fail('에이전트 진행 기록의 크기가 너무 큽니다.');
    try {rows = JSON.parse(rows);} catch {fail('에이전트 진행 기록 형식이 올바르지 않습니다.');}
  }
  if (!Array.isArray(rows)) fail('에이전트 진행 기록은 목록으로 저장해야 합니다.');
  if (strict && rows.length > 200) fail('에이전트 진행 기록은 200개까지 저장할 수 있습니다.');
  rows = rows.slice(-200); noSecrets(rows);
  let serialized;
  try {serialized = JSON.stringify(rows);} catch {fail('에이전트 진행 기록 형식이 올바르지 않습니다.');}
  while (Buffer.byteLength(serialized) > 1024 * 1024) {
    if (strict) fail('에이전트 진행 기록의 크기가 너무 큽니다.');
    rows.shift(); serialized = JSON.stringify(rows);
  }
  return serialized;
}
function agentMetadata(input, previous) {
  const immutable=new Set(['context','requestId','requestSignature','newConversation','retryOf','independentExecution']);
  const value = Object.fromEntries(AGENT_METADATA.filter(key => (input[key] ?? previous?.[key]) !== undefined).map(key => [key,immutable.has(key)&&previous?.[key]!==undefined?previous[key]:input[key] ?? previous?.[key]]));
  for (const key of ['cancelRequested','terminationConfirmed','outputTruncated','newConversation','independentExecution']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('에이전트 실행 정보가 올바르지 않습니다.');
  if(value.requestId!==undefined)value.requestId=id(value.requestId,'요청');
  if(value.retryOf!==undefined)value.retryOf=id(value.retryOf,'원본 요청');
  if(value.requestSignature!==undefined && !/^[a-f0-9]{64}$/.test(value.requestSignature))fail('에이전트 요청 정보가 올바르지 않습니다.');
  if(value.remoteExecution!==undefined) {
    const remote=object(value.remoteExecution,'SSH 에이전트 실행 정보');
    if(remote.version!==1||typeof remote.ready!=='boolean'||['stdoutOffset','stderrOffset'].some(key=>!Number.isSafeInteger(remote[key])||remote[key]<0)||Object.keys(remote).some(key=>!['version','ready','stdoutOffset','stderrOffset'].includes(key)))fail('SSH 에이전트 실행 정보가 올바르지 않습니다.');
    value.remoteExecution={version:1,ready:remote.ready,stdoutOffset:remote.stdoutOffset,stderrOffset:remote.stderrOffset};
  }
  if(value.context!==undefined) {
    object(value.context,'에이전트 첨부 자료');
    const context=value.context;
    if(context.initialRequest!==undefined&&typeof context.initialRequest!=='boolean')fail('에이전트 실행 정보가 올바르지 않습니다.');
    if(typeof context.instruction!=='boolean'||typeof context.instructionMarkdown!=='string'||context.instructionMarkdown.length>200000)fail('에이전트 작업 지시서 형식이 올바르지 않습니다.');
    for(const key of ['attachmentIds','logIds'])if(!Array.isArray(context[key])||context[key].length>100||context[key].some(item=>typeof item!=='string'||item.length>128))fail('에이전트 첨부 자료 목록이 올바르지 않습니다.');
    for(const key of ['attachments','logs'])if(!Array.isArray(context[key])||context[key].length>100||context[key].some(item=>!item||typeof item!=='object'||Array.isArray(item)))fail('에이전트 첨부 자료 형식이 올바르지 않습니다.');
    if(context.screenshotId!==null&&typeof context.screenshotId!=='string')fail('에이전트 스크린샷 선택이 올바르지 않습니다.');
    if(context.screenshot!==null)object(context.screenshot,'에이전트 스크린샷');
  }
  if (value.errorCode !== undefined) value.errorCode = text(value.errorCode,'에이전트 오류 코드',128);
  if (value.trust !== undefined) {
    object(value.trust);
    const {host,port,fingerprint} = value.trust;
    value.trust = {host:text(host,'SSH 호스트',255),port:integer(port,22,1,65535,'SSH 포트'),fingerprint:text(fingerprint,'SSH 호스트 키',120)};
  }
  if (value.usage !== undefined) object(value.usage);
  noSecrets(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(JSON.stringify({...value,context:undefined})) > 32000 || Buffer.byteLength(serialized)>3*1024*1024) fail('에이전트 실행 정보의 크기가 너무 큽니다.');
  return serialized;
}

class LocalStore {
  constructor(options = {}) {
    if (typeof options === 'string') options = { dbPath: options };
    object(options);
    this.dbPath = options.dbPath;
    if (typeof this.dbPath !== 'string' || !this.dbPath) fail('데이터베이스 경로가 필요합니다.');
    if (this.dbPath !== ':memory:') {
      this.dbPath = path.resolve(this.dbPath);
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.closed = false;
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      this.migrate();
      if (this.dbPath !== ':memory:') fs.chmodSync(this.dbPath, 0o600);
    } catch (error) {
      this.db.close(); this.closed = true; throw error;
    }
  }

  migrate() {
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (current > SCHEMA_VERSION) fail('새 버전에서 저장한 자료입니다. 앱을 업데이트하십시오.', 'NEWER_DATABASE');
    if (current === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE groups (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE services (
          id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('ssh','local')),
          host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535), username TEXT NOT NULL DEFAULT '',
          authType TEXT NOT NULL DEFAULT 'agent' CHECK(authType IN ('agent','key','password')),
          privateKeyPath TEXT NOT NULL DEFAULT '', rootPath TEXT NOT NULL, viewerUrl TEXT NOT NULL DEFAULT '',
          hostFingerprint TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE project_services (
          projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, PRIMARY KEY(projectId, serviceId)
        );
        CREATE TABLE reviews (
          id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          serviceId TEXT REFERENCES services(id) ON DELETE RESTRICT,
          number INTEGER NOT NULL CHECK(number > 0), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('open','in_progress','in_review','resolved','recheck','closed')),
          priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','critical')),
          category TEXT NOT NULL CHECK(category IN ('bug','ux','feature','content','other')),
          targetPath TEXT NOT NULL DEFAULT '', targetUrl TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId, number)
        );
        CREATE TABLE activities (
          id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('comment','created','updated','status')), body TEXT NOT NULL DEFAULT '',
          fromStatus TEXT NOT NULL DEFAULT '', toStatus TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          activityId TEXT REFERENCES activities(id) ON DELETE CASCADE,
          name TEXT NOT NULL, mimeType TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0 CHECK(size >= 0),
          storageName TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, valueJson TEXT NOT NULL);
        CREATE INDEX projects_group ON projects(groupId);
        CREATE INDEX services_group ON services(groupId);
        CREATE INDEX reviews_project ON reviews(projectId, updatedAt);
        CREATE INDEX reviews_service ON reviews(serviceId);
        CREATE INDEX activities_review ON activities(reviewId, createdAt);
        CREATE INDEX attachments_review ON attachments(reviewId);
        CREATE TRIGGER project_service_group_insert BEFORE INSERT ON project_services
        WHEN (SELECT groupId FROM projects WHERE id=NEW.projectId) != (SELECT groupId FROM services WHERE id=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '서비스와 프로젝트는 같은 그룹에 있어야 합니다.'); END;
        CREATE TRIGGER project_service_group_update BEFORE UPDATE ON project_services
        WHEN (SELECT groupId FROM projects WHERE id=NEW.projectId) != (SELECT groupId FROM services WHERE id=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '서비스와 프로젝트는 같은 그룹에 있어야 합니다.'); END;
        CREATE TRIGGER project_service_delete BEFORE DELETE ON project_services
        WHEN EXISTS(SELECT 1 FROM reviews WHERE projectId=OLD.projectId AND serviceId=OLD.serviceId)
        BEGIN SELECT RAISE(ABORT, '리뷰에서 사용하는 서비스 연결은 해제할 수 없습니다.'); END;
        CREATE TRIGGER project_group_update BEFORE UPDATE OF groupId ON projects
        WHEN EXISTS(SELECT 1 FROM project_services ps JOIN services s ON s.id=ps.serviceId WHERE ps.projectId=NEW.id AND s.groupId != NEW.groupId)
        BEGIN SELECT RAISE(ABORT, '연결된 서비스가 있는 프로젝트의 그룹을 바꿀 수 없습니다.'); END;
        CREATE TRIGGER service_group_update BEFORE UPDATE OF groupId ON services
        WHEN EXISTS(SELECT 1 FROM project_services ps JOIN projects p ON p.id=ps.projectId WHERE ps.serviceId=NEW.id AND p.groupId != NEW.groupId)
        BEGIN SELECT RAISE(ABORT, '연결된 프로젝트가 있는 서비스의 그룹을 바꿀 수 없습니다.'); END;
        CREATE TRIGGER review_service_insert BEFORE INSERT ON reviews
        WHEN NEW.serviceId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_services WHERE projectId=NEW.projectId AND serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스만 리뷰에 지정할 수 있습니다.'); END;
        CREATE TRIGGER review_service_update BEFORE UPDATE OF projectId,serviceId ON reviews
        WHEN NEW.serviceId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_services WHERE projectId=NEW.projectId AND serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스만 리뷰에 지정할 수 있습니다.'); END;
        CREATE TRIGGER activity_attachment_insert BEFORE INSERT ON attachments
        WHEN NEW.activityId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activityId AND reviewId=NEW.reviewId)
        BEGIN SELECT RAISE(ABORT, '같은 리뷰의 댓글에만 첨부할 수 있습니다.'); END;
        CREATE TRIGGER activity_attachment_update BEFORE UPDATE OF reviewId,activityId ON attachments
        WHEN NEW.activityId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activityId AND reviewId=NEW.reviewId)
        BEGIN SELECT RAISE(ABORT, '같은 리뷰의 댓글에만 첨부할 수 있습니다.'); END;
        PRAGMA user_version=1;
      `);
    });
    if (current < 2) {
      // Rebuild only the review table to extend the original category choices.
      this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      try { this.transaction(() => {
        for (const table of ['groups','projects','services']) this.db.exec(`ALTER TABLE ${table} ADD COLUMN memo TEXT NOT NULL DEFAULT ''; ALTER TABLE ${table} ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'; ALTER TABLE ${table} ADD COLUMN operationalStatus TEXT NOT NULL DEFAULT 'active' CHECK(operationalStatus IN ('active','archived','disabled'));`);
        this.db.exec("ALTER TABLE projects ADD COLUMN intro TEXT NOT NULL DEFAULT '';");
        this.db.exec(`ALTER TABLE services ADD COLUMN viewerWidth INTEGER NOT NULL DEFAULT 1440; ALTER TABLE services ADD COLUMN viewerHeight INTEGER NOT NULL DEFAULT 900; ALTER TABLE services ADD COLUMN viewerScale TEXT NOT NULL DEFAULT 'fit';`);
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'").get().sql;
        const dependent = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='reviews' AND type IN ('trigger','index') AND sql IS NOT NULL").all();
        this.db.exec(schema.replace('CREATE TABLE reviews', 'CREATE TABLE reviews_v2').replace("'bug','ux','feature','content','other'", CATEGORIES.map(value => `'${value}'`).join(',')));
        this.db.exec('INSERT INTO reviews_v2 SELECT * FROM reviews; DROP TABLE reviews; ALTER TABLE reviews_v2 RENAME TO reviews;');
        for (const item of dependent) this.db.exec(item.sql);
        if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('자료 연결을 갱신하지 못했습니다.');
        this.db.exec('PRAGMA user_version=2;');
      }); } finally { this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;'); }
    }
    if (current < 3) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE services ADD COLUMN agentEnabled INTEGER NOT NULL DEFAULT 0 CHECK(agentEnabled IN (0,1));
        ALTER TABLE services ADD COLUMN agentBinary TEXT NOT NULL DEFAULT 'codex';
        ALTER TABLE services ADD COLUMN agentWorkPath TEXT NOT NULL DEFAULT '';
        ALTER TABLE services ADD COLUMN agentModel TEXT NOT NULL DEFAULT '';
        ALTER TABLE services ADD COLUMN agentReasoningEffort TEXT NOT NULL DEFAULT '';
        ALTER TABLE services ADD COLUMN agentInstructions TEXT NOT NULL DEFAULT '';
        ALTER TABLE activities ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','agent','system'));
        ALTER TABLE activities ADD COLUMN agentRunId TEXT NOT NULL DEFAULT '';
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind='agent'), prompt TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '', reasoningEffort TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
          sessionId TEXT NOT NULL DEFAULT '', sessionScope TEXT NOT NULL DEFAULT '', workPath TEXT NOT NULL DEFAULT '',
          response TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
          progressJson TEXT NOT NULL DEFAULT '[]', metadataJson TEXT NOT NULL DEFAULT '{}',
          startedAt TEXT NOT NULL, finishedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE INDEX agent_runs_review ON agent_runs(reviewId,createdAt);
        CREATE INDEX agent_runs_service ON agent_runs(serviceId,status);
        CREATE UNIQUE INDEX agent_response_run ON activities(agentRunId) WHERE role='agent' AND agentRunId!='';
        CREATE TRIGGER agent_run_service_insert BEFORE INSERT ON agent_runs
        WHEN NOT EXISTS(SELECT 1 FROM reviews r JOIN project_services ps ON ps.projectId=r.projectId WHERE r.id=NEW.reviewId AND ps.serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스의 실행 기록만 저장할 수 있습니다.'); END;
        CREATE TRIGGER agent_run_service_update BEFORE UPDATE OF reviewId,serviceId ON agent_runs
        WHEN NOT EXISTS(SELECT 1 FROM reviews r JOIN project_services ps ON ps.projectId=r.projectId WHERE r.id=NEW.reviewId AND ps.serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스의 실행 기록만 저장할 수 있습니다.'); END;
        CREATE TRIGGER agent_run_project_service_delete BEFORE DELETE ON project_services
        WHEN EXISTS(SELECT 1 FROM agent_runs a JOIN reviews r ON r.id=a.reviewId WHERE r.projectId=OLD.projectId AND a.serviceId=OLD.serviceId)
        BEGIN SELECT RAISE(ABORT, '에이전트 실행 기록에서 사용하는 서비스 연결은 해제할 수 없습니다.'); END;
        PRAGMA user_version=3;
      `);
    });
    if (current < 4) this.transaction(()=>this.db.exec("ALTER TABLE reviews ADD COLUMN evidenceJson TEXT NOT NULL DEFAULT '{}'; ALTER TABLE activities ADD COLUMN evidenceJson TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=4;"));
    if (current < 5) this.transaction(() => {
      // A project may detach a service without discarding past work. Agent history
      // keeps its service reference until that service is deleted, then retains a
      // null reference. Fresh executions still require a linked service in the API.
      const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get().sql;
      const indexes = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agent_runs' AND type='index' AND sql IS NOT NULL").all();
      this.db.exec(`
        DROP TRIGGER project_service_delete;
        DROP TRIGGER agent_run_project_service_delete;
        DROP TRIGGER agent_run_service_insert;
        DROP TRIGGER agent_run_service_update;
      `);
      this.db.exec(schema.replace(/^CREATE TABLE\s+(?:"agent_runs"|agent_runs)\s*\(/i, 'CREATE TABLE agent_runs_v5 (').replace('serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT', 'serviceId TEXT REFERENCES services(id) ON DELETE SET NULL'));
      this.db.exec('INSERT INTO agent_runs_v5 SELECT * FROM agent_runs ORDER BY rowid; DROP TABLE agent_runs; ALTER TABLE agent_runs_v5 RENAME TO agent_runs;');
      for (const item of indexes) this.db.exec(item.sql);
      this.db.exec(`
        CREATE TRIGGER project_service_delete BEFORE DELETE ON project_services
        BEGIN UPDATE reviews SET serviceId=NULL WHERE projectId=OLD.projectId AND serviceId=OLD.serviceId; END;
        CREATE TRIGGER service_delete_linked BEFORE DELETE ON services
        WHEN EXISTS(SELECT 1 FROM project_services WHERE serviceId=OLD.id)
        BEGIN SELECT RAISE(ABORT, '모든 프로젝트에서 서비스 연결을 해제한 뒤 삭제하십시오.'); END;
        PRAGMA user_version=5;
      `);
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('자료 연결을 갱신하지 못했습니다.');
    });
    if (current < 6) this.transaction(() => this.db.exec(`
      ALTER TABLE services ADD COLUMN managedProjectId TEXT NOT NULL DEFAULT '';
      ALTER TABLE services ADD COLUMN hostAlias TEXT NOT NULL DEFAULT '';
      ALTER TABLE services ADD COLUMN sshConfigPath TEXT NOT NULL DEFAULT '';
      PRAGMA user_version=6;
    `));
    if (current < 7) this.transaction(() => this.db.exec(`
      ALTER TABLE services ADD COLUMN agentModels TEXT NOT NULL DEFAULT '[]';
      PRAGMA user_version=7;
    `));
    if (current < 8) {
      // Keep every review column, dependent index and trigger while allowing
      // category IDs registered in settings alongside the original built-ins.
      this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      try { this.transaction(() => {
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'").get().sql;
        const updated = schema.replace(/category TEXT NOT NULL CHECK\(category IN \([^)]*\)\)/, 'category TEXT NOT NULL');
        if (updated !== schema) {
          const dependent = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='reviews' AND type IN ('trigger','index') AND sql IS NOT NULL").all();
          this.db.exec(updated.replace(/^CREATE TABLE\s+(?:"reviews"|reviews)\s*\(/i, 'CREATE TABLE reviews_v8 ('));
          this.db.exec('INSERT INTO reviews_v8 SELECT * FROM reviews ORDER BY rowid; DROP TABLE reviews; ALTER TABLE reviews_v8 RENAME TO reviews;');
          for (const item of dependent) this.db.exec(item.sql);
        }
        if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('자료 연결을 갱신하지 못했습니다.');
        this.db.exec('PRAGMA user_version=8;');
      }); } finally { this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;'); }
    }
  }

  transaction(fn) {
    if (this.closed) fail('데이터베이스가 닫혀 있습니다.', 'STORE_CLOSED');
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }

  get(table, itemId) {
    if (!TABLES.includes(table) || ['project_services', 'settings'].includes(table)) fail('항목 종류가 올바르지 않습니다.');
    const row = plain(this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id(itemId)));
    if (!row) fail('항목을 찾을 수 없습니다.', 'NOT_FOUND');
    return row;
  }
  upsert(table, row) {
    const values=sqlRow(row),columns = Object.keys(values);
    const insert = columns.map(key => `:${key}`).join(',');
    const update = columns.filter(key => key !== 'id' && key !== 'createdAt').map(key => `${key}=excluded.${key}`).join(',');
    this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${insert}) ON CONFLICT(id) DO UPDATE SET ${update}`).run(values);
    return row;
  }
  project(projectId) {
    const serviceIds = this.db.prepare('SELECT serviceId FROM project_services WHERE projectId=? ORDER BY serviceId').all(projectId).map(row => row.serviceId);
    return { ...this.get('projects', projectId), serviceIds, connection: serviceIds.length ? this.get('services', serviceIds[0]) : null };
  }
  saveGroup(input) {
    object(input);
    return this.transaction(() => {
      const previous = input.id ? this.get('groups', input.id) : null;
      const row = dataRow(input, previous, {
        name: text(input.name ?? previous?.name, '그룹명', 120, true),
        description: text(input.description ?? previous?.description, '그룹 설명', 10000), ...metadata(input, previous)
      });
      return this.upsert('groups', row);
    });
  }
  saveProject(input) {
    object(input);
    return this.transaction(() => {
      const previous = input.id ? this.get('projects', input.id) : null;
      const groupId = id(input.groupId ?? previous?.groupId, '그룹'); this.get('groups', groupId);
      const row = dataRow(input, previous, {
        groupId, name: text(input.name ?? previous?.name, '프로젝트명', 120, true),
        description: text(input.description ?? previous?.description, '프로젝트 설명', 10000), intro:text(input.intro ?? previous?.intro,'프로젝트 소개',100000), ...metadata(input, previous)
      });
      this.upsert('projects', row);
      if (input.serviceIds !== undefined) this.setProjectServices(row.id, input.serviceIds);
      if (input.connection !== undefined) return this.saveProjectConnection(row.id, input.connection);
      return this.project(row.id);
    });
  }
  saveProjectConnection(projectId, input) {
    return this.transaction(() => {
      const project = this.project(projectId);
      if (input === null) {
        this.setProjectServices(project.id, []);
        return { ...this.project(project.id), connectionClonedFrom: '' };
      }
      object(input, '프로젝트 연결 설정');
      const sourceId = input.id ? id(input.id, '프로젝트 연결 설정') : project.connection?.id;
      if (sourceId && !project.serviceIds.includes(sourceId)) fail('이 프로젝트의 연결 설정만 변경할 수 있습니다.');
      const source = sourceId ? this.get('services', sourceId) : null;
      const values = this.normalizeService({ ...input, groupId: project.groupId, name: project.name, managedProjectId: project.id }, source);
      const unchanged = source && source.managedProjectId === project.id && Object.entries(values).every(([key, value]) => JSON.stringify(source[key]) === JSON.stringify(value));
      const hasHistory = source && this.db.prepare('SELECT 1 FROM agent_runs WHERE serviceId=? LIMIT 1').get(source.id);
      const shared = source && this.db.prepare('SELECT 1 FROM project_services WHERE serviceId=? AND projectId!=? LIMIT 1').get(source.id, project.id);
      const reuse = source && source.managedProjectId === project.id && !shared && (!hasHistory || unchanged);
      const connection = reuse && unchanged ? source : this.upsert('services', dataRow(input, reuse ? source : null, values));
      // Link the new configuration before updating reviews so their ownership
      // triggers remain active. Historical executions retain the old reference.
      if (!project.serviceIds.includes(connection.id)) this.db.prepare('INSERT INTO project_services(projectId,serviceId) VALUES(?,?)').run(project.id, connection.id);
      this.db.prepare('UPDATE reviews SET serviceId=? WHERE projectId=?').run(connection.id, project.id);
      for (const serviceId of project.serviceIds.filter(value => value !== connection.id)) this.db.prepare('DELETE FROM project_services WHERE projectId=? AND serviceId=?').run(project.id, serviceId);
      return { ...this.project(project.id), connectionClonedFrom: source && !reuse ? source.id : '' };
    });
  }
  setProjectServices(projectId, serviceIds) {
    if (!Array.isArray(serviceIds) || serviceIds.length > 1000) fail('서비스 목록이 올바르지 않습니다.');
    return this.transaction(() => {
      const project = this.get('projects', projectId);
      const uniqueIds = [...new Set(serviceIds.map(value => id(value, '서비스')))];
      for (const serviceId of uniqueIds) {
        if (this.get('services', serviceId).groupId !== project.groupId) fail('서비스와 프로젝트는 같은 그룹에 있어야 합니다.');
      }
      const oldIds = this.project(projectId).serviceIds;
      const removed = oldIds.filter(serviceId => !uniqueIds.includes(serviceId));
      for (const serviceId of removed) {
        this.db.prepare('DELETE FROM project_services WHERE projectId=? AND serviceId=?').run(projectId, serviceId);
      }
      const insert = this.db.prepare('INSERT INTO project_services(projectId,serviceId) VALUES(?,?)');
      for (const serviceId of uniqueIds.filter(value => !oldIds.includes(value))) insert.run(projectId, serviceId);
      return this.project(projectId);
    });
  }

  normalizeService(input, previous) {
    noSecrets(input);
    const kind = choice(input.kind, ['ssh', 'local'], previous?.kind || 'ssh', '서비스 종류');
    const host = text(input.host ?? previous?.host, 'SSH 호스트', 255);
    if (host && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host)) fail('SSH 호스트가 올바르지 않습니다.');
    const port = integer(input.port, previous?.port || 22, 1, 65535, 'SSH 포트');
    const username = text(input.username ?? previous?.username, 'SSH 사용자', 120);
    if (username && /[\r\n\s\0]/.test(username)) fail('SSH 사용자명에 공백을 사용할 수 없습니다.');
    const authType = choice(input.authType, ['agent', 'key', 'password'], previous?.authType || 'agent', 'SSH 인증 방법');
    const privateKeyPath = absolutePath(input.privateKeyPath ?? previous?.privateKeyPath, '키 파일 경로');
    const managedProjectId = input.managedProjectId === undefined ? previous?.managedProjectId || '' : input.managedProjectId ? id(input.managedProjectId, '프로젝트') : '';
    const hostAlias = text(input.hostAlias ?? previous?.hostAlias, 'SSH Host', 255);
    if (hostAlias && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostAlias)) fail('SSH Host 이름이 올바르지 않습니다.');
    const sshConfigPath = absolutePath(input.sshConfigPath ?? previous?.sshConfigPath, 'SSH 설정 파일 경로');
    const workPaths = kind === 'ssh' ? path.posix : path;
    const rootPath = absolutePath(input.rootPath ?? previous?.rootPath ?? (kind === 'ssh' ? '/' : ''), '작업 경로', true, workPaths);
    if (kind === 'ssh' && (!host || !username)) fail('SSH 호스트와 사용자명을 입력하십시오.');
    if (kind === 'ssh' && authType === 'key' && !privateKeyPath) fail('SSH 키 파일을 선택하십시오.');
    let hostFingerprint = text(input.hostFingerprint ?? previous?.hostFingerprint, 'SSH 호스트 키', 120);
    if (hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(hostFingerprint)) fail('SSH 호스트 키 형식이 올바르지 않습니다.');
    if (previous && (previous.host !== host || previous.port !== port || previous.kind !== kind)) hostFingerprint = '';
    if (kind === 'local') hostFingerprint = '';
    const agentBinary = text(input.agentBinary ?? previous?.agentBinary ?? 'codex', '에이전트 실행 파일', 4096, true);
    if (workPaths.isAbsolute(agentBinary)) absolutePath(agentBinary, '에이전트 실행 파일', true, workPaths);
    else if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(agentBinary)) fail('에이전트 실행 파일 이름 또는 전체 경로를 입력하십시오.');
    const agentModel = text(input.agentModel ?? previous?.agentModel, '에이전트 모델', 256);
    if (/\s/.test(agentModel)) fail('에이전트 모델 이름에 공백을 사용할 수 없습니다.');
    return { groupId: id(input.groupId ?? previous?.groupId, '그룹'), name: text(input.name ?? previous?.name, '서비스명', 120, true),
      description: text(input.description ?? previous?.description, '서비스 설명', 10000), ...metadata(input, previous), viewerWidth:integer(input.viewerWidth,previous?.viewerWidth||1440,240,7680,'화면 너비'), viewerHeight:integer(input.viewerHeight,previous?.viewerHeight||900,240,7680,'화면 높이'), viewerScale:choice(input.viewerScale,['fit','50','75','100','125','150','200'],previous?.viewerScale||'fit','화면 배율'), kind, host, port, username, authType,
      privateKeyPath, rootPath, viewerUrl: safeUrl(input.viewerUrl ?? previous?.viewerUrl, '미리보기 주소'), hostFingerprint, managedProjectId, hostAlias, sshConfigPath,
      agentEnabled:integer(input.agentEnabled,previous?.agentEnabled || 0,0,1,'에이전트 사용'),agentBinary,
      agentWorkPath:absolutePath(input.agentWorkPath ?? previous?.agentWorkPath,'에이전트 작업 폴더',false,workPaths),agentModel,
      agentReasoningEffort:choice(input.agentReasoningEffort,AGENT_EFFORTS,previous?.agentReasoningEffort || '','에이전트 추론 수준'),
      agentModels:agentModels(input.agentModels === undefined ? previous?.agentModels : input.agentModels),
      agentInstructions:text(input.agentInstructions ?? previous?.agentInstructions,'에이전트 지침',50000) };
  }
  saveService(input) {
    object(input);
    return this.transaction(() => {
      const previous = input.id ? this.get('services', input.id) : null;
      const values = this.normalizeService(input, previous); this.get('groups', values.groupId);
      if (values.managedProjectId && this.get('projects', values.managedProjectId).groupId !== values.groupId) fail('프로젝트 연결 설정은 같은 그룹에 있어야 합니다.');
      return this.upsert('services', dataRow(input, previous, values));
    });
  }

  normalizeReview(input, previous) {
    return {
      projectId: id(input.projectId ?? previous?.projectId, '프로젝트'),
      serviceId: input.serviceId === undefined ? previous?.serviceId || null : input.serviceId ? id(input.serviceId, '서비스') : null,
      title: text(input.title ?? previous?.title, '리뷰 제목', 300, true), body: text(input.body ?? previous?.body, '리뷰 내용', 100000),
      status: choice(input.status, STATUSES, previous?.status || 'open', '리뷰 상태'),
      priority: choice(input.priority, PRIORITIES, previous?.priority || 'normal', '우선순위'),
      category: choice(input.category, [...CATEGORIES, ...this.reviewCategories().map(item => item.id)], previous?.category || 'ux', '리뷰 분류'),
      targetPath: text(input.targetPath ?? previous?.targetPath, '리뷰 파일 경로', 4096),
      targetUrl: safeUrl(input.targetUrl ?? previous?.targetUrl, '리뷰 주소'),
      evidenceJson:JSON.stringify(input.evidence===undefined?evidenceValue(previous?.evidence || {}):mergeEvidence(previous?.evidence,input.evidence,previous?'리뷰 로그':'리뷰 등록 로그'))
    };
  }
  saveReview(input) {
    object(input);
    return this.transaction(() => {
      const previous = input.id ? this.get('reviews', input.id) : null;
      const values = this.normalizeReview(input, previous); this.get('projects', values.projectId);
      if (previous && previous.projectId !== values.projectId) fail('리뷰의 프로젝트를 바꿀 수 없습니다.');
      if (values.serviceId && !this.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(values.projectId, values.serviceId)) fail('프로젝트에 연결된 서비스만 리뷰에 지정할 수 있습니다.');
      const number = previous?.number || Number(this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM reviews WHERE projectId=?').get(values.projectId).number);
      const row = dataRow(input, previous, { ...values, number });
      this.upsert('reviews', row);
      if (!previous) this.insertActivity(row.id, '리뷰를 등록했습니다.', 'created');
      else {
        if (previous.status !== row.status) this.insertActivity(row.id, '', 'status', previous.status, row.status);
        if (['title', 'body', 'priority', 'category', 'targetPath', 'targetUrl', 'serviceId'].some(field => previous[field] !== row[field]) || JSON.stringify(previous.evidence)!==row.evidenceJson) this.insertActivity(row.id, '리뷰를 수정했습니다.', 'updated');
      }
      return plain(row);
    });
  }
  insertActivity(reviewId, body, type, fromStatus = '', toStatus = '', author = {}) {
    const role = choice(author.role,['user','agent','system'],'user','작성자 종류');
    const agentRunId = author.agentRunId ? id(author.agentRunId,'에이전트 실행') : '';
    if (agentRunId && this.get('agent_runs',agentRunId).reviewId !== reviewId) fail('같은 리뷰의 에이전트 실행 기록만 연결할 수 있습니다.');
    return plain(this.upsert('activities', dataRow({}, null, { reviewId, type, body, fromStatus, toStatus, role, agentRunId,evidenceJson:JSON.stringify(evidenceValue(author.evidence || {})) })));
  }
  addActivity(input) {
    object(input);
    return this.transaction(() => {
      const reviewId = id(input.reviewId, '리뷰');
      const review = this.get('reviews', reviewId);
      const body = text(input.body, '댓글', 100000);
      const status = choice(input.status, STATUSES, review.status, '리뷰 상태');
      const evidence=input.evidence===undefined?null:mergeEvidence({},input.evidence,'작업이력 로그');
      if (!body && status === review.status && !input.allowEmpty && !evidence) fail('작업 내용을 입력하거나 상태를 변경하십시오.');
      if(evidence)this.db.prepare('UPDATE reviews SET evidenceJson=? WHERE id=?').run(JSON.stringify(mergeEvidence(review.evidence,evidence)),reviewId);
      let row;
      if (status !== review.status) {
        row = this.insertActivity(reviewId, '', 'status', review.status, status);
        this.db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status, reviewId);
      }
      if (body || input.allowEmpty || evidence) row = this.insertActivity(reviewId, body, 'comment', '', '', {...input,...(evidence?{evidence}:{})});
      this.db.prepare('UPDATE reviews SET updatedAt=? WHERE id=?').run(row.createdAt, reviewId);
      return row;
    });
  }
  updateActivity(input) {
    object(input);
    return this.transaction(() => {
      const previous = this.get('activities', input.id);
      if (previous.type !== 'comment' || previous.role !== 'user') fail('사용자가 작성한 작업 내용만 편집할 수 있습니다.');
      const remove=input.removeAttachmentIds || [];
      if(!Array.isArray(remove)||remove.length>100||new Set(remove).size!==remove.length)fail('삭제할 첨부파일 목록이 올바르지 않습니다.');
      for(const fileId of remove){const file=this.get('attachments',fileId);if(file.activityId!==previous.id||file.reviewId!==previous.reviewId)fail('이 작업이력의 첨부파일만 삭제할 수 있습니다.');this.db.prepare('DELETE FROM attachments WHERE id=?').run(fileId);}
      const hasFiles = this.db.prepare('SELECT 1 FROM attachments WHERE activityId=? LIMIT 1').get(previous.id);
      const body = text(input.body, '작업 내용', 100000, !hasFiles && !input.allowEmpty && !Object.keys(previous.evidence || {}).length);
      const row = {...previous,body,updatedAt:timestamp()};
      this.upsert('activities',row);
      this.db.prepare('UPDATE reviews SET updatedAt=? WHERE id=?').run(row.updatedAt,row.reviewId);
      return row;
    });
  }

  normalizeAgentRun(input, previous, strict = false, allowDetached = false) {
    object(input);
    const reviewId = id(input.reviewId ?? previous?.reviewId,'리뷰');
    const serviceValue = input.serviceId === undefined ? previous?.serviceId : input.serviceId;
    const serviceId = serviceValue === null && (previous || allowDetached) ? null : id(serviceValue,'서비스');
    if (previous && (previous.reviewId !== reviewId || previous.serviceId !== serviceId)) fail('에이전트 실행의 리뷰와 서비스를 바꿀 수 없습니다.');
    const review = this.get('reviews',reviewId);
    const service = serviceId !== null ? this.get('services',serviceId) : null;
    if (!previous && !allowDetached && !this.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(review.projectId,serviceId)) fail('프로젝트에 연결된 서비스의 실행 기록만 저장할 수 있습니다.');
    const status = choice(input.status,AGENT_STATES,previous?.status || 'queued','에이전트 실행 상태');
    const sessionId = input.sessionId ?? previous?.sessionId ?? '';
    if (sessionId && !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) fail('에이전트 대화 정보가 올바르지 않습니다.');
    const model = text(input.model ?? previous?.model,'에이전트 모델',256);
    if (/\s/.test(model)) fail('에이전트 모델 이름에 공백을 사용할 수 없습니다.');
    const startedAt = date(input.startedAt ?? previous?.startedAt ?? input.createdAt ?? timestamp());
    const finishedAt = AGENT_FINAL.has(status) ? date(input.finishedAt || previous?.finishedAt || timestamp()) : null;
    const workPathValue = input.workPath ?? previous?.workPath;
    // A saved run belongs to its original host, even after a connection is
    // changed or deleted. Backups must preserve that path convention as well.
    const historicalPaths = typeof workPathValue === 'string' && (/^[A-Za-z]:[\\/]/.test(workPathValue) || workPathValue.startsWith('\\') || workPathValue.startsWith('//')) ? path.win32 : path.posix;
    const workPaths = previous || allowDetached ? historicalPaths : service?.kind === 'ssh' ? path.posix : path;
    return {
      reviewId,serviceId,kind:choice(input.kind,['agent'],'agent','에이전트 실행 종류'),
      prompt:byteText(input.prompt ?? previous?.prompt,'에이전트 요청',256 * 1024,strict),model,
      reasoningEffort:choice(input.reasoningEffort,AGENT_EFFORTS,previous?.reasoningEffort || '','에이전트 추론 수준'),status,
      sessionId:text(sessionId,'에이전트 대화',128),sessionScope:text(input.sessionScope ?? previous?.sessionScope,'에이전트 대화 구분',256),
      workPath:absolutePath(workPathValue,'에이전트 작업 폴더',false,workPaths),
      response:byteText(input.response ?? previous?.response,'에이전트 응답',256 * 1024,strict),
      output:byteText(input.output ?? previous?.output,'에이전트 출력',1024 * 1024,strict),error:text(input.error ?? previous?.error,'에이전트 오류',10000),
      progressJson:agentProgress(input.progress ?? input.progressJson ?? previous?.progress,strict),metadataJson:agentMetadata(input,previous),startedAt,finishedAt
    };
  }
  saveAgentRun(input) {
    object(input);
    return this.transaction(() => {
      const itemId = input.id ? id(input.id,'에이전트 실행') : freshId();
      const previous = plain(this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(itemId));
      // Late process callbacks must not revive a completed or cancelled execution.
      if (previous && AGENT_FINAL.has(previous.status) && input.status && previous.status !== input.status) return previous;
      const values = this.normalizeAgentRun(input,previous);
      const row = {id:itemId,...values,createdAt:previous?.createdAt || date(input.createdAt || input.startedAt || timestamp()),updatedAt:timestamp()};
      this.upsert('agent_runs',row);
      if (row.status === 'completed' && row.response && !this.db.prepare("SELECT 1 FROM activities WHERE agentRunId=? AND role='agent'").get(itemId)) {
        const notice = '\n\n전체 응답은 에이전트 탭에서 확인할 수 있습니다.';
        const body = row.response.length > 100000 ? row.response.slice(0,100000-notice.length).replace(/[\uD800-\uDBFF]$/,'') + notice : row.response;
        this.insertActivity(row.reviewId,body,'comment','','',{role:'agent',agentRunId:itemId});
        this.db.prepare('UPDATE reviews SET updatedAt=? WHERE id=?').run(row.updatedAt,row.reviewId);
      }
      return plain(row);
    });
  }
  listAgentRuns(reviewId) {
    if (reviewId === undefined) return this.db.prepare('SELECT * FROM agent_runs ORDER BY createdAt DESC,rowid DESC').all().map(plain);
    this.get('reviews',reviewId);
    return this.db.prepare('SELECT * FROM agent_runs WHERE reviewId=? ORDER BY createdAt DESC,rowid DESC').all(reviewId).map(plain);
  }
  transferAgentResponse(runId) {
    return this.transaction(()=>{
      const run=this.get('agent_runs',runId);
      if(run.status!=='completed'||!run.response)fail('완료된 에이전트 응답만 작업이력에 저장할 수 있습니다.');
      const existing=this.db.prepare("SELECT id FROM activities WHERE agentRunId=? AND role='agent' LIMIT 1").get(run.id);
      if(existing)return {activityId:existing.id,alreadySaved:true};
      const notice='\n\n전체 응답은 에이전트 탭에서 확인할 수 있습니다.';
      const body=run.response.length>100000?run.response.slice(0,100000-notice.length).replace(/[\uD800-\uDBFF]$/,'')+notice:run.response;
      const activity=this.insertActivity(run.reviewId,body,'comment','','',{role:'agent',agentRunId:run.id});
      this.db.prepare('UPDATE reviews SET updatedAt=? WHERE id=?').run(activity.createdAt,run.reviewId);
      return {activityId:activity.id,alreadySaved:false};
    });
  }
  interruptAgentRuns({preserveRemote=false}={}) {
    return this.transaction(() => {
      const pending = this.db.prepare("SELECT * FROM agent_runs WHERE status IN ('queued','running')").all().map(plain);
      const message = '앱이 다시 시작되어 실행 연결이 끊겼습니다. 작업 결과를 확인한 뒤 다시 실행하십시오.';
      return pending.filter(run=>!(preserveRemote&&run.status==='running'&&run.remoteExecution?.version===1&&run.remoteExecution.ready&&this.db.prepare('SELECT kind FROM services WHERE id=?').get(run.serviceId)?.kind==='ssh')).map(run => this.saveAgentRun({...run,status:'interrupted',error:message,finishedAt:timestamp(),progress:[...run.progress,{sequence:(run.progress.at(-1)?.sequence || 0)+1,state:'interrupted',message,step:'execution',createdAt:timestamp()}]}));
    });
  }
  addAttachment(input) {
    object(input);
    return this.transaction(() => {
      const reviewId = id(input.reviewId, '리뷰'); this.get('reviews', reviewId);
      const activityId = input.activityId ? id(input.activityId, '댓글') : null;
      if (activityId && this.get('activities', activityId).reviewId !== reviewId) fail('같은 리뷰의 댓글에만 첨부할 수 있습니다.');
      const row = dataRow(input, null, {
        reviewId, activityId, name: safeFilename(input.name), mimeType: text(input.mimeType || 'application/octet-stream', '파일 형식', 255, true),
        size: integer(input.size, 0, 0, 1024 * 1024 * 1024, '파일 크기'), storageName: safeFilename(input.storageName),
        sha256: text(input.sha256, '파일 해시', 64, true)
      });
      if (!/^[a-f0-9]{64}$/i.test(row.sha256)) fail('파일 해시가 올바르지 않습니다.');
      // Bytes are stored by the main process; it can supply the same generated UUID for their metadata.
      if (input.id) row.id = id(input.id, '첨부 파일');
      const columns = Object.keys(row);
      this.db.prepare(`INSERT INTO attachments(${columns.join(',')}) VALUES(${columns.map(key => `:${key}`).join(',')})`).run(row);
      this.db.prepare('UPDATE reviews SET updatedAt=? WHERE id=?').run(row.createdAt, reviewId);
      return row;
    });
  }

  deleteGroup(itemId) {
    return this.transaction(() => {
      this.get('groups', itemId);
      for (const project of this.db.prepare('SELECT id FROM projects WHERE groupId=?').all(itemId)) this.deleteProject(project.id);
      for (const service of this.db.prepare('SELECT id FROM services WHERE groupId=?').all(itemId)) this.deleteService(service.id);
      return this.remove('groups', itemId);
    });
  }
  deleteProject(itemId) {
    return this.transaction(() => {
      this.get('projects', itemId);
      this.db.prepare('DELETE FROM reviews WHERE projectId=?').run(itemId);
      const result = this.remove('projects', itemId);
      for (const connection of this.db.prepare('SELECT id FROM services WHERE managedProjectId=?').all(itemId)) {
        const linked = this.db.prepare('SELECT 1 FROM project_services WHERE serviceId=? LIMIT 1').get(connection.id);
        const history = this.db.prepare('SELECT 1 FROM agent_runs WHERE serviceId=? LIMIT 1').get(connection.id);
        if (linked || history) this.db.prepare("UPDATE services SET managedProjectId='' WHERE id=?").run(connection.id);
        else this.deleteService(connection.id);
      }
      return result;
    });
  }
  deleteService(itemId) {
    return this.transaction(() => {
      this.get('services', itemId);
      if (this.db.prepare('SELECT 1 FROM project_services WHERE serviceId=? LIMIT 1').get(itemId)) fail('모든 프로젝트에서 서비스 연결을 해제한 뒤 삭제하십시오.', 'IN_USE');
      this.db.prepare('UPDATE reviews SET serviceId=NULL WHERE serviceId=?').run(itemId);
      return this.remove('services', itemId);
    });
  }
  deleteReview(itemId) { return this.remove('reviews', itemId); }
  deleteAttachment(itemId) {
    return this.transaction(()=>{
      const file=this.get('attachments',itemId);
      const result=this.remove('attachments',itemId);
      if(file.activityId) {
        const activity=this.get('activities',file.activityId);
        if(activity.type==='comment'&&!activity.body&&!this.db.prepare('SELECT 1 FROM attachments WHERE activityId=? LIMIT 1').get(activity.id)) this.updateActivity({id:activity.id,body:'첨부 파일을 삭제했습니다.'});
      }
      return result;
    });
  }
  remove(table, itemId) {
    return this.transaction(() => {
      this.get(table, itemId); this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(itemId);
      return { deleted: true };
    });
  }

  saveSettings(input) {
    object(input); noSecrets(input);
    for (const key of Object.keys(input)) if (!['theme', 'reviewCategories'].includes(key)) fail('지원하지 않는 앱 설정입니다.');
    return this.transaction(() => {
      if (input.theme !== undefined) {
        const theme = choice(input.theme, ['light', 'dark'], 'light', '화면 모드');
        this.db.prepare('INSERT INTO settings(key,valueJson) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET valueJson=excluded.valueJson').run('theme', JSON.stringify(theme));
      }
      if (input.reviewCategories !== undefined) {
        const categories = reviewCategories(input.reviewCategories), allowed = new Set([...CATEGORIES, ...categories.map(item => item.id)]);
        if (this.db.prepare('SELECT DISTINCT category FROM reviews').all().some(row => !allowed.has(row.category))) fail('리뷰에서 사용하는 분류를 삭제할 수 없습니다.');
        this.db.prepare('INSERT INTO settings(key,valueJson) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET valueJson=excluded.valueJson').run('reviewCategories', JSON.stringify(categories));
      }
      return this.settings();
    });
  }
  reviewCategories() { return reviewCategories(this.settings().reviewCategories || []); }
  saveReviewCategory(input) {
    object(input); noSecrets(input);
    const name = reviewCategoryName(input.name), key = categoryNameKey(name);
    return this.transaction(() => {
      const builtin = BUILTIN_CATEGORIES.find(([id, label]) => [id, label].some(value => categoryNameKey(value) === key));
      if (builtin) return {id: builtin[0], name: builtin[1]};
      const categories = this.reviewCategories(), existing = categories.find(item => categoryNameKey(item.name) === key);
      if (existing) return existing;
      const category = {id: `custom_${crypto.randomUUID()}`, name};
      this.saveSettings({reviewCategories: [...categories, category]});
      return category;
    });
  }
  settings() {
    return { theme: 'light', ...Object.fromEntries(this.db.prepare('SELECT * FROM settings ORDER BY key').all().map(row => [row.key, JSON.parse(row.valueJson)])) };
  }
  snapshot() {
    return this.transaction(() => ({
      groups: this.db.prepare('SELECT * FROM groups ORDER BY createdAt,id').all().map(plain),
      projects: this.db.prepare('SELECT id FROM projects ORDER BY createdAt,id').all().map(row => this.project(row.id)),
      services: this.db.prepare('SELECT * FROM services ORDER BY createdAt,id').all().map(plain),
      reviews: this.db.prepare('SELECT * FROM reviews ORDER BY updatedAt DESC,id').all().map(plain),
      activities: this.db.prepare('SELECT * FROM activities ORDER BY createdAt,rowid').all().map(plain),
      attachments: this.db.prepare('SELECT * FROM attachments ORDER BY createdAt,id').all().map(plain),
      settings: this.settings()
    }));
  }
  exportData() { return this.transaction(() => ({ format: 'reviewops-local', version: SCHEMA_VERSION, ...this.snapshot(), agentRuns:this.listAgentRuns() })); }

  importData(payload) {
    object(payload, '백업 파일');
    if (payload.format !== 'reviewops-local' || ![1,2,3,4,5,6,7,SCHEMA_VERSION].includes(payload.version)) fail('지원하지 않는 백업 파일입니다.');
    for (const table of ['groups', 'projects', 'services', 'reviews', 'activities', 'attachments']) {
      if (!Array.isArray(payload[table]) || payload[table].length > MAX_ITEMS) fail('백업 자료의 항목 수가 올바르지 않습니다.');
    }
    if (payload.version >= 3 || payload.agentRuns !== undefined) {
      if (!Array.isArray(payload.agentRuns) || payload.agentRuns.length > MAX_ITEMS) fail('백업 파일의 에이전트 실행 기록 수가 올바르지 않습니다.');
    }
    object(payload.settings, '앱 설정');
    // Validate an independent copy before touching the live database. Import never copies SSH host trust.
    const validation = new LocalStore(':memory:');
    let clean;
    try { validation.insertImport(payload); clean = validation.exportData(); }
    finally { validation.close(); }
    return this.transaction(() => {
      for (const table of [...TABLES].reverse()) this.db.exec(`DELETE FROM ${table}`);
      this.insertImport(clean);
      return this.snapshot();
    });
  }

  insertImport(payload) {
    return this.transaction(() => {
      const normalizeRow = (row, values, allowed) => {
        object(row, '백업 항목');
        noSecrets(row);
        const common = ['id', 'createdAt', 'updatedAt'];
        if (Object.keys(row).some(key => ![...common, ...allowed].includes(key))) fail('백업 항목에 지원하지 않는 필드가 있습니다.');
        return { id: id(row.id), ...values, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt ?? row.createdAt) };
      };
      const insertRow = (table, row) => {
        const keys = Object.keys(row);
        this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(key => `:${key}`).join(',')})`).run(sqlRow(row));
      };
      this.saveSettings(payload.settings);
      for (const row of payload.groups) {
        object(row);
        insertRow('groups', normalizeRow(row, { name: text(row.name, '그룹명', 120, true), description: text(row.description, '그룹 설명', 10000), ...metadata(row,null) }, ['name', 'description', 'memo', 'labels', 'operationalStatus']));
      }
      for (const row of payload.projects) {
        object(row);
        if (!Array.isArray(row.serviceIds) || row.serviceIds.length > 1000 || new Set(row.serviceIds).size !== row.serviceIds.length) fail('백업 파일의 서비스 연결이 올바르지 않습니다.');
        insertRow('projects', normalizeRow(row, { groupId: id(row.groupId, '그룹'), name: text(row.name, '프로젝트명', 120, true), description: text(row.description, '프로젝트 설명', 10000), intro:text(row.intro,'프로젝트 소개',100000), ...metadata(row,null) }, ['groupId', 'name', 'description', 'serviceIds', 'connection', 'memo', 'labels', 'operationalStatus','intro']));
      }
      for (const row of payload.services) {
        object(row);
        const normalized = this.normalizeService({ ...row, hostFingerprint: '' }, null);
        if (normalized.managedProjectId && this.get('projects', normalized.managedProjectId).groupId !== normalized.groupId) fail('백업 파일의 프로젝트 연결 설정이 올바르지 않습니다.');
        insertRow('services', normalizeRow(row, normalized, [...Object.keys(normalized), 'hasPassword', 'hasPassphrase']));
      }
      for (const row of payload.projects) {
        for (const serviceId of row.serviceIds) this.db.prepare('INSERT INTO project_services(projectId,serviceId) VALUES(?,?)').run(row.id, id(serviceId, '서비스'));
        if (row.connection !== undefined) {
          const actual = this.project(row.id).connection;
          let expected = null;
          if (row.connection !== null) {
            object(row.connection, '백업 파일의 프로젝트 연결 설정');
            const normalized = this.normalizeService({ ...row.connection, hostFingerprint: '' }, null);
            expected = normalizeRow(row.connection, normalized, [...Object.keys(normalized), 'hasPassword', 'hasPassphrase']);
          }
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            // Compare fields rather than insertion order: old imports and JSON
            // serializers may arrange otherwise identical keys differently.
            if (!actual || !expected || Object.keys(actual).length !== Object.keys(expected).length || Object.keys(actual).some(key => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))) fail('백업 파일의 프로젝트 연결 설정이 일치하지 않습니다.');
          }
        }
      }
      const counters = new Map();
      for (const row of payload.reviews) {
        object(row);
        const normalized = {...this.normalizeReview({...row,evidence:undefined}, null),evidenceJson:JSON.stringify(evidenceValue(row.evidence || {}))};
        const sequence = counters.get(normalized.projectId) || 0;
        const number = integer(row.number, sequence + 1, 1, Number.MAX_SAFE_INTEGER, '리뷰 번호');
        counters.set(normalized.projectId, Math.max(number, sequence));
        insertRow('reviews', normalizeRow(row, { ...normalized, number }, [...Object.keys(normalized).filter(key=>key!=='evidenceJson'),'evidence', 'number']));
      }
      for (const row of payload.agentRuns || []) {
        object(row);
        const normalized = this.normalizeAgentRun(row,null,true,true);
        const allowed = [...Object.keys(normalized).filter(key => !['progressJson','metadataJson'].includes(key)),'progress',...AGENT_METADATA];
        insertRow('agent_runs',normalizeRow(row,normalized,allowed));
      }
      for (const row of payload.activities) {
        object(row);
        const type = choice(row.type, ['comment', 'created', 'updated', 'status'], 'comment', '활동 종류');
        const evidence=evidenceValue(row.evidence || {});
        const body = text(row.body, '댓글', 100000, type === 'comment' && !payload.attachments.some(file => file.activityId === row.id) && !Object.keys(evidence).length);
        const fromStatus = row.fromStatus ? choice(row.fromStatus, STATUSES, '', '이전 상태') : '';
        const toStatus = row.toStatus ? choice(row.toStatus, STATUSES, '', '변경 상태') : '';
        const role = choice(row.role,['user','agent','system'],'user','작성자 종류');
        const agentRunId = row.agentRunId ? id(row.agentRunId,'에이전트 실행') : '';
        if (agentRunId) {
          const run = this.get('agent_runs',agentRunId);
          if (run.reviewId !== row.reviewId) fail('같은 리뷰의 에이전트 실행 기록만 연결할 수 있습니다.');
          if (role === 'agent' && (run.status !== 'completed' || type !== 'comment')) fail('에이전트 응답과 실행 기록이 일치하지 않습니다.');
        }
        if (type === 'status' && (!fromStatus || !toStatus)) fail('백업 파일의 상태 변경 기록이 올바르지 않습니다.');
        insertRow('activities', normalizeRow(row, { reviewId: id(row.reviewId), type, body, fromStatus, toStatus,role,agentRunId,evidenceJson:JSON.stringify(evidence) }, ['reviewId', 'type', 'body', 'fromStatus', 'toStatus','role','agentRunId','evidence']));
      }
      for (const row of payload.attachments) {
        object(row);
        const sha256 = text(row.sha256, '파일 해시', 64, true);
        if (!/^[a-f0-9]{64}$/i.test(sha256)) fail('백업 파일의 파일 해시가 올바르지 않습니다.');
        const normalized = { reviewId: id(row.reviewId), activityId: row.activityId ? id(row.activityId) : null,
          name: safeFilename(row.name), mimeType: text(row.mimeType, '파일 형식', 255, true),
          size: integer(row.size, 0, 0, 1024 * 1024 * 1024, '파일 크기'), storageName: safeFilename(row.storageName), sha256 };
        insertRow('attachments', normalizeRow(row, normalized, Object.keys(normalized)));
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('백업 파일의 자료 연결이 올바르지 않습니다.');
    });
  }

  backup(destination) {
    const target = path.resolve(text(destination, '백업 경로', 4096, true));
    if ([this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`].includes(target)) fail('다른 경로에 백업을 저장하십시오.');
    if (fs.existsSync(target)) fail('같은 이름의 백업 파일이 이미 있습니다.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(target);
    fs.chmodSync(target, 0o600);
    return { path: target, size: fs.statSync(target).size };
  }
  close() {
    if (this.closed) return;
    if (this.dbPath !== ':memory:') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close(); this.closed = true;
  }
}

module.exports = { LocalStore, createStore: options => new LocalStore(options), SCHEMA_VERSION, STATUSES, PRIORITIES, CATEGORIES };
