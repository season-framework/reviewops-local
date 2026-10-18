'use strict';

const fs = require('node:fs/promises');

async function syncDirectory(directory, { platform = process.platform, fsImpl = fs } = {}) {
  // Node's Windows file API cannot flush a directory handle. Callers still
  // flush file contents before renaming; do not suppress file or rename errors.
  if (platform === 'win32') return;
  const handle = await fsImpl.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

module.exports = { syncDirectory };
