'use strict';

// A downgraded business-schema fixture must not retain schema-11 control data.
function removeWriteConsistencySchema(db) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'shared_*'").all()) {
    if (!/^[A-Za-z0-9_]+$/.test(row.name)) throw new Error('Unexpected fixture trigger name');
    db.exec(`DROP TRIGGER ${row.name}`);
  }
  db.exec('DROP TABLE command_receipts; DROP TABLE review_revisions; DROP TABLE dataset_meta;');
}

module.exports = {removeWriteConsistencySchema};
