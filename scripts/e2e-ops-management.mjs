import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

if (!process.argv.includes('--real-codex')) throw new Error('Use --real-codex for this authenticated, isolated feature QA.');
const require = createRequire(import.meta.url), {OpsManager} = require('../electron/ops-manager.cjs'), {createOpsSession} = require('../electron/ops-session.cjs'), {createProjectAdapter} = require('../electron/ops-management.cjs'), {createStore} = require('../electron/store.cjs'), {RpcClient} = require('../electron/codex/rpc-client.cjs');
const binary = fs.realpathSync(process.env.REVIEWOPS_E2E_CODEX_BINARY || execFileSync('/usr/bin/which', ['codex'], {encoding: 'utf8'}).trim());
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-management-real-')), workPath = path.join(root, 'project'), dataPath = path.join(root, 'data'); fs.mkdirSync(workPath);
const output = process.env.REVIEWOPS_QA_OUTPUT || path.join(process.cwd(), 'test-results', 'ops-management-real', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(output, {recursive: true});
const nonce = randomUUID().slice(0, 8), store = createStore({dbPath: path.join(root, 'projects.sqlite')}), traffic = [], toolCalls = [], clients = [], checks = []; let manager, recovered, failure, conversationId, managementThread, goalId, goalThread;
const factory = options => createOpsSession({...options, rpcFactory: config => {
  const rpc = new RpcClient(config), request = rpc.request.bind(rpc); clients.push(rpc);
  rpc.request = async (method, params) => { traffic.push({ownerId: options.goalId, method, threadId: params?.threadId, sandbox: params?.sandbox, approvalPolicy: params?.approvalPolicy, deliveryId: params?.clientUserMessageId}); return request(method, params); }; return rpc;
}, tools: options.tools.map(tool => ({...tool, execute: async (args, context) => { const result = await tool.execute(args, context); toolCalls.push({name: tool.name, args, context, result}); return result; }}))});
const options = {dataPath, runtime: {command: binary, available: true}, createSession: factory, managementAdapter: createProjectAdapter({getStore: () => store}), schedulerOptions: {setTimer: () => 1, clearTimer: () => {}}, resolveTarget: async input => { const project = input.projectId ? store.project(input.projectId) : null; return {projectId: project?.id || '', serviceId: project?.connection?.id || null, workPath: fs.realpathSync(project ? project.connection.rootPath : input.workPath), targetKind: 'local', targetIdentity: 'local'}; }};
const wait = async (predicate, label, timeout = 180000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + label); };
const conversation = owner => owner.snapshot().managementConversations.find(row => row.id === conversationId);
try {
  manager = new OpsManager(options); conversationId = (await manager.managementCreate({name: 'Genuine management QA ' + nonce})).managementConversations[0].id;
  await manager.managementRequest({conversationId, instruction: `This is an isolated feature acceptance. Use only the ops_projects/goals/schedules management tools. Do not use shell, file, network, search, subagent or other tools. List projects and goals. Create one local project named "QA project ${nonce}" with groupName "Management QA" and actual workPath ${JSON.stringify(workPath)}. Create one goal "QA goal ${nonce}" for that returned project ID, prompt exactly "Reply only OWNED_GOAL_${nonce}. Do not use tools, files, network, schedules or subagents." Use empty model and reasoningEffort defaults. Add exactly one disabled schedule named "QA schedule ${nonce}", prompt "Do not execute this disabled QA schedule.", cron "0 0 1 1 *", timezone "UTC", enabled false. Edit that same schedule to cron "30 0 1 1 *", retaining its other fields. Delete that exact schedule. Explicitly start that goal once through ops_goals_action; do not finish it or create more goals. Finish with MANAGEMENT_ONE_${nonce} and the actual returned project and goal IDs. Do not claim success if any tool failed.`});
  await manager.management.pump(conversationId);
  await wait(() => conversation(manager).executionState === 'idle' && conversation(manager).conversation.some(row => row.role === 'assistant' && row.text.includes('MANAGEMENT_ONE_' + nonce)), 'first genuine management completion');
  let data = manager.exportData(), first = conversation(manager); managementThread = first.threadId;
  assert.equal(store.snapshot().projects.length, 1); assert.equal(data.goals.length, 1); goalId = data.goals[0].id;
  await wait(() => manager.snapshot().goals[0].executionState === 'idle' && manager.snapshot().goals[0].conversation.some(row => row.role === 'assistant' && row.text.includes('OWNED_GOAL_' + nonce)), 'actual goal model completion');
  goalThread = manager.snapshot().goals[0].threadId; assert.notEqual(goalThread, managementThread);
  assert.equal(manager.snapshot().goals[0].schedules.length, 0);
  for (const name of ['ops_projects_list', 'ops_projects_create', 'ops_goals_list', 'ops_goals_save', 'ops_schedules_save', 'ops_schedules_delete', 'ops_goals_action']) assert.ok(toolCalls.some(row => row.name === name && row.result.ok), name);
  assert.ok(first.conversation.some(row => row.links?.some(link => link.kind === 'project'))); assert.ok(first.conversation.some(row => row.links?.some(link => link.kind === 'goal' && link.id === goalId)));
  checks.push('An actual management Codex turn called typed tools to create a real project and goal, add/edit/delete one disabled schedule, and start that goal; the independent real goal thread returned its exact requested nonce.');
  const before = manager.exportData(); fs.writeFileSync(path.join(output, 'before-restart.json'), JSON.stringify(before, null, 2));
  await manager.close(); manager = null;
  const starts = traffic.filter(row => row.method === 'turn/start').length;
  recovered = new OpsManager(options); await recovered.init(); await recovered.management.reconnect(conversationId); await recovered.reconnect(goalId);
  assert.equal(traffic.filter(row => row.method === 'turn/start').length, starts); assert.equal(conversation(recovered).threadId, managementThread); assert.equal(recovered.snapshot().goals[0].threadId, goalThread);
  checks.push('A fresh manager and app-server connection reconciled the original management and goal threads without another model input or replaying a completed tool mutation.');
  await recovered.managementRequest({conversationId, instruction: `Continue this same isolated management QA using only ops_goals_list, ops_goals_save and ops_goals_action. Do not create any project, goal or schedule. List goals, update only goal ${goalId} prompt to exactly "Reply only UPDATED_GOAL_${nonce}. Do not use tools." while preserving its project, original conversation and other settings; then finish that goal through ops_goals_action. Report MANAGEMENT_TWO_${nonce} only after actual successful tool results. Do not use any shell, file, network, subagent or other tools.`});
  await recovered.management.pump(conversationId);
  await wait(() => conversation(recovered).executionState === 'idle' && conversation(recovered).conversation.some(row => row.role === 'assistant' && row.text.includes('MANAGEMENT_TWO_' + nonce)), 'resumed genuine management update');
  const final = recovered.exportData(); assert.equal(final.goals.length, 1); assert.equal(final.goals[0].status, 'finished'); assert.equal(final.goals[0].threadId, goalThread); assert.equal(final.goals[0].prompt, `Reply only UPDATED_GOAL_${nonce}. Do not use tools.`); assert.equal(conversation(recovered).threadId, managementThread);
  assert.deepEqual(store.snapshot().projects.map(row => row.id), before.goals.map(row => row.projectId));
  assert.ok(final.goals[0].history.length > before.goals[0].history.length); assert.ok(final.managementConversations[0].toolReceipts.length > before.managementConversations[0].toolReceipts.length);
  for (const row of traffic.filter(row => ['thread/start', 'thread/resume'].includes(row.method))) { assert.equal(row.sandbox, 'danger-full-access'); assert.equal(row.approvalPolicy, 'never'); }
  fs.writeFileSync(path.join(output, 'after-restart.json'), JSON.stringify(final, null, 2));
  checks.push('A second genuine turn resumed the same management conversation, updated the actual existing goal and finished it while retaining the original project, thread and history; new/resumed app-server threads used danger-full-access and never.');
} catch (error) { failure = {code: error.code || 'OPS_MANAGEMENT_REAL_QA_FAILED', message: error.message, stack: error.stack}; process.exitCode = 1; }
finally {
  for (const owner of [manager, recovered].filter(Boolean)) {
    if (conversationId) try { await owner.managementAction({conversationId, action: 'stop'}); } catch {}
    if (goalId) try { await owner.goalAction({goalId, action: 'pause'}); } catch {}
  }
  for (const client of clients.filter(item => !item.closed)) for (const threadId of [managementThread, goalThread].filter(Boolean)) try { await client.request('thread/archive', {threadId}); } catch {}
  await manager?.close(); await recovered?.close(); store.close();
  const result = {ok: !failure && checks.length === 3, checks, failure, managementThread, goalThread, conversationId, goalId, actualModelTurns: traffic.filter(row => row.method === 'turn/start').length, completedToolCalls: toolCalls.filter(row => row.result.ok).length, scope: 'Actual installed authenticated Codex CLI through source OpsManager/createOpsSession and typed tools backed by the real LocalStore. Isolated temporary app data and project directory; no installed Electron UI, physical remote host, or comprehensive release QA is claimed.', output};
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(output, 'traffic.json'), JSON.stringify(traffic, null, 2)); fs.writeFileSync(path.join(output, 'tool-calls.json'), JSON.stringify(toolCalls, null, 2)); fs.rmSync(root, {recursive: true, force: true}); console.log(JSON.stringify(result));
}
