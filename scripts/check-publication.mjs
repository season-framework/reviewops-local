import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Run before committing a public release. This intentionally does not print
// matching values, which may themselves be private.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean))];
const failures = [];
const secretPatterns = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API key', /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ['private key', /^-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{40,}/m],
  ['workstation path', /\/Users\/proin\//],
  ['internal Git host', /git\.sio\.season\.co\.kr/],
];
for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(?:^|\/)(?:auth|credentials)\.json$|\.sqlite(?:-[a-z]+)?$|\.(?:dmg|zip|p12|pfx|pem|key)$/.test(file)) failures.push(`${file}: private data or build artifact`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024) failures.push(`${file}: unexpectedly large source file`);
  if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');
  // The scanner's own pattern definitions are not credentials.
  if (file === 'scripts/check-publication.mjs') continue;
  for (const [label, pattern] of secretPatterns) if (pattern.test(source)) failures.push(`${file}: ${label}`);
}
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json','utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) failures.push('package version mismatch');
if (pkg.license !== 'MIT') failures.push('package license must be MIT');
for (const name of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt']) {
  if (!fs.existsSync(name) || !pkg.build.files.includes(name)) failures.push(`${name}: missing from application package`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public source check passed: ${files.length} files, version ${pkg.version}.`);
}
