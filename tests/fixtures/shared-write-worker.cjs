'use strict';

// A synthetic DB-only worker. Deliberate exit codes model loss around COMMIT.
const fs = require('node:fs');
const {createStore} = require('../../electron/store.cjs');
const [dbPath, mode, encoded] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, 'base64').toString());
const store = createStore({dbPath});
const provider = () => ({principalId: 'owned-worker', projectGrants: [{projectId: input.projectId, write: true}]});
const send = value => fs.writeSync(1, JSON.stringify(value) + '\n');
if (mode === 'before-commit') store.transaction(() => {
  store.setReviewStatusCommand(input, provider);
  send({phase: mode}); process.exit(17);
});
else if (mode === 'after-commit') {
  store.setReviewStatusCommand(input, provider);
  send({phase: mode}); process.exit(23);
} else if (mode === 'race') {
  send({ready: true}); process.stdin.resume();
  process.stdin.once('end', () => {
    try { send({result: store.setReviewStatusCommand(input, provider)}); }
    catch (error) { send({error: error.code}); }
    finally { store.close(); }
  });
} else throw new Error('Unknown owned worker mode');
