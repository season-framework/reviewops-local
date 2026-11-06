import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Validate the actual archive, including dependencies that main can otherwise
// catch as an unavailable Ops manager while the rest of the app still opens.
export function inspectOpsArchive(archive, {repository, asar}) {
  const names = fs.readdirSync(path.join(repository, 'electron')).filter(name => /^ops-.*\.cjs$/.test(name)).sort();
  assert.ok(names.includes('ops-manager.cjs'), 'The reviewed Ops manager is missing.');
  for (const name of names) assert.deepEqual(asar.extractFile(archive, path.join('electron', name)), fs.readFileSync(path.join(repository, 'electron', name)), `Packaged Ops source differs: ${name}`);
  const lock = JSON.parse(fs.readFileSync(path.join(repository, 'package-lock.json'), 'utf8'));
  const dependencies = {};
  for (const name of ['cron-parser', 'luxon']) {
    const relative = path.join('node_modules', name);
    const metadata = JSON.parse(asar.extractFile(archive, path.join(relative, 'package.json')).toString('utf8'));
    assert.equal(metadata.version, lock.packages[`node_modules/${name}`]?.version, `Packaged dependency version differs: ${name}`);
    assert.equal(typeof metadata.main, 'string', `Packaged dependency entry is missing: ${name}`);
    const entry = path.normalize(path.join(relative, metadata.main));
    assert.ok(entry.startsWith(relative + path.sep), `Invalid dependency entry: ${name}`);
    assert.ok(asar.extractFile(archive, entry).length > 0, `Packaged dependency cannot be loaded: ${name}`);
    dependencies[name] = metadata.version;
  }
  return {sourceModules: names, dependencies};
}

const invoke = (page, method, input) => page.evaluate(({method, input}) => {
  if (!window.opsManager || typeof window.opsManager[method] !== 'function') throw new Error('The installed Ops API is unavailable.');
  return window.opsManager[method](input);
}, {method, input});

export async function seedOpsSmoke(page, {workPath, projectId = ''}) {
  const before = await invoke(page, 'snapshot');
  assert.ok(Array.isArray(before.goals));
  const commonPrompt = 'NATIVE_OPS_PRESERVATION: retain the original goal settings without running a model.';
  await invoke(page, 'configure', {commonPrompt});
  const create = async name => {
    const snapshot = await invoke(page, 'saveGoal', {name, description: 'Isolated native package preservation check.', projectId, workPath, prompt: `Retain ${name}; do not start automatically.`, model: '', reasoningEffort: '', sandboxMode: 'workspace-write', approvalPolicy: 'never'});
    const goal = snapshot.goals.find(row => row.name === name);
    assert.ok(goal);assert.equal(goal.threadId, null);
    return goal;
  };
  const paused = await create('Native Ops paused goal');
  await invoke(page, 'goalAction', {goalId: paused.id, action: 'pause'});
  const scheduled = await invoke(page, 'saveSchedule', {goalId: paused.id, name: 'Native timezone preservation', prompt: 'Retain this schedule while its goal is paused.', cron: '15 3 * * *', timezone: 'Asia/Seoul', enabled: true});
  const schedule = scheduled.goals.find(row => row.id === paused.id).schedules[0];
  assert.ok(Number.isFinite(Date.parse(schedule.nextRunAt)), 'The bundled cron/timezone dependency did not compute a due time.');
  const finished = await create('Native Ops finished goal');
  await invoke(page, 'goalAction', {goalId: finished.id, action: 'finish'});
  const unavailable = await create('Native Ops unavailable saved thread');
  await invoke(page, 'goalAction', {goalId: unavailable.id, action: 'pause'});
  const fixture = {commonPrompt, pausedGoalId: paused.id, finishedGoalId: finished.id, offlineGoalId: unavailable.id, scheduleId: schedule.id, workPath};
  await verifyOpsSmoke(page, fixture);
  const selected = page.getByRole('tablist', {name: '작업 탭', exact: true}).getByRole('tab', {selected: true});
  const previousTab = await selected.getAttribute('aria-label') || (await selected.innerText()).trim();
  await page.locator('.main-nav').getByRole('button', {name: 'Ops', exact: true}).click();
  await page.getByRole('heading', {name: 'Ops', exact: true}).waitFor();
  await page.getByRole('tablist', {name: '작업 탭', exact: true}).getByRole('tab', {name: previousTab, exact: true}).click();
  return fixture;
}

export function verifyOpsData(data, fixture) {
  assert.equal(data.version, 1);
  assert.equal(data.commonPrompt, fixture.commonPrompt);
  const paused = data.goals.find(row => row.id === fixture.pausedGoalId);
  const finished = data.goals.find(row => row.id === fixture.finishedGoalId);
  assert.ok(paused && finished, 'Native Ops goals were not preserved.');
  assert.equal(paused.name, 'Native Ops paused goal');
  assert.equal(paused.status, 'paused');assert.equal(finished.status, 'finished');
  for (const goal of [paused, finished]) {
    assert.equal(goal.threadId, null, 'This preservation scenario must not create a model conversation.');
    assert.equal(goal.turnId, null);
    assert.equal(goal.history.some(row => row.type === 'delivery'), false, 'A paused/finished fixture started work.');
    assert.equal(goal.model, '');assert.equal(goal.reasoningEffort, '');
    assert.equal(goal.sandboxMode, 'workspace-write');assert.equal(goal.approvalPolicy, 'never');
  }
  const schedule = paused.schedules.find(row => row.id === fixture.scheduleId);
  assert.ok(schedule);assert.equal(schedule.cron, '15 3 * * *');assert.equal(schedule.timezone, 'Asia/Seoul');assert.equal(schedule.enabled, true);
  assert.ok(Number.isFinite(Date.parse(schedule.nextRunAt)));
  const unavailable=data.goals.find(row=>row.id===fixture.offlineGoalId);
  assert.ok(unavailable);assert.equal(unavailable.status,'paused');
  assert.equal(unavailable.history.some(row=>row.type==='delivery'),false);
  if(fixture.syntheticSavedThread){
    assert.equal(unavailable.threadId,fixture.syntheticSavedThread);
    assert.equal(unavailable.executionState,'unknown');
    assert.equal(unavailable.backgroundState,'unknown');
  }else assert.equal(unavailable.threadId,null);
  return {passed: true, pausedGoalId: paused.id, finishedGoalId: finished.id, scheduleId: schedule.id, actualModelCalls: 0, originalThreadRetentionTested: false, unavailableSavedThreadFixture:Boolean(fixture.syntheticSavedThread)};
}

export async function verifyOpsSmoke(page, fixture) {
  return verifyOpsData(await invoke(page, 'snapshot'), fixture);
}

export function verifyOpsFile(dataPath, fixture) {
  return verifyOpsData(JSON.parse(fs.readFileSync(path.join(dataPath, 'ops', 'state.json'), 'utf8')), fixture);
}

export async function mutateOpsSmoke(page, fixture) {
  await invoke(page, 'configure', {commonPrompt: 'NATIVE_OPS_AFTER_BACKUP'});
  await invoke(page, 'saveGoal', {id: fixture.pausedGoalId, name: 'Changed after native backup'});
}

// Call only after this owned test app has exited. This is an explicitly
// synthetic unavailable-thread fixture, not evidence of a real Codex resume.
export function seedUnavailableOpsThread(dataPath, fixture) {
  const file=path.join(dataPath,'ops','state.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));
  const goal=data.goals.find(row=>row.id===fixture.offlineGoalId);
  assert.ok(goal&&goal.status==='paused'&&goal.threadId===null);
  fixture.syntheticSavedThread='native-unavailable-thread';
  Object.assign(goal,{threadId:fixture.syntheticSavedThread,turnId:null,modelState:'unknown',executionState:'unknown',backgroundState:'unknown',backgroundCount:null});
  fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
  verifyOpsFile(dataPath,fixture);
}
