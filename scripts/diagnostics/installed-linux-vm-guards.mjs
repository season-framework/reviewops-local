// Pure data admission only. Importing this module creates no files, keys or processes.
import crypto from 'node:crypto';
import path from 'node:path';

export const PRODUCT_SOURCE = '2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a';
export const BASE_SOURCE = '34bf2ed064a93c709a2f6d00caa70ca444abca55';
export const UI_SHA256 = '2fbf69b3535296aa3d89699641fc4284dec21fc98d55f1fe84df321e1d8f55b2';
export const R3_ROOT_SHA256 = '22d6acbec72a1da9e253a9bd5f52f1dc1b40beab52fbf515335a2f44b5613d95';
export const CONTRACT = 'issue34-one-original-vm-conditional-ui-v1';
export const ADDED_PATHS = Object.freeze([
  'docs/diagnostics/installed-linux-permission-vm.md',
  'scripts/diagnostics/installed-linux-permission-vm.mjs',
  'scripts/diagnostics/installed-linux-vm-guards.mjs',
  'tests/installed-linux-vm-guards.test.mjs',
]);
const SHA = /^[a-f0-9]{64}$/;
export const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export class VMGuardError extends Error { constructor(code) { super(code); this.name = 'VMGuardError'; } }
export function need(value, code) { if (!value) throw new VMGuardError(code); }
export function same(a, b) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}
export const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !/[\0\r\n]/.test(value);
export const inside = (root, value) => absolute(root) && absolute(value) && value.startsWith(root + '/');
export function pinShape(value) {
  need(value && absolute(value.path) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && SHA.test(value.sha256), 'pin-shape');
}
// Only these observed output records may be empty; authority, JSON and binary pins stay strict.
export function evidencePinShape(value, role) {
  need(['probe-stderr', 'original-stdout', 'original-stderr'].includes(role), 'evidence-pin-role');
  if (value?.bytes !== 0) return pinShape(value);
  need(absolute(value.path) && value.sha256 === hashBytes(Buffer.alloc(0)), 'empty-evidence-pin');
}

export const LIVE_LIMITS = Object.freeze({jsonBytes: 8 * 1024**2, entries: 20000,
  totalBytes: 1024**3, fileBytes: 512 * 1024**2, linkHops: 128});
export const LIVE_TYPE = Object.freeze({directory: 0o040000, regular: 0o100000, link: 0o120000});
function relativeName(value) {
  return typeof value === 'string' && value && Buffer.byteLength(value) <= 4096 &&
    !/[\x00-\x1f\x7f\\]/.test(value) && Buffer.from(value).toString('utf8') === value &&
    !path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
    value.split('/').every(part => part && part !== '.' && part !== '..');
}
export function privatePrefixShape(capability) {
  need(/^\/tmp\/r34[a-f0-9]{4}$/.test(capability?.logicalPrefix || '') &&
    capability.physicalPrefix === '/private' + capability.logicalPrefix, 'live-prefix-spelling');
}
export function resolveInventoryLink(name, rows) {
  let pending = [...name.split('/')], resolved = [], hops = 0; const seen = new Set();
  while (pending.length) {
    need(pending.length <= 4096, 'live-link-components');
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') { need(resolved.length > 0, 'live-link-escape'); resolved.pop(); continue; }
    const candidate = [...resolved, part].join('/'), row = rows[candidate];
    need(row, 'live-link-dangling');
    if (row.type === LIVE_TYPE.link) {
      const key = candidate + '\0' + pending.join('/');
      need(++hops <= LIVE_LIMITS.linkHops && !seen.has(key), 'live-link-cycle-cap'); seen.add(key);
      pending = [...row.target.split('/'), ...pending];
    } else {
      need(!pending.length || row.type === LIVE_TYPE.directory, 'live-link-not-directory');
      resolved.push(part);
    }
  }
  const target = resolved.join('/'); need(target && rows[target] && rows[target].type !== LIVE_TYPE.link, 'live-link-dangling');
  return target;
}
export function inventoryShape(rows) {
  need(rows && typeof rows === 'object' && !Array.isArray(rows), 'live-inventory-dict');
  const names = Object.keys(rows); need(names.length > 0 && names.length <= LIVE_LIMITS.entries, 'live-entry-cap');
  const counts = {entries: names.length, directories: 0, regularFiles: 0, symlinks: 0, regularBytes: 0};
  for (const name of names) {
    const row = rows[name]; need(relativeName(name) && row && typeof row === 'object' && !Array.isArray(row), 'live-row');
    need(Number.isSafeInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777, 'live-mode');
    if (row.type === LIVE_TYPE.regular) {
      need(same(Object.keys(row).sort(), ['bytes', 'mode', 'sha256', 'type']) &&
        Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= LIVE_LIMITS.fileBytes && SHA.test(row.sha256) &&
        (row.bytes !== 0 || row.sha256 === hashBytes(Buffer.alloc(0))), 'live-regular-row');
      counts.regularFiles++; counts.regularBytes += row.bytes;
      need(counts.regularBytes <= LIVE_LIMITS.totalBytes, 'live-total-byte-cap');
    } else if (row.type === LIVE_TYPE.directory) {
      need(same(Object.keys(row).sort(), ['mode', 'type']), 'live-directory-row'); counts.directories++;
    } else {
      need(row.type === LIVE_TYPE.link && same(Object.keys(row).sort(), ['mode', 'target', 'type']) &&
        typeof row.target === 'string' && row.target && Buffer.byteLength(row.target) <= 4096 &&
        !path.posix.isAbsolute(row.target) && !/[\x00-\x1f\x7f\\]/.test(row.target) &&
        Buffer.from(row.target).toString('utf8') === row.target, 'live-relative-link-row'); counts.symlinks++;
    }
    let parent = path.posix.dirname(name);
    while (parent !== '.') { need(rows[parent]?.type === LIVE_TYPE.directory, 'live-declared-directory-parent'); parent = path.posix.dirname(parent); }
  }
  for (const name of names) if (rows[name].type === LIVE_TYPE.link) resolveInventoryLink(name, rows);
  return counts;
}
export function liveIdentity(st) {
  return Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']
    .map(key => [key, String(st[key])]));
}
export function prefixIncarnation(identity) {
  return Object.fromEntries(['dev', 'ino', 'uid', 'mode', 'birthtimeNs'].map(key => [key, identity[key]]));
}

// JSON.parse alone loses duplicate keys, including escaped-equivalent spellings.
export function strictJSON(text, maximum = 65536) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= maximum, 'json-cap');
  let i = 0, nodes = 0;
  const white = () => { while (/[ \t\r\n]/.test(text[i] || '\0')) i++; };
  const string = () => {
    const start = i++;
    need(text[start] === '"', 'json-string');
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      need(c >= 32, 'json-control');
      if (c === 34) {
        try { return JSON.parse(text.slice(start, i)); } catch { throw new VMGuardError('json-string'); }
      }
      if (c === 92) {
        const escape = text[i++];
        need(typeof escape === 'string' && '"\\/bfnrtu'.includes(escape), 'json-escape');
        if (escape === 'u') { need(/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4)), 'json-unicode'); i += 4; }
      }
    }
    throw new VMGuardError('json-unclosed-string');
  };
  const value = depth => {
    need(depth <= 24 && ++nodes <= (maximum > 65536 ? 131072 : 4096), 'json-depth-count'); white();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; white(); const object = Object.create(null), names = new Set();
      if (text[i] === '}') { i++; return object; }
      while (true) {
        white(); const name = string(); need(!names.has(name), 'json-duplicate-key'); names.add(name);
        white(); need(text[i++] === ':', 'json-colon'); object[name] = value(depth + 1); white();
        if (text[i] === '}') { i++; return object; }
        need(text[i++] === ',', 'json-comma');
      }
    }
    if (c === '[') {
      i++; white(); const array = []; if (text[i] === ']') { i++; return array; }
      while (true) { array.push(value(depth + 1)); white(); if (text[i] === ']') { i++; return array; } need(text[i++] === ',', 'json-comma'); }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.slice(i, i + word.length) === word) { i += word.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    need(number && Number.isFinite(Number(number[0])), 'json-number'); i += number[0].length; return Number(number[0]);
  };
  const result = value(0); white(); need(i === text.length, 'json-trailing'); return result;
}

export class QMPFrames {
  #buffer = Buffer.alloc(0);
  push(chunk) {
    need(Buffer.isBuffer(chunk), 'qmp-buffer'); this.#buffer = Buffer.concat([this.#buffer, chunk]);
    need(this.#buffer.length <= 131072, 'qmp-buffer-cap'); const output = [];
    while (this.#buffer.length) {
      let depth = 0, quoted = false, escaped = false, end = -1;
      need(this.#buffer[0] === 123, 'qmp-object-start');
      for (let i = 0; i < this.#buffer.length; i++) {
        const c = this.#buffer[i];
        if (quoted) { if (escaped) escaped = false; else if (c === 92) escaped = true; else if (c === 34) quoted = false; }
        else if (c === 34) quoted = true;
        else if (c === 123 || c === 91) depth++;
        else if (c === 125 || c === 93) { need(--depth >= 0, 'qmp-depth'); if (depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) { need(this.#buffer.length <= 65536, 'qmp-frame-cap'); break; }
      let delimiter = end; while ([32, 9].includes(this.#buffer[delimiter])) delimiter++;
      if (this.#buffer.length > delimiter) need(this.#buffer[delimiter] === 13, 'qmp-crlf');
      if (this.#buffer.length < delimiter + 2) break;
      need(this.#buffer[delimiter] === 13 && this.#buffer[delimiter + 1] === 10, 'qmp-crlf');
      let text; try { text = new TextDecoder('utf-8', {fatal: true}).decode(this.#buffer.subarray(0, end)); }
      catch { throw new VMGuardError('qmp-utf8'); }
      const object = strictJSON(text); need(object && !Array.isArray(object) && typeof object === 'object', 'qmp-object');
      output.push(object); this.#buffer = this.#buffer.subarray(delimiter + 2);
    }
    return output;
  }
  end() { need(this.#buffer.length === 0, 'qmp-partial-eof'); }
}

export class QMPProtocol {
  greeted = false; negotiated = false; outstanding = null; messages = []; failure = null;
  powerdown = null; shutdown = null;
  command(name, id) {
    need(this.greeted && !this.outstanding && !this.failure && /^[a-z0-9-]{1,64}$/.test(id), 'qmp-one-outstanding');
    need(['qmp_capabilities', 'query-status', 'query-target', 'system_powerdown'].includes(name), 'qmp-command');
    need(name === 'qmp_capabilities' ? !this.negotiated : this.negotiated, 'qmp-negotiation');
    if (name === 'system_powerdown') { need(!this.powerdown, 'qmp-powerdown-once'); this.powerdown = {id, sentOrdinal: this.messages.length, acknowledged: false}; }
    this.outstanding = {name, id}; return Buffer.from(JSON.stringify({execute: name, id}) + '\r\n');
  }
  receive(object) {
    need(this.messages.length < 512 && object && typeof object === 'object' && !Array.isArray(object), 'qmp-message');
    this.messages.push(object);
    if (Object.hasOwn(object, 'QMP')) {
      need(!this.greeted && !this.outstanding && Object.keys(object).length === 1, 'qmp-greeting-order');
      need(same(object.QMP.version.qemu, {major: 11, minor: 1, micro: 3}) && Array.isArray(object.QMP.capabilities), 'qmp-version');
      this.greeted = true; return {kind: 'greeting'};
    }
    if (Object.hasOwn(object, 'event')) {
      need(typeof object.event === 'string', 'qmp-event');
      if (object.event === 'RESET' || object.event === 'GUEST_PANICKED') this.failure = 'qmp-abnormal-guest-event';
      if (object.event === 'SHUTDOWN') {
        if (!this.powerdown || object.data?.guest !== true || object.data?.reason !== 'guest-shutdown' || this.shutdown) this.failure = 'qmp-abnormal-shutdown';
        else this.shutdown = {ordinal: this.messages.length, data: object.data};
      }
      return {kind: 'event', event: object.event};
    }
    need(this.outstanding && object.id === this.outstanding.id &&
      (Object.hasOwn(object, 'return') !== Object.hasOwn(object, 'error')), 'qmp-reply-id');
    const pending = this.outstanding; this.outstanding = null;
    if (Object.hasOwn(object, 'error')) { this.failure = 'qmp-command-error'; throw new VMGuardError(this.failure); }
    if (pending.name === 'qmp_capabilities') this.negotiated = true;
    if (pending.name === 'system_powerdown') this.powerdown.acknowledged = true;
    return {kind: 'reply', name: pending.name, value: object.return};
  }
  normalPoweroff() { return !this.failure && !this.outstanding && this.powerdown?.acknowledged === true &&
    Boolean(this.shutdown && this.shutdown.ordinal > this.powerdown.sentOrdinal); }
}

export function closure(record) {
  return Boolean(record && record.exitObserved === true && record.closed === true && record.exit?.code === 0 &&
    record.exit.signal === null && ['stdoutEOF', 'stderrEOF', 'stdoutClosed', 'stderrClosed', 'stdoutFileClosed', 'stderrFileClosed'].every(k => record[k] === true));
}
export class OriginalVM {
  #token = null; #owner = null;
  attempts = 0; powerdownRequests = 0;
  begin() { need(this.attempts === 0, 'vm-once'); this.attempts++; this.#token = Object.freeze({}); return this.#token; }
  retain(token, original) { need(token === this.#token && original && !this.#owner, 'vm-current-original'); this.#owner = original; }
  matches(original) { return original !== null && original === this.#owner; }
  powerdown(original, cleanup) { need(this.matches(original) && this.powerdownRequests === 0 && powerdownSafe(cleanup), 'vm-powerdown-admission'); this.powerdownRequests++; }
  confirm(original, record, qmp) { need(this.matches(original) && this.powerdownRequests === 1 && closure(record) && qmp.normalPoweroff(), 'vm-normal-closure'); }
}
export function powerdownSafe(context) {
  if (!context || context.bootstrapClosed !== true) return false;
  if (context.uiLaunchAttempts === 0) return context.uiChildStarted === false && context.denyOperationPossible === false;
  return context.uiLaunchAttempts === 1 && context.uiChildStarted === true && context.uiDriverClosed === true && uiCleanup(context.uiResult);
}
export function uiCleanup(result) {
  return Boolean(result && result.permissionRestored === true && result.controlConnectionClosed === true &&
    result.cleanupConfirmed === true && result.appLaunchAttempts === 1 && result.normalQuitRequests === 1 &&
    result.originalApp?.applicationClosed === true && result.originalApp?.childClosed === true &&
    result.originalApp?.exitObserved === true && result.originalApp.exit?.code === 0 && result.originalApp.exit.signal === null &&
    ['stdoutEOF', 'stderrEOF', 'stdoutClosed', 'stderrClosed'].every(k => result.originalApp[k] === true));
}

function both32(bytes, offset) {
  need(offset >= 0 && offset + 8 <= bytes.length, 'iso-u32-bounds');
  const n = bytes.readUInt32LE(offset); need(n === bytes.readUInt32BE(offset + 4), 'iso-u32-pair'); return n;
}
function both16(bytes, offset) { const n = bytes.readUInt16LE(offset); need(n === bytes.readUInt16BE(offset + 2), 'iso-u16-pair'); return n; }
function ucs2(bytes) { need(bytes.length % 2 === 0, 'iso-ucs2'); let text = ''; for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(bytes.readUInt16BE(i)); return text; }
function directory(bytes, record, joliet) {
  need(record.length >= 34 && (record[25] & 2) !== 0, 'iso-root-directory');
  const extent = both32(record, 2), size = both32(record, 10), start = extent * 2048;
  need(size <= 65536 && start + size <= bytes.length, 'iso-directory-bounds'); const entries = [];
  for (let at = start; at < start + size;) {
    const n = bytes[at]; if (!n) { at = (Math.floor(at / 2048) + 1) * 2048; continue; }
    need(n >= 34 && at + n <= start + size && Math.floor(at / 2048) === Math.floor((at + n - 1) / 2048), 'iso-record-bounds');
    const row = bytes.subarray(at, at + n), count = row[32]; need(33 + count <= n, 'iso-name-bounds');
    const raw = row.subarray(33, 33 + count); at += n;
    if (count === 1 && (raw[0] === 0 || raw[0] === 1)) continue;
    need(!(row[25] & (2 | 128)), 'iso-no-directory-or-multiextent');
    const name = (joliet ? ucs2(raw) : raw.toString('ascii')).replace(/;1$/, '');
    const offset = both32(row, 2) * 2048, length = both32(row, 10);
    need(length <= 65536 && offset + length <= bytes.length, 'iso-file-bounds');
    entries.push({name, offset, bytes: length, sha256: hashBytes(bytes.subarray(offset, offset + length))});
  }
  need(entries.length === 3 && new Set(entries.map(r => r.name)).size === 3, 'iso-exact-file-count'); return entries;
}
export function inspectSeedISO(bytes, expected) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 19 * 2048 && bytes.length <= 16 * 1024**2 && bytes.length % 2048 === 0, 'iso-size');
  let primary, joliet, ended = false;
  for (let sector = 16; sector < 48 && (sector + 1) * 2048 <= bytes.length; sector++) {
    const descriptor = bytes.subarray(sector * 2048, (sector + 1) * 2048);
    need(descriptor.subarray(1, 6).toString('ascii') === 'CD001' && descriptor[6] === 1, 'iso-descriptor');
    if (descriptor[0] === 255) { ended = true; break; }
    if (descriptor[0] === 1 || descriptor[0] === 2) {
      need(both16(descriptor, 128) === 2048 && both32(descriptor, 80) * 2048 <= bytes.length, 'iso-volume-size');
      if (descriptor[0] === 1) { need(!primary, 'iso-primary-once'); primary = descriptor; }
      else { need(!joliet && ['%/@', '%/C', '%/E'].includes(descriptor.subarray(88, 91).toString('ascii')), 'iso-joliet'); joliet = descriptor; }
    } else need(false, 'iso-unexpected-descriptor');
  }
  need(primary && joliet && ended, 'iso-descriptor-set');
  const label = primary.subarray(40, 72).toString('ascii').replace(/\0+$/, '').trim(),
    secondary = ucs2(joliet.subarray(40, 72)).replace(/\0+$/, '').trim();
  need(['cidata', 'CIDATA'].includes(label) && ['cidata', 'CIDATA'].includes(secondary), 'iso-cidata-label');
  const p = directory(bytes, primary.subarray(156, 190), false), j = directory(bytes, joliet.subarray(156, 190), true);
  need(same(p.map(({offset, bytes, sha256}) => ({offset, bytes, sha256})).sort((a, b) => a.offset - b.offset),
    j.map(({offset, bytes, sha256}) => ({offset, bytes, sha256})).sort((a, b) => a.offset - b.offset)), 'iso-namespace-extents');
  need(same(j.map(r => r.name).sort(), ['meta-data', 'network-config', 'user-data']), 'iso-exact-names');
  for (const row of j) need(row.bytes === expected[row.name].length && row.sha256 === hashBytes(expected[row.name]), 'iso-exact-content');
  return {bytes: bytes.length, sha256: hashBytes(bytes), primaryLabel: label, jolietLabel: secondary, primaryFiles: p, files: j};
}

export function publicKey(value) {
  need(typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value.trim()), 'public-key-line');
  const fields = value.trim().split(/\s+/); need(fields.length >= 2 && fields[0] === 'ssh-ed25519' && /^[A-Za-z0-9+/]+={0,2}$/.test(fields[1]), 'public-key-type');
  const wire = Buffer.from(fields[1], 'base64'); need(wire.length === 51 && wire.readUInt32BE(0) === 11 &&
    wire.subarray(4, 15).toString('ascii') === 'ssh-ed25519' && wire.readUInt32BE(15) === 32, 'public-key-wire');
  return {line: fields.slice(0, 2).join(' '), fingerprint: 'SHA256:' + crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')};
}
export function seedFiles({username, uid, nonce, clientPublicKey}) {
  need(username === 'rvqa' && uid === 1001 && /^[a-f0-9]{32}$/.test(nonce), 'seed-identity');
  const key = publicKey(clientPublicKey);
  const marker = `#!/usr/bin/python3\nimport os,json,pwd,platform\np=pwd.getpwnam('rvqa')\nk=open('/etc/ssh/ssh_host_ed25519_key.pub').read().strip().split()[:2]\nv={'nonce':'${nonce}','username':'rvqa','uid':p.pw_uid,'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'platform':platform.system(),'machine':platform.machine(),'hostPublicKey':' '.join(k)}\nf=os.open('/dev/ttyS0',os.O_WRONLY|os.O_NOCTTY)\nos.write(f,('REVIEWOPS_BOOTSTRAP '+json.dumps(v,separators=(',',':'))+'\\n').encode())\nos.close(f)\n`;
  const yaml = '#cloud-config\nusers:\n  - name: rvqa\n    uid: 1001\n    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ' + JSON.stringify(key.line) +
    '\nssh_pwauth: false\ndisable_root: true\npackage_update: false\npackage_upgrade: false\nwrite_files:\n  - path: /usr/local/sbin/reviewops-bootstrap-marker\n    owner: root:root\n    permissions: "0755"\n    content: |\n' + marker.trimEnd().split('\n').map(s => '      ' + s).join('\n') +
    '\nruncmd:\n  - ["/usr/local/sbin/reviewops-bootstrap-marker"]\n';
  return {'user-data': Buffer.from(yaml), 'meta-data': Buffer.from(`instance-id: r34-${nonce}\nlocal-hostname: reviewops-owned-linux\n`),
    'network-config': Buffer.from('version: 2\nethernets:\n  qaeth:\n    match:\n      name: "e*"\n    dhcp4: true\n    dhcp6: false\n    link-local: []\n')};
}
export function bootstrapMarker(value, nonce) {
  need(value?.nonce === nonce && value.username === 'rvqa' && value.uid === 1001 && value.platform === 'Linux' &&
    value.machine === 'x86_64' && /^[a-f0-9-]{36}$/.test(value.bootId), 'bootstrap-marker');
  return {...value, hostKeyFingerprint: publicKey(value.hostPublicKey).fingerprint};
}
export function witnessSource({cli, home, codeHome, logPath}) {
  need([cli, home, codeHome, logPath].every(absolute) && inside(home, cli) && inside(home, logPath) && codeHome === home + '/.codex', 'witness-paths');
  const values = JSON.stringify({cli, home, codeHome, logPath});
  return Buffer.from('#!/usr/bin/python3\nimport os,sys,json\nv=json.loads(' + JSON.stringify(values) + ')\na=sys.argv[1:]\nassert a in [["--version"],["login","status"],["app-server"]]\ne=os.environ\nrow={"args":a,"cwd":os.getcwd(),"uid":os.getuid(),"home":e.get("HOME"),"codeHome":e.get("CODEX_HOME",os.path.join(e.get("HOME",""),".codex")),"forbiddenEnvironmentNames":[k for k in ["SSH_AUTH_SOCK","OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_API_KEY","NODE_OPTIONS","NODE_PATH"] if e.get(k)]}\nassert row["uid"]>0 and row["home"]==v["home"] and row["codeHome"]==v["codeHome"] and not row["forbiddenEnvironmentNames"]\nfd=os.open(v["logPath"],os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)\nos.write(fd,(json.dumps(row,separators=(",",":"))+"\\n").encode())\nos.close(fd)\nos.execve(v["cli"],[v["cli"]]+a,dict(e))\n');
}

export function materialized(originalPin, localPin, rows) {
  pinShape(originalPin); pinShape(localPin);
  need(originalPin.bytes === localPin.bytes && originalPin.sha256 === localPin.sha256 && Array.isArray(rows) &&
    rows.filter(row => same(row.originalPin, originalPin) && same(row.localPin, localPin)).length === 1, 'materialization-exact-join');
}

export const UI_CI_KEYS = Object.freeze(['CI', 'GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'GITHUB_SHA']);
export function uiChildEnvironment(setup, admittedCI, request) {
  const expected = {CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: String(request.runID), GITHUB_SHA: request.harnessSource};
  need(same(admittedCI, expected), 'ui-child-admitted-ci');
  const output = {};
  for (const key of ['HOME', 'TMPDIR', 'PATH', 'LANG', 'TZ']) {
    need(typeof setup[key] === 'string' && setup[key].length > 0 && !/[\0\r\n]/.test(setup[key]), 'ui-child-setup-environment');
    output[key] = setup[key];
  }
  for (const key of UI_CI_KEYS) output[key] = admittedCI[key];
  return output;
}

// A broken evidence disk must not throw from a child/socket callback or HELD timer.
export class EvidencePersistence {
  failed = false; failure = null;
  constructor(writer) { need(typeof writer === 'function', 'evidence-writer'); this.writer = writer; }
  noteFailure(error) {
    this.failed = true;
    if (!this.failure) {
      let errorType = 'Error', code = null;
      try { if (typeof error?.name === 'string' && /^[A-Za-z]{1,48}$/.test(error.name)) errorType = error.name;
        if (typeof error?.code === 'string' && /^E[A-Z0-9_]{1,48}$/.test(error.code)) code = error.code;
      } catch { /* Error metadata itself is untrusted; retain the permanent flag. */ }
      this.failure = Object.freeze({reason: 'evidence-persistence-failed', errorType, code});
    }
  }
  save(snapshot) {
    try { this.writer(snapshot()); } catch (error) { this.noteFailure(error); }
    return !this.failed;
  }
  requireHealthy() { need(!this.failed, 'evidence-persistence-failed'); }
}
export function evidenceSaver(state, writer) {
  const evidence = new EvidencePersistence(writer);
  const save = extra => {
    evidence.save(() => {
      Object.assign(state, extra || {}); state.evidencePersistenceFailure = evidence.failure;
      if (evidence.failed) state.ok = false;
      return JSON.stringify(state, null, 2) + '\n';
    });
    if (evidence.failed) {
      try { state.ok = false; state.evidencePersistenceFailure = evidence.failure; }
      catch (error) { evidence.noteFailure(error); }
    }
    return !evidence.failed;
  };
  return {evidence, save};
}
export function assertParentAuthority(b, a, host, code) {
  need(b.schema === 1 && b.phase === 'vm-owner' && b.scenario === 'installed-linux-permission' && b.productSource === PRODUCT_SOURCE &&
    /^[a-f0-9]{40}$/.test(b.harnessSource) && host.sha === b.harnessSource && Number.isSafeInteger(b.runID) && b.runID === host.runID, 'owner-request');
  need(host.platform === 'darwin' && host.arch === 'arm64' && /^24\./.test(host.node) && host.uid > 0 &&
    host.ci === 'true' && host.actions === 'true' && host.event === 'workflow_dispatch' && host.attempt === 1, 'owner-host');
  need(a.approved === true && a.scope === CONTRACT && a.requestSHA256 === code.requestSHA256 && a.runID === b.runID &&
    a.harnessSource === b.harnessSource && a.productSource === PRODUCT_SOURCE && a.ownerSHA256 === code.ownerSHA256 &&
    a.guardsSHA256 === code.guardsSHA256 && a.uiDriverSHA256 === UI_SHA256 && a.predicateContract === CONTRACT &&
    a.allowConditionalGuestProofAndUIApproval === true && a.maximumVMLaunches === 1 && a.maximumAppLaunches === 1 &&
    a.maximumPowerdownRequests === 1 && a.networkAcquisitionAuthorized === false &&
    same(a.inputPins, b.inputPins), 'exact-root-delegation');
  need(b.inputPins.r3Root.sha256 === R3_ROOT_SHA256 && b.ui.driverPin.sha256 === UI_SHA256 &&
    b.maximumVMLaunches === 1 && b.maximumAppLaunches === 1 && b.maximumPowerdownRequests === 1, 'owner-fixed-inputs');
  for (const record of Object.values(b.inputPins)) pinShape(record);
  for (const record of Object.values(b.tools)) pinShape(record);
  need(b.tools.hdiutil.path === '/usr/bin/hdiutil' && b.tools.sshKeygen.path === '/usr/bin/ssh-keygen', 'system-tool-paths');
  need(/^\/private\/tmp\/r34v-[a-z0-9_-]{8,16}$/.test(b.privateRoot) && inside(b.root + '/test-results/installed-linux-permission-vm', b.output) &&
    inside(b.privateRoot, b.ui.packageApp) && b.ui.privateRoot === b.privateRoot && /^pc-i440fx-\d+\.\d+$/.test(b.machineID), 'owner-paths-machine');
  need(Buffer.byteLength(b.privateRoot + '/qmp.sock') <= 103 && Buffer.byteLength(b.privateRoot + '/data/integrations/tools.sock') <= 103, 'short-sockets');
  const caps = {tool: 180000, boot: 1800000, qmp: 30000, channel: 90000, ui: 1200000, poweroff: 300000};
  need(same(Object.keys(b.deadlines).sort(), Object.keys(caps).sort()) && Object.entries(caps).every(([k, max]) =>
    Number.isSafeInteger(b.deadlines[k]) && b.deadlines[k] > 0 && b.deadlines[k] <= max), 'owner-deadlines');
}
export function unboundRequest() {
  return {schema: 1, phase: 'vm-owner', scenario: 'installed-linux-permission', productSource: PRODUCT_SOURCE,
    harnessSource: null, runID: null, root: null, privateRoot: null, output: null, machineID: null,
    inputPins: {r3Root: null, preparedSupply: null, materialization: null, runtimeRoot: null, runtimeResult: null,
      sourceRoot: null, base438Inventory: null, baseImage: null, vendorELF: null, privateAppRoot: null},
    tools: {node: null, hdiutil: null, sshKeygen: null, qemuSystem: null, qemuImg: null}, ui: {driverPin: null},
    deadlines: {tool: null, boot: null, qmp: null, channel: null, ui: null, poweroff: null},
    maximumVMLaunches: 1, maximumAppLaunches: 1, maximumPowerdownRequests: 1,
    authority: {approved: false, scope: CONTRACT, allowConditionalGuestProofAndUIApproval: false}};
}
