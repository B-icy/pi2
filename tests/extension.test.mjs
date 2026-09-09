import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const candidates = [process.env.PI2_CLI, process.env.PI_CLI, ...[dirname(process.execPath), dirname(realpathSync(process.execPath))].map(p => join(p, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'))].filter(Boolean);
const cli = candidates.find(existsSync);
let factory;
if (cli) {
  const requirePi = createRequire(cli);
  const { createJiti } = requirePi('jiti');
  const jiti = createJiti(import.meta.url, { alias: { typebox: requirePi.resolve('typebox'), '@earendil-works/pi-coding-agent': join(dirname(cli), 'index.js') } });
  factory = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), '../extensions/delivery.ts'), { default: true });
}
const options = { skip: !cli && 'Pi not found: set PI2_CLI or PI_CLI to run extension integration tests' };
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi extension integration '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'app.py'), 'print(1)');
  const hooks = {}, tools = {}, entries = [], messages = [], flags = { 'delivery-strict': true };
  const pi = {
    registerFlag() {}, getFlag: name => flags[name],
    on(name, fn) { hooks[name] = fn; },
    registerTool(tool) { tools[tool.name] = tool; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendMessage(message) { messages.push(message); },
  };
  factory(pi);
  const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => entries, getSessionId: () => 'integration-session' }, hasPendingMessages: () => false };
  const call = (name, params = {}) => tools[name].execute('test-id', params, undefined, undefined, ctx);
  const plan = { goal: 'Working script', assumptions: [], artifacts: ['app.py'], steps: ['Implement', 'Verify'], acceptance: [{ requirement: 'Runs', checks: ['run'] }], checks: [{ id: 'run', kind: 'runtime', argv: [process.execPath, '-e', 'console.log("passed")'], timeoutSeconds: 5 }] };
  return { cwd, ctx, hooks, entries, messages, flags, call, plan };
}

test('real extension loads, gates writes, executes checks and rejects stale evidence', options, async t => {
  const f = fixture(t);
  assert.equal(f.hooks.tool_call({ toolName: 'write' }).block, true);
  await f.call('delivery_plan', f.plan);
  assert.equal(f.hooks.tool_call({ toolName: 'write' }), undefined);
  const finish = { status: 'verified', review: 'Reviewed executable behavior.', launch: 'python app.py', limitations: [] };
  await assert.rejects(f.call('delivery_finish', finish), /Cannot verify/);
  await f.call('delivery_check', { id: 'all' });
  await f.call('delivery_finish', finish);
  assert.equal(f.entries.at(-1).data.status, 'verified');
  // Undeclared file changes must invalidate evidence, not only artifact roots.
  writeFileSync(join(f.cwd, 'new_config.json'), '{}');
  await assert.rejects(f.call('delivery_finish', finish), /stale checks/);
});
test('real extension serializes sibling checks without tool errors', options, async t => {
  const f = fixture(t);
  f.plan.checks.push({ ...f.plan.checks[0], id: 'second' });
  await f.call('delivery_plan', f.plan);
  await Promise.all([f.call('delivery_check', { id: 'run' }), f.call('delivery_check', { id: 'second' })]);
  assert.ok(f.entries.at(-1).data.evidence.run.passed);
  assert.ok(f.entries.at(-1).data.evidence.second.passed);
});
test('compaction context survives restore, branching clears stale contracts', options, async t => {
  const f = fixture(t);
  await f.call('delivery_plan', f.plan);
  f.hooks.session_start({}, f.ctx);
  const context = f.hooks.context({ messages: [] });
  assert.match(context.messages[0].content, /Working script/);
  f.entries.length = 0;
  f.hooks.session_tree({}, f.ctx);
  assert.match((await f.call('delivery_status')).content[0].text, /No delivery contract/);
});
test('agent_end queues at most two repairs and does not revive cancelled work', options, async t => {
  const f = fixture(t);
  await f.call('delivery_plan', f.plan);
  const event = reason => ({ messages: [{ role: 'assistant', stopReason: reason }] });
  f.hooks.agent_end(event('aborted'), f.ctx);
  assert.equal(f.messages.length, 0);
  f.hooks.agent_end(event('stop'), f.ctx);
  f.hooks.agent_end(event('stop'), f.ctx);
  f.hooks.agent_end(event('stop'), f.ctx);
  assert.equal(f.messages.length, 2);
  await f.call('delivery_finish', { status: 'blocked', review: 'Environment unavailable', launch: 'python app.py', limitations: ['No renderer available'] });
  f.hooks.input({ source: 'interactive' });
  f.hooks.agent_end(event('stop'), f.ctx);
  assert.equal(f.messages.length, 2);
});
test('repair nudges quote the failing check, its exit code and its output tail', options, async t => {
  const f = fixture(t);
  f.plan.checks[0].argv = [process.execPath, '-e', 'console.log("probe detail: only 2 sampled colors"); process.exit(9)'];
  await f.call('delivery_plan', f.plan);
  await assert.rejects(f.call('delivery_check', { id: 'run' }), /"code": 9/);
  // The failing check's evidence carries a persisted output tail for status/compaction.
  const state = f.entries.at(-1).data;
  assert.equal(state.evidence.run.passed, false);
  assert.match(state.evidence.run.outputTail, /probe detail: only 2 sampled colors/);
  f.hooks.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  assert.equal(f.messages.length, 1);
  const content = f.messages[0].content;
  assert.match(content, /check run failed \(exit 9, timedOut false\)/);
  assert.match(content, /probe detail: only 2 sampled colors/);
  assert.match(content, /pending checks: run/);
  // Compaction context keeps only a short tail, not the full 1200-character evidence copy.
  const context = f.hooks.context({ messages: [] });
  assert.match(context.messages[0].content, /"passed":false/);
  assert.ok(context.messages[0].content.length < 4000);
});
test('bash timeout cap bounds runaway shell commands when configured', options, t => {
  const f = fixture(t);
  // Disabled by default: un-timed commands stay un-timed.
  const runaway = { toolName: 'bash', input: { command: 'find / -name verify_ursina.py' } };
  f.hooks.tool_call(runaway);
  assert.equal(runaway.input.timeout, undefined);
  // Enabled: caps missing and oversized timeouts, preserves tighter explicit ones.
  f.flags['delivery-bash-cap'] = 120;
  f.hooks.tool_call(runaway);
  assert.equal(runaway.input.timeout, 120);
  const tight = { toolName: 'bash', input: { command: 'ls', timeout: 10 } };
  f.hooks.tool_call(tight);
  assert.equal(tight.input.timeout, 10);
  const over = { toolName: 'powershell', input: { command: 'x', timeout: 9999 } };
  f.hooks.tool_call(over);
  assert.equal(over.input.timeout, 120);
  for (const command of [
    'pkill -f python',
    'killall node',
    'kill -9 -1',
    'kill 0',
    'taskkill /IM python.exe /F',
    'Stop-Process -Name python',
    'Get-Process | Stop-Process',
  ]) {
    const broadKill = { toolName: 'bash', input: { command } };
    assert.match(f.hooks.tool_call(broadKill).reason, /Broad process termination/);
  }
  const targetedKill = { toolName: 'bash', input: { command: 'kill \"$child_pid\"' } };
  assert.equal(f.hooks.tool_call(targetedKill), undefined);
  assert.equal(targetedKill.input.timeout, 120);
  // Non-shell tools and blocked-write gating are untouched.
  const read = { toolName: 'read', input: { path: 'app.py' } };
  f.hooks.tool_call(read);
  assert.equal(read.input.timeout, undefined);
  assert.equal(f.hooks.tool_call({ toolName: 'write' }).block, true);
});
test('Ursina requests get the verified recipe even when skill discovery is skipped', options, t => {
  const f = fixture(t);
  const context = f.hooks.before_agent_start({ systemPrompt: 'base', prompt: 'Build a Minecraft voxel game' });
  assert.match(context.systemPrompt, /camera.ui_lens.set_film_size/);
  assert.match(context.systemPrompt, /verify_ursina.py/);
  // Game prompts carry the scope lesson: renderer-only contracts do not verify a game.
  assert.match(context.systemPrompt, /renderer-only contract does not verify a game/);
  const ordinary = f.hooks.before_agent_start({ systemPrompt: 'base', prompt: 'What is 2 + 2?' });
  assert.doesNotMatch(ordinary.systemPrompt, /camera.ui_lens.set_film_size/);
  // Ordinary prompts still receive the always-on scope-reconciliation guidance.
  assert.match(ordinary.systemPrompt, /Scope honestly: enumerate every explicit requirement/);
});
test('required validators cannot be omitted or replaced by model plans', options, async t => {
  const f = fixture(t);
  const manifest = join(f.cwd, 'validators.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, checks: [{ id: 'oracle', kind: 'test', argv: [process.execPath, '-e', 'process.exit(9)'], timeoutSeconds: 5 }] }));
  f.flags['delivery-validators'] = manifest;
  f.hooks.session_start({}, f.ctx);
  await f.call('delivery_plan', f.plan);
  const state = f.entries.at(-1).data;
  assert.ok(state.plan.checks.some(c => c.id === 'required_oracle'));
  await f.call('delivery_check', { id: 'run' });
  await assert.rejects(f.call('delivery_finish', { status: 'verified', review: 'All good', launch: 'python app.py', limitations: [] }), /required_oracle/);
  await assert.rejects(f.call('delivery_check', { id: 'all' }), /"code": 9/);
  f.plan.checks.push({ id: 'required_oracle', kind: 'runtime', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5 });
  await f.call('delivery_plan', f.plan);
  assert.match(f.entries.at(-1).data.plan.checks.find(c => c.id === 'required_oracle').argv[2], /exit\(9\)/);
});
test('invalid required manifest fails closed', options, async t => {
  const f = fixture(t);
  f.flags['delivery-validators'] = join(f.cwd, 'missing.json');
  f.hooks.session_start({}, f.ctx);
  await assert.rejects(f.call('delivery_plan', f.plan), /Invalid required validators/);
});
test('source mutation by a verifier is recorded as failed evidence', options, async t => {
  const f = fixture(t);
  f.plan.checks[0].argv = [process.execPath, '-e', 'require("node:fs").writeFileSync("app.py", "changed")'];
  await f.call('delivery_plan', f.plan);
  await assert.rejects(f.call('delivery_check', { id: 'run' }), /changedDuringCheck/);
  assert.equal(f.entries.at(-1).data.evidence.run.passed, false);
});
