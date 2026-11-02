// NOT RUN. Hosted-only future compiler step, after root review/integration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawn} from 'node:child_process';
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
assert.ok(args.includes('--run'), 'Preparation only; compilation requires root-reviewed hosted execution');
assert.equal(process.env.CI, 'true'); assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
assert.equal(process.versions.electron, undefined);
const source = option('--source'), sdk = option('--sdk-version'), dotnet = fs.realpathSync(option('--dotnet'));
assert.match(source || '', /^[0-9a-f]{40}$/); assert.match(sdk || '', /^8\.0\.\d+$/);
assert.equal(process.env.GITHUB_SHA, source);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), source);
assert.equal(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim(), '');
assert.equal(path.basename(dotnet).toLowerCase(), 'dotnet.exe');
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = fs.realpathSync(option('--private-root')), node = fs.realpathSync(option('--node'));
const script = fs.realpathSync(option('--agent-script')), expected = JSON.parse(fs.readFileSync(option('--reviewed-draft-manifest'), 'utf8'));
const inside = file => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
assert.match(path.basename(root), /^rv-on-/); assert.ok(inside(script));
assert.equal(node, fs.realpathSync(process.execPath));
assert.equal(hash(node), option('--node-sha256')); assert.equal(hash(script), option('--agent-sha256'));
for (const name of ['native-cli/Program.cs', 'native-cli/OwnedFixture.csproj', 'prepare-windows-native-cli.mjs']) {
  const row = expected.files.find(row => row.path === name); assert.ok(row); assert.equal(hash(path.join(here, name)), row.sha256);
}
const build = path.join(root, 'native-cli-build'), output = path.join(root, 'bin'), journal = path.join(root, 'launcher-journal');
assert.ok(!fs.existsSync(build), 'Never reuse a prior build directory');
for (const dir of [build, output, journal]) fs.mkdirSync(dir, {recursive: true});
const logs = [];
const run = async (values, cwd = build) => {
  logs.push({executable: dotnet, args: values});
  const child = spawn(dotnet, values, {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1',
      DOTNET_CLI_HOME: path.join(root, 'dotnet-home'), NUGET_PACKAGES: path.join(root, 'nuget-cache')}});
  const chunks = []; let bytes = 0, overflow = false, timer;
  const read = chunk => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) chunks.push(chunk); else overflow = true; };
  child.stdout.on('data', read); child.stderr.on('data', read);
  const completed = new Promise(resolve => {
    child.once('error', error => resolve({error: error.message, completed: false}));
    child.once('close', (code, signal) => resolve({code, signal, completed: true}));
  });
  let outcome;
  try { outcome = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve({completed: false, reason: 'compiler-observation-timeout'}), 180000); })]); }
  finally { clearTimeout(timer); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!outcome.completed || outcome.code !== 0 || outcome.signal || overflow) {
    fs.writeFileSync(path.join(root, 'native-cli-compile-failure.log'), text);
    fs.writeFileSync(path.join(root, 'native-cli-compile-incomplete.json'), JSON.stringify({
      executable: dotnet, args: values, retainedCompilerPid: child.pid, outcome, overflow,
      signalSentByPreparer: false, preservePrivateRoot: true, productQaPassed: false}, null, 2));
    if (!outcome.completed) { child.unref(); for (const stream of [child.stdout, child.stderr]) stream?.unref?.(); }
    // Do not signal compiler/app/service/agent PIDs. An incomplete command fails
    // the gate, keeps this root and cannot publish a fixture success manifest.
    throw new Error('Native fixture compiler incomplete or failed; preserve private root');
  }
  return text;
};
const sdks = await run(['--list-sdks']); assert.ok(sdks.split(/\r?\n/).some(line => line.startsWith(sdk + ' [')));
const runtimes = await run(['--list-runtimes']); assert.match(runtimes, /Microsoft\.NETCore\.App 8\.0\./);
fs.writeFileSync(path.join(build, 'global.json'), JSON.stringify({sdk: {version: sdk, rollForward: 'disable', allowPrerelease: false}}));
fs.writeFileSync(path.join(build, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
for (const name of ['Program.cs', 'OwnedFixture.csproj']) fs.copyFileSync(path.join(here, 'native-cli', name), path.join(build, name));
assert.equal((await run(['--version'])).trim(), sdk);
const info = await run(['--info']);
const restore = await run(['restore', 'OwnedFixture.csproj', '--configfile', path.join(build, 'NuGet.Config'), '--runtime', 'win-x64']);
const publish = await run(['publish', 'OwnedFixture.csproj', '--no-restore', '--runtime', 'win-x64', '--self-contained', 'false', '-c', 'Release', '-o', output]);
const executable = path.join(output, 'codex.exe'), pe = fs.readFileSync(executable);
assert.equal(pe.toString('ascii', 0, 2), 'MZ'); const offset = pe.readUInt32LE(0x3c);
assert.equal(pe.toString('binary', offset, offset + 4), 'PE\0\0'); assert.equal(pe.readUInt16LE(offset + 4), 0x8664);
fs.writeFileSync(path.join(output, 'fixture-config.json'), JSON.stringify({privateRoot: root, nodeExecutable: node,
  nodeSHA256: hash(node), agentScript: script, agentSHA256: hash(script), journalDirectory: journal}));
const files = fs.readdirSync(output).sort().map(name => { const file = path.join(output, name), stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink()); return {path: name, bytes: stat.size, sha256: hash(file)}; });
fs.writeFileSync(path.join(root, 'native-cli-compile.log'), sdks + runtimes + info + restore + publish);
const compiler = path.join(path.dirname(dotnet), 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll');
fs.writeFileSync(path.join(root, 'native-cli-build.json'), JSON.stringify({source, target: 'win32-x64', sdk,
  compiler: {path: compiler, sha256: hash(compiler)}, dotnet: {path: dotnet, sha256: hash(dotnet)},
  inputs: {node, nodeSHA256: hash(node), script, agentSHA256: hash(script)},
  output: {executable, peMachine: '0x8664', frameworkDependent: true, requiredRuntime: 'Microsoft.NETCore.App8'},
  commands: logs, files, compiled: true, CLIExecuted: false, productQaPassed: false}, null, 2));
// Compilation is not a version/stdio/cancel-tree or product-UI PASS. Those are
// subsequent required gates, on this exact native output + all dependency hashes.
