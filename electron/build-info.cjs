'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateBuildInfo(value, expectedVersion) {
  if (!value || value.channel !== 'test' || !/^\d+\.\d+\.\d+$/.test(value.version || '') ||
      !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(value.commit || '') || typeof value.builtAt !== 'string' ||
      !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt ||
      (expectedVersion && value.version !== expectedVersion)) throw new Error('테스트 빌드 정보가 올바르지 않습니다.');
  return { channel: 'test', version: value.version, buildNumber: value.buildNumber, commit: value.commit, builtAt: value.builtAt };
}
function getBuildInfo(version) {
  try { return validateBuildInfo(JSON.parse(fs.readFileSync(path.join(__dirname, 'reviewops-build.json'), 'utf8')), version); }
  catch (error) { if (error.code === 'ENOENT') return { channel: 'stable', version, buildNumber: null, commit: null, builtAt: null }; throw error; }
}
module.exports = { validateBuildInfo, getBuildInfo };
