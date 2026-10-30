import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { validateBuildInfo } = require('../electron/build-info.cjs');
export const BUILD_INFO_FILE = fileURLToPath(new URL('../electron/reviewops-build.json', import.meta.url));

export async function clearBuildInfo(output = BUILD_INFO_FILE) {
  await fs.rm(output, { force: true });
}
export async function writeBuildInfo({ channel, number, commit, builtAt, output = BUILD_INFO_FILE, version }) {
  if (channel !== 'test') throw new Error('테스트 빌드만 생성할 수 있습니다.');
  version ||= JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const info = validateBuildInfo({ channel, version, buildNumber: Number(number), commit, builtAt });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify(info, null, 2) + '\n');
  return info;
}
export async function withBuildInfo(options, operation) {
  // Always remove test identity, including after a failed build or validation.
  await clearBuildInfo(options.output);
  try { return await operation(await writeBuildInfo(options)); }
  finally { await clearBuildInfo(options.output); }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--clear') { await clearBuildInfo(); return; }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--channel': 'channel', '--number': 'number', '--commit': 'commit', '--built-at': 'builtAt', '--output': 'output', '--version': 'version' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('빌드 정보 명령의 옵션을 확인하십시오.');
    options[key] = args[i + 1];
  }
  return writeBuildInfo(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(info => { if (info) console.log(JSON.stringify(info)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
