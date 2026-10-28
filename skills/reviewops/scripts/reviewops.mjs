#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const actions = { list: 'projects.list', open: 'review.open', status: 'review.status' };
const MAX_BYTES = 512 * 1024;
export function defaultDataPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.REVIEWOPS_DATA_DIR) return path.resolve(env.REVIEWOPS_DATA_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ReviewOps Local');
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('APPDATA가 없습니다. --data-dir로 ReviewOps 데이터 폴더를 지정하십시오.');
    return path.join(env.APPDATA, 'ReviewOps Local');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ReviewOps Local');
}
export function expectedSocket(dataPath, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\reviewops-tools-${crypto.createHash('sha256').update(path.win32.resolve(dataPath).toLowerCase()).digest('hex').slice(0, 32)}`;
  return path.join(dataPath, 'integrations', 'tools.sock');
}
async function inputJson(stream, command) {
  if (stream.isTTY) {
    if (command !== 'list') throw new Error('요청 JSON을 표준 입력으로 전달하십시오.');
    return {};
  }
  let input = '', bytes = 0;
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk); if (bytes > MAX_BYTES) throw new Error('요청 JSON은 512 KiB 이하여야 합니다.'); input += chunk;
  }
  if (!input.trim() && command === 'list') return {};
  let value;
  try { value = JSON.parse(input); } catch { throw new Error('표준 입력이 올바른 JSON이 아닙니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('요청 JSON은 객체여야 합니다.');
  return value;
}
export async function request(action, payload, dataPath, { timeoutMs = 30000 } = {}) {
  dataPath = path.resolve(dataPath);
  if (/\.app(?:[/\\]|$)/i.test(dataPath)) throw new Error('.app은 실행 앱입니다. --data-dir에는 ReviewOps 설정의 데이터 폴더를 지정하십시오.');
  const connectionFile = path.join(dataPath, 'integrations', 'tools.json');
  let connection;
  try {
    const stat = await fs.stat(connectionFile);
    if (stat.size > 8192) throw new Error('invalid');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('permissions');
    connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
  } catch (error) {
    if (error.message === 'permissions') throw new Error('외부 도구 연결 파일의 사용자 또는 접근 권한이 올바르지 않습니다. ReviewOps 앱을 다시 실행하십시오.');
    throw new Error('ReviewOps 외부 도구 연결을 읽을 수 없습니다. 이 기능을 지원하는 ReviewOps 앱을 실행하고 데이터 폴더를 확인하십시오.');
  }
  if (connection.version !== 1 || connection.socketPath !== expectedSocket(dataPath) || !/^[a-f0-9]{64}$/.test(connection.token || '') || !Number.isInteger(connection.pid) || connection.pid <= 0) throw new Error('ReviewOps 연결 정보가 올바르지 않습니다. 앱을 다시 실행하십시오.');
  const bytes = JSON.stringify({ token: connection.token, action, payload }) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('요청 JSON이 연결에서 허용하는 크기를 초과했습니다.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socketPath); let input = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('ReviewOps 응답 시간이 초과되었습니다. 새 요청 ID를 만들기 전에 status로 기존 요청 상태를 조회하십시오.')));
    socket.on('error', () => finish(new Error('ReviewOps 앱에 연결할 수 없습니다. 앱을 실행하고 같은 데이터 폴더를 사용 중인지 확인하십시오.')));
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) return finish(new Error('ReviewOps 응답이 너무 큽니다.'));
      const end = input.indexOf('\n'); if (end < 0) return;
      let response;
      try { response = JSON.parse(input.slice(0, end)); } catch { return finish(new Error('ReviewOps 응답 형식이 올바르지 않습니다.')); }
      if (!response || typeof response.ok !== 'boolean') return finish(new Error('ReviewOps 응답 형식이 올바르지 않습니다.'));
      finish(null, response);
    });
    socket.on('close', () => { if (!settled) finish(new Error('ReviewOps 연결이 응답 전에 종료되었습니다. 같은 요청 ID로 status를 조회하십시오.')); });
  });
}
export async function main(args = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      stdout.write('사용법: node reviewops.mjs list|open|status [--data-dir 데이터폴더]\nopen과 status는 표준 입력으로 JSON을 받습니다. 앱을 먼저 실행하십시오.\n'); return 0;
    }
    let command, selectedPath;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--data-dir') {
        if (selectedPath || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--data-dir 뒤에 데이터 폴더를 지정하십시오.');
        selectedPath = path.resolve(args[++index]);
      } else if (!command && Object.hasOwn(actions, args[index])) command = args[index];
      else throw new Error('list, open, status 중 하나와 선택적인 --data-dir만 지정하십시오.');
    }
    if (!command) throw new Error('list, open, status 중 하나를 지정하십시오.');
    const payload = await inputJson(stdin, command);
    const result = await request(actions[command], payload, selectedPath || defaultDataPath(process.platform, env));
    stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(JSON.stringify({ ok: false, error: { code: 'CLIENT_ERROR', message: error.message } }) + '\n'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
