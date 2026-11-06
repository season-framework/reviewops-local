'use strict';

const {encodingByteFactors} = require('./sqlite-read-bounds.cjs');

// Internal Store bookkeeping. These values are neither peer grants nor wire IDs.
const MAX_BIRTH = Number.MAX_SAFE_INTEGER;
const MAX_PROJECTS = 100000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail() {
  throw Object.assign(new Error('Committed peer read state is unavailable.'), {code: 'PEER_READ_UNAVAILABLE'});
}
function epoch(db) {
  const row = db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get();
  if (!row || typeof row.epoch !== 'string' || !EPOCH.test(row.epoch)) fail();
  return row.epoch;
}
function counter(db) {
  // SQL masks invalid/unsafe integers before the driver converts any value.
  const rows = db.prepare(`SELECT singleton,epoch,
    CASE WHEN typeof(value)='integer' AND value BETWEEN 0 AND ${MAX_BIRTH} THEN value END AS value
    FROM peer_project_birth_counter LIMIT 2`).all();
  if (rows.length !== 1 || rows[0].singleton !== 1 || typeof rows[0].epoch !== 'string' ||
      !EPOCH.test(rows[0].epoch) || !Number.isSafeInteger(rows[0].value) || rows[0].value < 0) fail();
  return rows[0];
}

// Called only inside the Store's schema-migration transaction.
function migrate(db) {
  const currentEpoch = epoch(db);
  const projects = db.prepare('SELECT id FROM projects ORDER BY id').all();
  if (projects.some(row => typeof row.id !== 'string' || !ID.test(row.id))) fail();
  db.exec(`
    CREATE TABLE peer_project_birth_counter (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL CHECK(length(epoch)=36),
      value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value BETWEEN 0 AND ${MAX_BIRTH})
    );
    CREATE TABLE peer_project_births (
      projectId TEXT NOT NULL PRIMARY KEY,
      birth INTEGER NOT NULL UNIQUE CHECK(typeof(birth)='integer' AND birth BETWEEN 1 AND ${MAX_BIRTH})
    );
  `);
  db.prepare('INSERT INTO peer_project_birth_counter(singleton,epoch,value) VALUES(1,?,0)').run(currentEpoch);
  const advance = db.prepare('UPDATE peer_project_birth_counter SET value=value+1 WHERE singleton=1');
  const insert = db.prepare('INSERT INTO peer_project_births(projectId,birth) SELECT ?,value FROM peer_project_birth_counter WHERE singleton=1');
  for (const project of projects) { advance.run(); insert.run(project.id); }
  const freshBirth = `
    SELECT CASE WHEN (SELECT COUNT(*) FROM peer_project_birth_counter
      WHERE singleton=1 AND epoch=(SELECT epoch FROM dataset_meta WHERE singleton=1)
        AND typeof(value)='integer' AND value BETWEEN 0 AND ${MAX_BIRTH - 1})!=1
      THEN RAISE(ABORT,'Peer project birth counter is unavailable.') END;
    UPDATE peer_project_birth_counter SET value=value+1 WHERE singleton=1;
    DELETE FROM peer_project_births WHERE projectId=NEW.id;
    INSERT INTO peer_project_births(projectId,birth)
      SELECT NEW.id,value FROM peer_project_birth_counter WHERE singleton=1;`;
  db.exec(`
    CREATE TRIGGER peer_project_birth_insert AFTER INSERT ON projects BEGIN
      ${freshBirth}
    END;
    CREATE TRIGGER peer_project_birth_delete AFTER DELETE ON projects BEGIN
      DELETE FROM peer_project_births WHERE projectId=OLD.id;
    END;
    CREATE TRIGGER peer_project_birth_id_update AFTER UPDATE OF id ON projects
    WHEN OLD.id!=NEW.id BEGIN
      DELETE FROM peer_project_births WHERE projectId=OLD.id;
      ${freshBirth}
    END;
  `);
}

// This raw reader does not confer committed-state or application ownership.
// Only Store.peerReadDataset() supplies its top-level transaction boundary.
function readDataset(db) {
  const factors = encodingByteFactors(db.prepare('PRAGMA encoding').get()?.encoding);
  if (!factors) fail();
  const epochRow = db.prepare(`SELECT CASE WHEN typeof(epoch)='text' AND octet_length(epoch)<=${36 * factors.ascii}
    THEN epoch END AS epoch FROM dataset_meta WHERE singleton=1`).get();
  if (!epochRow || typeof epochRow.epoch !== 'string' || !EPOCH.test(epochRow.epoch)) fail();
  const currentEpoch = epochRow.epoch;
  const controls = db.prepare(`SELECT CASE WHEN singleton=1 THEN 1 END AS singleton,
    CASE WHEN typeof(epoch)='text' AND octet_length(epoch)<=${36 * factors.ascii} THEN epoch END AS epoch,
    CASE WHEN typeof(value)='integer' AND value BETWEEN 0 AND ${MAX_BIRTH} THEN value END AS value
    FROM peer_project_birth_counter LIMIT 2`).all();
  if (controls.length !== 1 || controls[0].singleton !== 1 || typeof controls[0].epoch !== 'string' ||
      !EPOCH.test(controls[0].epoch) || !Number.isSafeInteger(controls[0].value) || controls[0].value < 0) fail();
  const current = controls[0];
  if (current.epoch !== currentEpoch) fail();
  const rows = db.prepare(`SELECT CASE WHEN typeof(p.id)='text' AND octet_length(p.id)<=${128 * factors.ascii} THEN p.id END AS projectId,
    CASE WHEN typeof(b.birth)='integer' AND b.birth BETWEEN 1 AND ${MAX_BIRTH} THEN b.birth END AS birth FROM projects p
    LEFT JOIN peer_project_births b ON b.projectId=p.id ORDER BY projectId LIMIT ${MAX_PROJECTS + 1}`).all();
  if (rows.length > MAX_PROJECTS || db.prepare(`SELECT COUNT(*) AS count FROM
    (SELECT 1 FROM peer_project_births LIMIT ${MAX_PROJECTS + 1})`).get().count !== rows.length) fail();
  const seen = new Set();
  for (const row of rows) {
    if (typeof row.projectId !== 'string' || !ID.test(row.projectId) || !Number.isSafeInteger(row.birth) ||
        row.birth < 1 || row.birth > current.value || seen.has(row.birth)) fail();
    seen.add(row.birth);
  }
  return Object.freeze({epoch: currentEpoch, projects: Object.freeze(rows.map(row =>
    Object.freeze({projectId: row.projectId, birth: row.birth})))});
}

// Called only after logical import changed epoch and removed the old projects,
// within that same Store transaction. Rollback restores both sidecars and epoch.
function resetForLogicalImport(db) {
  const currentEpoch = epoch(db), previous = counter(db);
  if (currentEpoch === previous.epoch || db.prepare('SELECT 1 FROM projects LIMIT 1').get()) fail();
  db.exec('DELETE FROM peer_project_births;');
  db.prepare('UPDATE peer_project_birth_counter SET epoch=?,value=0 WHERE singleton=1').run(currentEpoch);
}

module.exports = {migrate, readDataset, resetForLogicalImport, MAX_BIRTH};
