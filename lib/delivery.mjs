import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';

const OMIT = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.harness', 'artifacts', 'saves', '.tools', '.pytest_cache', '.ruff_cache']);
export function localPath(cwd, path) {
  if (typeof path !== 'string' || !path.trim()) throw Error('A nonempty relative path is required');
  const full = resolve(cwd, path.replace(/^@/, ''));
  const rel = relative(resolve(cwd), full);
  if (rel.startsWith('..' + '/') || rel.startsWith('..' + '\\') || rel === '..' || isAbsolute(rel)) throw Error('Path escapes working directory');
  let cursor = resolve(cwd);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error(`Symlink not supported: ${cursor}`);
  }
  return full;
}

export function fingerprint(cwd, roots) {
  const files = new Set();
  let bytes = 0;
  const hash = createHash('sha256');
  function visit(path) {
    if (OMIT.has(basename(path)) || /\.(pyc|pyo)$/.test(path)) return;
    if (!existsSync(path)) { hash.update(`missing:${relative(cwd, path)}\0`); return; }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error(`Symlink not supported in evidence scope: ${path}`);
    if (stat.isDirectory()) {
      hash.update(`directory:${relative(cwd, path)}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      files.add(path);
      if (files.size > 5000) throw Error('Evidence scope exceeds 5000 files; use a narrower project cwd or move generated/dependency files to excluded directories');
    }
  }
  for (const root of [...roots].sort()) visit(localPath(cwd, root));
  for (const file of [...files].sort()) {
    bytes += lstatSync(file).size;
    if (bytes > 64 * 1024 * 1024) throw Error('Evidence scope exceeds 64 MiB; use a narrower project cwd or move generated/dependency files to excluded directories');
    hash.update(relative(cwd, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function validatePlan(plan, cwd) {
  if (!plan.goal?.trim()) throw Error('Goal is required');
  if (!plan.artifacts?.length) throw Error('Declare source, test, configuration and documentation artifact roots');
  plan.artifacts.forEach(p => {
    const full = localPath(cwd, p);
    const parts = relative(resolve(cwd), full).split(/[\\/]/);
    if (parts.some(part => OMIT.has(part))) throw Error('Artifact roots must be product source/tests/config/docs, not ignored output or dependency directories. Use ["."] for the project.');
  });
  if (!plan.steps?.length || plan.steps.length > 12) throw Error('Use 1–12 implementation steps');
  if (!plan.checks?.length || !plan.acceptance?.length) throw Error('Acceptance criteria and executable checks are required');
  const ids = new Set();
  for (const check of plan.checks) {
    if (check.id === 'all' || !/^[a-z][a-z0-9_-]{0,39}$/.test(check.id) || ids.has(check.id)) throw Error('Check IDs must be unique safe identifiers');
    ids.add(check.id);
    if (!check.argv?.length || check.argv.some(s => typeof s !== 'string' || !s.length)) throw Error('Check argv must contain an executable and separate arguments');
    if (!['test', 'runtime', 'static'].includes(check.kind)) throw Error('Check kind must be test, runtime or static');
    if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 300) throw Error('Check timeout must be 1–300 seconds');
  }
  if (!plan.checks.some(c => c.kind !== 'static')) throw Error('Syntax checks alone are insufficient: add a test or runtime check');
  for (const item of plan.acceptance) {
    if (!item.requirement?.trim() || !item.checks?.length || item.checks.some(id => !ids.has(id))) throw Error(`Every acceptance criterion must reference existing check IDs. Available: ${[...ids].join(', ')}. Multiple criteria can share a test suite.`);
  }
  return structuredClone(plan);
}

export function bindRequiredChecks(plan, required) {
  const bound = structuredClone(plan);
  const ids = new Set(required.map(check => check.id));
  bound.checks = [...bound.checks.filter(check => !ids.has(check.id)), ...structuredClone(required)];
  bound.acceptance = bound.acceptance.filter(item => !item.requirement.startsWith('[Harness required] '));
  for (const check of required) bound.acceptance.push({ requirement: `[Harness required] ${check.id}`, checks: [check.id] });
  return bound;
}

export function loadRequiredChecks(path, cwd) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.checks) || !data.checks.length || data.checks.length > 12) throw Error('Validator manifest requires version:1 and 1–12 checks');
  if (data.checks.some(check => typeof check.id !== 'string' || check.id.length > 31)) throw Error('Required validator IDs must be at most 31 characters (room for required_ prefix)');
  // Validate using the same command schema as model-declared checks.
  validatePlan({ goal: 'Required verification', artifacts: ['.'], steps: ['Verify'], acceptance: [{ requirement: 'External checks', checks: data.checks.map(c => c.id) }], checks: data.checks }, cwd);
  return data.checks.map(check => ({ ...check, id: `required_${check.id}` }));
}

export function validateRevision(previous, next) {
  if (!previous || ['verified', 'blocked'].includes(previous.status)) return;
  const requirements = new Set(next.acceptance.map(item => item.requirement));
  const dropped = previous.plan.acceptance.filter(item => !requirements.has(item.requirement));
  if (dropped.length) throw Error('Replanning cannot silently remove acceptance criteria. Retain the original requirement text and adjust check commands, or report the task blocked.');
}

export function planD2(plan) {
  const lines = ['direction: down', `goal: ${JSON.stringify(plan.goal)}`];
  plan.steps.forEach((s, i) => {
    lines.push(`step${i}: ${JSON.stringify(s)}`);
    lines.push(`${i ? 'step' + (i - 1) : 'goal'} -> step${i}`);
  });
  lines.push('verify: "Execute checks against source fingerprint"', `step${plan.steps.length - 1} -> verify`, 'review: "Review behavior, UX, edge cases and limitations"', 'verify -> review', 'repair: "Fix failures; rerun stale checks"', 'verify -> repair: failure', 'repair -> verify', 'deliver: "Evidence-backed handoff"', 'review -> deliver');
  return lines.join('\n') + '\n';
}

export function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n');
  renameSync(temp, path);
}

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

// No implicit shell. Use ["bash", "-lc", "..."] explicitly when a shell is necessary.
export async function runCommand(argv, { cwd, timeoutSeconds = 60, signal, logPath, onOutput } = {}) {
  if (signal?.aborted) return { code: null, cancelled: true, timedOut: false, output: 'Cancelled before launch', durationMs: 0 };
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w');
  const started = Date.now();
  return new Promise(resolveResult => {
    let tail = '', written = 0, timedOut = false, cancelled = false, outputLimit = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => killTree(child);
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    function consume(chunk) {
      const text = chunk.toString();
      tail = (tail + text).slice(-12000);
      onOutput?.(text);
      if (written + chunk.length <= 8 * 1024 * 1024) { writeSync(fd, chunk); written += chunk.length; }
      else if (!outputLimit) { outputLimit = true; writeSync(fd, '\n[8 MiB output limit exceeded; terminated]\n'); stop(); }
    }
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', e => consume(Buffer.from(String(e))));
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      closeSync(fd);
      resolveResult({ code, timedOut, cancelled, outputLimit, output: tail, logPath, durationMs: Date.now() - started });
    });
    if (signal?.aborted) abort();
  });
}

// Tools in the same assistant message execute concurrently in Pi. Queue delivery
// operations rather than burning model turns rejecting sibling checks.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(job) {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}

export function pendingChecks(state, hash) {
  return state.plan.checks.filter(c => {
    const evidence = state.evidence[c.id];
    return !evidence || !evidence.passed || evidence.fingerprint !== hash;
  }).map(c => c.id);
}

export function restoreState(entries) {
  let state = null;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'delivery-state-v1') state = structuredClone(entry.data);
  }
  return state;
}

export function shouldContinue({ state, touched, nudges, stopReason, pendingMessages, fresh }) {
  return nudges < 2 && !pendingMessages && stopReason === 'stop' &&
    (state ? state.status !== 'blocked' && (state.status !== 'verified' || !fresh) : touched);
}

// Live-trial budget policy: provider/connection failures produce no product work
// and must not consume the productive model-turn budget; wall-clock still bounds the run.
export function turnBudgetExceeded({ turns, providerErrors, maxTurns }) {
  if (![turns, providerErrors, maxTurns].every(Number.isInteger) || providerErrors < 0 || maxTurns < 0) throw Error('turns, providerErrors and maxTurns must be nonnegative integers');
  return turns - providerErrors > maxTurns;
}
