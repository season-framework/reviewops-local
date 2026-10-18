import {setTestLocale} from './test-locale.mjs';
import { selectControl, expectSelectValue } from './select-control.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// This suite uses a separate HOME, SSH config, account profiles and database.
// The only SSH destination is localhost port 9; login and credit operations are never invoked.
const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-project-connections-'));
const dataPath = path.join(testRoot, 'data'), homePath = path.join(testRoot, 'home');
const configPath = path.join(homePath, '.ssh', 'config'), localPath = path.join(testRoot, 'project-files');
const secondPath = path.join(testRoot, 'project-files-second'), markerPath = path.join(testRoot, 'synthetic-executions.txt');
for (const directory of [path.dirname(configPath), localPath, secondPath]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, '# Synthetic ReviewOps UI fixture\n', { mode: 0o600 });
fs.writeFileSync(path.join(localPath, '메모.txt'), '프로젝트 연결 검사에 사용하는 합성 자료입니다.\n');
const binaryPath = path.join(testRoot, 'fixture-codex');
fs.writeFileSync(binaryPath, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-project-connections');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(markerPath)},'synthetic-request\\n');
 const send=value=>console.log(JSON.stringify(value));
 send({type:'thread.started',thread_id:'fixture-project-connections-'+process.pid});send({type:'turn.started'});
 send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'프로젝트 연결 변경 전의 합성 응답입니다.'}});
 send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
});
`, { mode: 0o755 });

let app, page, appVersion, resultPath;
const checks = [], rendererErrors = [], externalRequests = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const pane = () => page.locator('.workspace-pane:not([hidden])');
const primary = name => page.locator('.main-nav').getByRole('button', { name, exact: true });
const task = name => page.getByRole('tablist', { name: '작업 탭', exact: true }).getByRole('tab', { name, exact: true });
const ipc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const hostIpc = (method, args = []) => page.evaluate(({ method, args }) => window.hostManager[method](...args), { method, args });
const projectSettings = () => pane().locator('.original-project-settings');
const settingTab = name => projectSettings().getByRole('tablist', { name: '프로젝트 설정 항목', exact: true }).getByRole('tab', { name, exact: true });
const refresh = () => page.locator('.workspace-refresh').click();
async function launch() {
  const env = { ...process.env, HOME: homePath, CODEX_HOME: path.join(homePath, '.codex'), REVIEWOPS_DATA_DIR: dataPath, REVIEWOPS_CODEX_SSH_CONFIG: configPath };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[name];
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page); page.setDefaultTimeout(12000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(request.url())) externalRequests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 1050));
  await page.waitForFunction(() => Boolean(window.reviewops?.invoke && window.accountManager?.getState && window.hostManager?.getState));
  await expect(primary('홈')).toBeVisible();
  appVersion = await app.evaluate(({ app }) => app.getVersion());
  resultPath = path.join(root, 'test-results', `project-connections-v${appVersion}`);
  fs.mkdirSync(resultPath, { recursive: true });
}
async function stop() {
  if (!app) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
  await app.close(); app = null;
}
async function openGroup(group, section = '프로젝트') {
  await primary('그룹').click();
  await pane().getByRole('button', { name: `그룹 열기: ${group.name}`, exact: true }).click();
  await pane().getByRole('navigation', { name: '그룹 기능', exact: true }).getByRole('button', { name: section, exact: true }).click();
}
async function openProject(project) {
  await primary('홈').click(); await refresh();
  await pane().getByRole('button', { name: `${project.name} 프로젝트 열기`, exact: true }).click();
  await expect(task(project.name)).toHaveAttribute('aria-selected', 'true');
}
async function settings(project, tab = '연결') {
  await openProject(project);
  await pane().getByRole('navigation', { name: '프로젝트 기능', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
  await settingTab(tab).click();
}
async function screenshot(name) { await page.screenshot({ path: path.join(resultPath, name), fullPage: false }); }

try {
  await launch();
  assert.equal((await ipc('snapshot')).groups.length, 0);
  assert.deepEqual(await page.locator('.main-nav').getByRole('button').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['홈', '그룹', '계정관리', '호스트관리']);
  for (const name of ['서비스', '프로젝트', '리뷰']) await expect(primary(name)).toHaveCount(0);
  passed('좌측 메뉴에 홈·그룹·계정관리·호스트관리 표시');

  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(pane().getByRole('heading', { name: '자료 저장 위치', exact: true })).toBeVisible();
  assert.equal((await pane().innerText()).includes('서비스'), false);
  await expect(pane().getByRole('button', { name: '백업 파일 저장', exact: true })).toBeVisible();
  passed('데이터 관리에서도 서비스 항목 없이 프로젝트 연결과 백업 안내 표시');

  await primary('계정관리').click();
  await expect(pane().getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
  await expect(pane().getByText('등록된 계정이 없습니다.', { exact: true })).toBeVisible();
  const emptyAccountBounds = await pane().getByText('등록된 계정이 없습니다.', { exact: true }).boundingBox();
  assert.ok(emptyAccountBounds.width > 500 && emptyAccountBounds.height < 120, '계정 빈 목록의 안내 문구를 표 너비에 맞춰 표시해야 합니다.');
  assert.deepEqual((await page.evaluate(() => window.accountManager.getState())).accounts, []);
  await pane().getByRole('button', { name: '계정 추가', exact: true }).click();
  const accountDialog = page.getByRole('dialog', { name: '계정 추가', exact: true });
  await expect(accountDialog.getByLabel('계정 이름', { exact: true })).toBeVisible();
  await expectSelectValue(accountDialog.getByLabel('로그인 방식', { exact: true }), 'chatgpt');
  await accountDialog.getByRole('button', { name: '취소', exact: true }).click();
  await screenshot('account-manager.png');
  passed('계정 목록·계정 추가 화면 제공 및 기존 계정과 분리');

  await primary('호스트관리').click();
  await expect(pane().getByRole('table', { name: '호스트 목록', exact: true })).toBeVisible();
  await expect(pane().getByText('등록된 호스트가 없습니다.', { exact: true })).toBeVisible();
  const initialHosts = await hostIpc('getState');
  assert.equal(initialHosts.configPath, configPath);
  const hostState = await hostIpc('saveHost', [{ alias: 'fixture-server', hostName: '127.0.0.1', user: 'fixture-user', port: '9', identityFile: '', proxyJump: '', groupId: null }, initialHosts.revision]);
  assert.equal(hostState.hosts.length, 1);
  await expect(pane().getByRole('button', { name: 'fixture-server 호스트 정보', exact: true })).toBeVisible();
  await expect(pane().getByRole('button', { name: 'fixture-server 파일 관리', exact: true })).toBeVisible();
  await expect(pane().getByRole('button', { name: 'fixture-server SSH 접속', exact: true })).toBeVisible();
  await expect(pane().getByRole('button', { name: '계정 전환', exact: true })).toBeVisible();
  await pane().getByRole('button', { name: '호스트 추가', exact: true }).click();
  const hostDialog = page.getByRole('dialog', { name: '호스트 추가', exact: true });
  await hostDialog.getByLabel('SSH 이름', { exact: true }).fill('fixture-second');
  await hostDialog.getByLabel('호스트 주소', { exact: true }).fill('127.0.0.1');
  await hostDialog.getByLabel('접속 사용자', { exact: true }).fill('fixture-user');
  await hostDialog.getByLabel('SSH 포트', { exact: true }).fill('9');
  await hostDialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(hostDialog).toHaveCount(0);
  await pane().getByRole('button', { name: '새로고침', exact: true }).click();
  await expect.poll(async () => (await hostIpc('getState')).refresh.running, { timeout: 15000 }).toBe(false);
  const reloaded = await hostIpc('reloadHosts');
  assert.deepEqual(reloaded.hosts.map(item => item.alias), ['fixture-server', 'fixture-second']);
  await screenshot('host-manager.png');
  passed('격리된 SSH 설정 파일의 호스트 등록·수정·불러오기와 호스트 작업 메뉴 제공');

  const group = await ipc('group.save', { name: '프로젝트 연결 UI 검사' });
  await refresh(); await openGroup(group);
  const groupNav = pane().getByRole('navigation', { name: '그룹 기능', exact: true });
  await expect(groupNav.getByRole('button', { name: '서비스', exact: true })).toHaveCount(0);
  await expect(pane().getByRole('button', { name: '서비스 등록', exact: true })).toHaveCount(0);
  await screenshot('group-projects.png');
  passed('그룹 화면에서 서비스 탭과 서비스 등록 제거');

  await pane().getByRole('button', { name: '프로젝트 등록', exact: true }).click();
  const registration = page.getByRole('region', { name: '프로젝트 등록', exact: true });
  await registration.getByLabel('프로젝트명', { exact: true }).fill('로컬 폴더 프로젝트');
  await expectSelectValue(registration.getByLabel('접속 방식', { exact: true }), 'local');
  await app.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, localPath);
  await registration.getByRole('button', { name: '선택', exact: true }).click();
  await expect(registration.getByLabel('로컬 폴더', { exact: true })).toHaveValue(localPath);
  await registration.getByRole('button', { name: '프로젝트 등록', exact: true }).click();
  await expect(registration).toHaveCount(0);
  const localProject = (await ipc('snapshot')).projects.find(item => item.name === '로컬 폴더 프로젝트');
  assert.equal(localProject.connection.kind, 'local'); assert.equal(localProject.connection.rootPath, localPath);
  assert.equal(localProject.connection.managedProjectId, localProject.id);
  passed('프로젝트 등록에서 로컬 폴더를 직접 선택하고 프로젝트 연결로 저장');

  await settings(localProject);
  assert.deepEqual(await projectSettings().getByRole('tablist', { name: '프로젝트 설정 항목', exact: true }).getByRole('tab').allTextContents(), ['프로젝트 정보', '연결', '뷰어', '에이전트', '기타']);
  await expect(projectSettings().getByLabel('설정할 서비스', { exact: true })).toHaveCount(0);
  await expect(projectSettings().getByLabel('연결할 서비스', { exact: true })).toHaveCount(0);
  await projectSettings().getByLabel('로컬 폴더', { exact: true }).fill(secondPath);
  await settingTab('뷰어').click();
  await projectSettings().getByLabel('화면 너비', { exact: true }).fill('1280');
  await projectSettings().getByLabel('화면 높이', { exact: true }).fill('800');
  await selectControl(projectSettings().getByLabel('기본 배율', { exact: true }), '75');
  await projectSettings().getByRole('button', { name: '저장하기', exact: true }).click();
  await expect.poll(async () => (await ipc('snapshot')).projects.find(item => item.id === localProject.id).connection.rootPath).toBe(secondPath);
  const configuredLocal = (await ipc('snapshot')).projects.find(item => item.id === localProject.id).connection;
  assert.equal(configuredLocal.viewerWidth, 1280); assert.equal(configuredLocal.viewerHeight, 800); assert.equal(configuredLocal.viewerScale, '75');
  await settingTab('에이전트').click();
  await expect(projectSettings().getByLabel('에이전트 사용', { exact: true })).toBeVisible();
  await settingTab('연결').click(); await screenshot('project-local-connection.png');
  passed('프로젝트 설정에 연결·뷰어·에이전트를 통합하고 설정 변경 저장');

  await openGroup(group);
  await pane().getByRole('button', { name: '프로젝트 등록', exact: true }).click();
  await registration.getByLabel('프로젝트명', { exact: true }).fill('SSH 호스트 프로젝트');
  await selectControl(registration.getByLabel('접속 방식', { exact: true }), 'ssh');
  await selectControl(registration.getByLabel('SSH 호스트', { exact: true }), 'fixture-server');
  await registration.getByLabel('서버 작업 폴더', { exact: true }).fill('/opt/synthetic-project');
  await expect(registration.getByLabel('호스트', { exact: true })).toHaveCount(0);
  await expect(registration.getByLabel('사용자 이름', { exact: true })).toHaveCount(0);
  await registration.getByRole('button', { name: '프로젝트 등록', exact: true }).click();
  await expect(registration).toHaveCount(0);
  const sshProject = (await ipc('snapshot')).projects.find(item => item.name === 'SSH 호스트 프로젝트');
  assert.equal(sshProject.connection.kind, 'ssh'); assert.equal(sshProject.connection.hostAlias, 'fixture-server');
  assert.equal(sshProject.connection.host, '127.0.0.1'); assert.equal(sshProject.connection.port, 9);
  assert.equal(sshProject.connection.username, 'fixture-user'); assert.equal(sshProject.connection.sshConfigPath, configPath);
  await settings(sshProject);
  await expectSelectValue(projectSettings().getByLabel('SSH 호스트', { exact: true }), 'fixture-server');
  await selectControl(projectSettings().getByLabel('SSH 호스트', { exact: true }), 'fixture-second');
  await projectSettings().getByLabel('서버 작업 폴더', { exact: true }).fill('/opt/synthetic-second');
  await projectSettings().getByRole('button', { name: '저장하기', exact: true }).click();
  await expect.poll(async () => (await ipc('snapshot')).projects.find(item => item.id === sshProject.id).connection.hostAlias).toBe('fixture-second');
  await screenshot('project-ssh-connection.png');
  passed('등록된 SSH Host 선택으로 프로젝트 생성·연결 변경 및 접속 설정 자동 반영');

  const legacy = await ipc('service.save', { groupId: group.id, name: '합성 기존 공유 설정', kind: 'local', rootPath: localPath, agentEnabled: 1, agentBinary: binaryPath });
  const legacyFirst = await ipc('project.save', { groupId: group.id, name: '기존 공유 프로젝트 1', serviceIds: [legacy.id] });
  const legacySecond = await ipc('project.save', { groupId: group.id, name: '기존 공유 프로젝트 2', serviceIds: [legacy.id] });
  const attachment = path.join(localPath, '메모.txt'), staged = await ipc('attachment.stageFiles', { paths: [attachment] });
  const review = await ipc('review.save', { projectId: legacyFirst.id, serviceId: legacy.id, title: '연결 변경 전에 작성한 리뷰', attachmentTokens: staged.map(item => item.token) });
  const activity = await ipc('activity.add', { reviewId: review.id, body: '연결 변경 후에도 보존할 작업이력입니다.' });
  const execution = await ipc('agent.start', { reviewId: review.id, prompt: '합성 실행 응답을 남기십시오.', requestId: crypto.randomUUID() });
  await expect.poll(async () => (await ipc('agent.list', { reviewId: review.id })).find(item => item.id === execution.id)?.status, { timeout: 15000 }).toBe('completed');
  const beforeChange = await ipc('snapshot'), oldRun = (await ipc('agent.list', { reviewId: review.id })).find(item => item.id === execution.id);
  await refresh(); await settings(legacyFirst);
  await projectSettings().getByLabel('로컬 폴더', { exact: true }).fill(secondPath);
  await projectSettings().getByRole('button', { name: '저장하기', exact: true }).click();
  await expect.poll(async () => (await ipc('snapshot')).projects.find(item => item.id === legacyFirst.id).connection.rootPath).toBe(secondPath);
  const afterChange = await ipc('snapshot'), changedFirst = afterChange.projects.find(item => item.id === legacyFirst.id);
  assert.notEqual(changedFirst.connection.id, legacy.id);
  assert.deepEqual(afterChange.services.find(item => item.id === legacy.id), beforeChange.services.find(item => item.id === legacy.id));
  assert.deepEqual(afterChange.projects.find(item => item.id === legacySecond.id), beforeChange.projects.find(item => item.id === legacySecond.id));
  assert.equal(afterChange.reviews.find(item => item.id === review.id).serviceId, changedFirst.connection.id);
  assert.deepEqual(afterChange.activities.find(item => item.id === activity.id), beforeChange.activities.find(item => item.id === activity.id));
  assert.deepEqual(afterChange.attachments.filter(item => item.reviewId === review.id), beforeChange.attachments.filter(item => item.reviewId === review.id));
  assert.deepEqual((await ipc('agent.list', { reviewId: review.id })).find(item => item.id === execution.id), oldRun);
  assert.match((await ipc('attachment.read', { id: afterChange.attachments.find(item => item.reviewId === review.id).id })).content, /합성 자료/);
  passed('기존 공유 설정은 프로젝트별로 분리하고 다른 프로젝트·리뷰·첨부·이전 실행 설정 보존');

  await settingTab('기타').click(); await projectSettings().getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '프로젝트 삭제', exact: true });
  await expect(deletion.getByLabel('삭제 확인', { exact: true })).toHaveValue('');
  await expect(deletion.getByRole('button', { name: '삭제', exact: true })).toBeDisabled();
  await deletion.getByLabel('삭제 확인', { exact: true }).fill('잘못된 이름');
  await expect(deletion.getByRole('button', { name: '삭제', exact: true })).toBeDisabled();
  await deletion.getByLabel('삭제 확인', { exact: true }).fill(legacyFirst.name);
  await expect(deletion.getByRole('button', { name: '삭제', exact: true })).toBeEnabled();
  await deletion.getByRole('button', { name: '취소', exact: true }).click();
  assert.ok((await ipc('snapshot')).reviews.some(item => item.id === review.id));
  passed('프로젝트 삭제 시 이름 입력 확인 유지 및 취소 시 자료 보존');

  const persisted = await ipc('snapshot');
  await stop(); await launch();
  const reopened = await ipc('snapshot');
  for (const projectId of [localProject.id, sshProject.id, legacyFirst.id, legacySecond.id]) assert.deepEqual(reopened.projects.find(item => item.id === projectId), persisted.projects.find(item => item.id === projectId));
  assert.equal((await hostIpc('getState')).configPath, configPath);
  assert.deepEqual((await hostIpc('getState')).hosts.map(item => item.alias), ['fixture-server', 'fixture-second']);
  assert.deepEqual((await page.evaluate(() => window.accountManager.getState())).accounts, []);
  assert.equal(fs.readFileSync(markerPath, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
  passed('재시작 후 프로젝트 연결·SSH 목록 유지, 실제 계정 작업·외부 HTTP 요청·화면 오류 없음');
  const report = { ok: true, version: appVersion, checks, rendererErrors, externalRequests, syntheticCliRequests: 1, accountLogins: 0, creditOperations: 0, sshDestinations: ['127.0.0.1:9'], testRoot, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development' };
  const reportName = process.env.REVIEWOPS_TEST_EXECUTABLE ? 'dmg.json' : 'source.json';
  fs.writeFileSync(path.join(resultPath, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
  if (resultPath) fs.writeFileSync(path.join(resultPath, process.env.REVIEWOPS_TEST_EXECUTABLE ? 'dmg.json' : 'source.json'), JSON.stringify({ ok: false, version: appVersion, checks, error: error.message, testRoot }, null, 2));
  console.error('PROJECT CONNECTIONS FAILURE', testRoot, error); process.exitCode = 1;
} finally { await stop().catch(() => {}); }
