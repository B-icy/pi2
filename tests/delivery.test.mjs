import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, validatePlan, planD2, pendingChecks, restoreState, runCommand, shouldContinue, localPath, createSerialQueue, validateRevision, turnBudgetExceeded } from '../lib/delivery.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi delivery spaces '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'app.py'), 'print(1)');
  return cwd;
}
function plan() { return { goal: 'Working app', assumptions: [], artifacts: ['app.py'], steps: ['Launch', 'Implement and test'], acceptance: [{ requirement: 'Runs', checks: ['smoke'] }], checks: [{ id: 'smoke', kind: 'runtime', argv: [process.execPath, '-e', 'console.log("ok")'], timeoutSeconds: 2 }] }; }

test('contract validates mapping, IDs, deadlines and meaningful checks', t => {
  const cwd = fixture(t);
  assert.deepEqual(validatePlan(plan(), cwd), plan());
  for (const mutate of [p => p.acceptance[0].checks.push('missing'), p => p.checks.push(p.checks[0]), p => p.checks[0].timeoutSeconds = 0, p => p.checks[0].kind = 'static', p => p.artifacts = ['../outside']]) {
    const p = plan(); mutate(p); assert.throws(() => validatePlan(p, cwd));
  }
});
test('D2 escapes arbitrary labels and records repair loop', () => {
  const p = plan(); p.steps[0] = 'Quoted "value"\nand newline';
  const d2 = planD2(p);
  assert.ok(d2.includes('\\"value\\"\\nand newline')); assert.ok(d2.includes('repair -> verify'));
});
test('fingerprints detect edits, additions and deletion; ignore generated evidence', t => {
  const cwd = fixture(t), initial = fingerprint(cwd, ['.']);
  mkdirSync(join(cwd, 'artifacts')); writeFileSync(join(cwd, 'artifacts', 'frame.png'), 'frame');
  assert.equal(fingerprint(cwd, ['.']), initial);
  writeFileSync(join(cwd, 'test.py'), 'assert True');
  assert.notEqual(fingerprint(cwd, ['.']), initial);
  rmSync(join(cwd, 'test.py')); assert.equal(fingerprint(cwd, ['.']), initial);
  writeFileSync(join(cwd, 'app.py'), 'print(2)'); assert.notEqual(fingerprint(cwd, ['.']), initial);
});
test('evidence cannot pass on missing, failed or stale checks', () => {
  const state = { plan: plan(), evidence: {} };
  assert.deepEqual(pendingChecks(state, 'new'), ['smoke']);
  state.evidence.smoke = { passed: true, fingerprint: 'old' };
  assert.deepEqual(pendingChecks(state, 'new'), ['smoke']);
  state.evidence.smoke.fingerprint = 'new'; assert.deepEqual(pendingChecks(state, 'new'), []);
  state.evidence.smoke.passed = false; assert.deepEqual(pendingChecks(state, 'new'), ['smoke']);
});
test('branch restoration only uses provided active-branch entries and clones state', () => {
  const entry = { type: 'custom', customType: 'delivery-state-v1', data: { status: 'implementing' } };
  assert.equal(restoreState([]), null);
  const restored = restoreState([entry, { type: 'message' }]);
  restored.status = 'verified'; assert.equal(entry.data.status, 'implementing');
});
test('follow-ups are bounded and respect abort, errors, blocking and user queues', () => {
  const args = { state: null, touched: true, nudges: 0, stopReason: 'stop', pendingMessages: false, fresh: false };
  assert.equal(shouldContinue(args), true);
  for (const change of [{ nudges: 2 }, { stopReason: 'aborted' }, { stopReason: 'error' }, { pendingMessages: true }, { touched: false }, { state: { status: 'blocked' } }, { state: { status: 'verified' }, fresh: true }]) assert.equal(shouldContinue({ ...args, ...change }), false);
  assert.equal(shouldContinue({ ...args, state: { status: 'verified' }, fresh: false }), true);
});
test('argv execution captures output without shell expansion, including spaces', async t => {
  const cwd = fixture(t), logPath = join(cwd, '.harness', 'ok.log');
  const result = await runCommand([process.execPath, '-e', 'console.log(process.argv[1])', 'literal $HOME ; echo bad'], { cwd, logPath });
  assert.equal(result.code, 0); assert.match(result.output, /literal \$HOME ; echo bad/);
  assert.match(readFileSync(logPath, 'utf8'), /literal/);
});
test('nonzero exit and missing executable cannot be successful', async t => {
  const cwd = fixture(t);
  const fail = await runCommand([process.execPath, '-e', 'process.exit(7)'], { cwd, logPath: join(cwd, 'fail.log') });
  assert.equal(fail.code, 7);
  const missing = await runCommand(['definitely-no-such-delivery-command'], { cwd, logPath: join(cwd, 'missing.log') });
  assert.notEqual(missing.code, 0); assert.match(missing.output, /ENOENT/);
});
test('timeout terminates long-lived check; cancellation before launch is cheap', async t => {
  const cwd = fixture(t);
  const result = await runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { cwd, timeoutSeconds: .15, logPath: join(cwd, 'timeout.log') });
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0);
  const signal = AbortSignal.abort();
  const cancelled = await runCommand(['never-launched'], { cwd, signal, logPath: join(cwd, 'cancel.log') });
  assert.equal(cancelled.cancelled, true);
});
test('generated-only scopes cannot create empty fingerprints as evidence', t => {
  const cwd = fixture(t);
  for (const root of ['artifacts/', './artifacts', '.harness', '.venv', 'nested/node_modules']) {
    const p = plan(); p.artifacts = [root];
    assert.throws(() => validatePlan(p, cwd), /Artifact roots/);
  }
});
test('replanning cannot silently drop requirements', () => {
  const previous = { plan: plan(), status: 'verifying' };
  const next = plan(); next.acceptance = [{ requirement: 'A weaker requirement', checks: ['smoke'] }];
  assert.throws(() => validateRevision(previous, next), /remove acceptance/);
  assert.doesNotThrow(() => validateRevision(previous, plan()));
});
test('parallel delivery operations serialize and recover after failure', async () => {
  const enqueue = createSerialQueue(), order = [];
  const a = enqueue(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 15)); order.push('a-end'); });
  const b = enqueue(async () => { order.push('b'); throw Error('expected'); });
  const c = enqueue(async () => { order.push('c'); return 7; });
  await a; await assert.rejects(b, /expected/); assert.equal(await c, 7);
  assert.deepEqual(order, ['a-start', 'a-end', 'b', 'c']);
});
test('local path boundary is not fooled by sibling prefixes', t => {
  const cwd = fixture(t); assert.throws(() => localPath(cwd, cwd + '-sibling/file'));
  assert.equal(localPath(cwd, '@app.py'), join(cwd, 'app.py'));
});
test('provider errors do not consume the productive turn budget', () => {
  // Observed live: 91 turn starts included 13 zero-token connection-error turns that
  // consumed the old budget. Only productive turns may trip the limit; wall-clock still bounds.
  assert.equal(turnBudgetExceeded({ turns: 91, providerErrors: 13, maxTurns: 90 }), false);
  assert.equal(turnBudgetExceeded({ turns: 91, providerErrors: 0, maxTurns: 90 }), true);
  // The 91st start with one wasted error turn is exactly 90 productive turns: allowed.
  assert.equal(turnBudgetExceeded({ turns: 91, providerErrors: 1, maxTurns: 90 }), false);
  assert.equal(turnBudgetExceeded({ turns: 92, providerErrors: 1, maxTurns: 90 }), true);
  assert.equal(turnBudgetExceeded({ turns: 10, providerErrors: 13, maxTurns: 90 }), false);
  assert.equal(turnBudgetExceeded({ turns: 0, providerErrors: 0, maxTurns: 0 }), false);
  assert.equal(turnBudgetExceeded({ turns: 1, providerErrors: 0, maxTurns: 0 }), true);
  for (const bad of [{ turns: 1.5, providerErrors: 0, maxTurns: 1 }, { turns: 1, providerErrors: -1, maxTurns: 1 }, { turns: 1, providerErrors: 0, maxTurns: -1 }])
    assert.throws(() => turnBudgetExceeded(bad));
});
