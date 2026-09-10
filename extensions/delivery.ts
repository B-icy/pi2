import { CONFIG_DIR_NAME, truncateTail, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validatePlan, planD2, fingerprint, atomicJson, runCommand, pendingChecks, restoreState, shouldContinue, localPath, createSerialQueue, validateRevision, bindRequiredChecks, loadRequiredChecks } from '../lib/delivery.mjs';

const text = (value: unknown) => {
  const output = truncateTail(typeof value === 'string' ? value : JSON.stringify(value, null, 2), { maxBytes: 48000, maxLines: 1000 });
  return { content: [{ type: 'text' as const, text: output.content + (output.truncated ? '\n[Output truncated; full check output is in the recorded log files.]' : '') }], details: {} };
};
const shortString = () => Type.String({ minLength: 1, maxLength: 1200 });
const strings = (maxItems = 20) => Type.Array(shortString(), { minItems: 1, maxItems });
const GUIDANCE = `Software delivery workflow (not required for questions or read-only reviews):
For substantial implementation work, inspect the repository and installed library APIs first. Load the relevant domain skill when one exists. Use delivery_plan BEFORE implementation: capture assumptions, a small vertical-slice plan, artifact roots, acceptance criteria and real check commands. D2 is generated for the flowchart; use D2 for any additional flowcharts.
Implement a runnable slice early, then complete the agreed behavior in small coherent steps. Don't stop at a scaffold. Verify uncertain APIs with installed source or a tiny executable probe; never invent library methods or assume assets exist. Separate testable logic from rendering/services. Include error handling, dependencies, launch instructions, and regression tests. Exercise actual interaction paths in fresh subprocesses with the normal environment, not only compilation or internal function calls. Include non-ASCII text, paths with spaces, and invalid data where applicable. Python on Windows may have cp1252 stdout: use ASCII-escaped JSON or configure the application's UTF-8 output; don't hide failures by changing only the test environment. For visual work, capture and inspect a screenshot if your model supports images; otherwise explicitly disclose that visual review is unperformed.
After creating a file, prefer focused edit calls over repeatedly rewriting the full file. Whole-file rewrites bloat model context, increase provider rate-limit risk, and can accidentally remove previously working behavior.
Use a few meaningful check suites (usually 2–4), not one command per criterion: multiple acceptance criteria can share a suite. When user-owned required validators already cover a requirement, do not duplicate them with shallow model-authored checks; add only focused checks for logic they do not cover. Scope honestly: enumerate every explicit requirement in the user's prompt and back each core requirement with an acceptance criterion and a real check. Narrow contracts that omit core requirements (a renderer-only contract for a gameplay prompt) make 'verified' a scope failure, not a smaller task; if budget remains once checks pass, implement and verify the missing requirements instead of stopping at the first passing slice. Run delivery_check with id="all" to execute every declared check sequentially. It executes the argv with a deadline, records logs and fingerprints the entire working project (excluding dependencies, caches and generated artifacts), so omitting a source file cannot hide stale evidence. Artifact roots must contain product source/tests/config/docs, never only artifacts/. Use ["."] for the project. Do not edit during checks; run dependent tools in separate batches. Use artifacts/ for generated screenshots/build output; .harness/ is reserved for harness logs. Re-run checks after final edits.
Before concluding, adversarially review the implementation against each acceptance criterion and call delivery_finish with the review, launch command and honest limitations. Failed, missing or stale checks cannot produce verified status. If genuinely blocked, use status=blocked with the reason; do not weaken tests to manufacture success. One-shot means one USER prompt, not one tool call. No automatic deployments or unrequested destructive changes.`;

export default function delivery(pi: ExtensionAPI) {
  let state: any = null;
  let touched = false, nudges = 0;
  const exclusive = createSerialQueue();
  let required: any[] = [], extraGuidance = '', configError = '';
  let writeCounts = new Map<string, number>();
  let initialFiles = new Set<string>();
  pi.registerFlag('delivery-validators', { description: 'Path to user-owned required validator manifest; these checks cannot be omitted by the model', type: 'string' });
  pi.registerFlag('delivery-context', { description: 'Path to optional task/context guidance injected into the delivery system prompt', type: 'string' });
  pi.registerFlag('delivery-strict', { description: 'Require delivery_plan before built-in edit/write (not a security sandbox)', type: 'boolean', default: false });
  pi.registerFlag('delivery-bash-cap', { description: 'Cap bash/powershell tool timeouts at N seconds (0 disables). A single un-timed runaway command (e.g. find /) can otherwise consume an entire bounded run. Instruct the model to set bounded timeouts either way.', type: 'number', default: 0 });
  pi.registerFlag('delivery-protect-existing', { description: 'Require focused edits instead of whole-file replacement for files present at session start', type: 'boolean', default: false });
  pi.registerFlag('delivery-rewrite-cap', { description: 'Maximum built-in write calls per path in a bounded run; later changes must use focused edits (0 disables)', type: 'number', default: 0 });
  pi.registerFlag('delivery-turn-delay-ms', { description: 'Base delay after tool results in bounded runs, scaled by active context size to reduce provider rate-limit bursts (0 disables)', type: 'number', default: 0 });
  pi.registerFlag('delivery-tool-output-cap', { description: 'Maximum characters retained from each text tool result in bounded runs; preserves the beginning and end (0 disables)', type: 'number', default: 0 });
  function restore(ctx: ExtensionContext) {
    state = restoreState(ctx.sessionManager.getBranch());
    touched = false;
    nudges = state?.nudges ?? 0;
    required = [];
    extraGuidance = '';
    configError = '';
    writeCounts = new Map();
    initialFiles = new Set();
    if (pi.getFlag('delivery-protect-existing')) {
      for (const entry of readdirSync(ctx.cwd, { withFileTypes: true })) {
        if (entry.isFile()) initialFiles.add(resolve(ctx.cwd, entry.name));
      }
    }
    const explicit = pi.getFlag('delivery-validators');
    const projectConfig = join(ctx.cwd, CONFIG_DIR_NAME, 'delivery.json');
    const file = typeof explicit === 'string' && explicit ? resolve(ctx.cwd, explicit) : (ctx.isProjectTrusted?.() && existsSync(projectConfig) ? projectConfig : undefined);
    if (file) {
      try { required = loadRequiredChecks(file, ctx.cwd); }
      catch (error) { configError = `Invalid required validators: ${error}`; }
    }
    const context = pi.getFlag('delivery-context');
    if (typeof context === 'string' && context.trim()) {
      try { extraGuidance = readFileSync(resolve(ctx.cwd, context), 'utf8'); }
      catch (error) { configError = `Invalid delivery context: ${error}`; }
    }
    if (state && required.length) {
      for (const check of required) {
        const previous = state.plan.checks.find((c: any) => c.id === check.id);
        if (JSON.stringify(previous) !== JSON.stringify(check)) delete state.evidence[check.id];
      }
      state.plan = bindRequiredChecks(state.plan, required);
      if (required.some(check => !state.evidence[check.id])) state.status = 'verifying';
    }
  }
  function directory(ctx: ExtensionContext) {
    return localPath(ctx.cwd, join('.harness', ctx.sessionManager.getSessionId(), state.runId));
  }
  function persist(ctx: ExtensionContext) {
    state.nudges = nudges;
    pi.appendEntry('delivery-state-v1', structuredClone(state));
    atomicJson(join(directory(ctx), 'report.json'), state);
    if (ctx.hasUI) ctx.ui.setStatus('delivery', `delivery: ${state.status}`);
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('input', event => {
    if (event.source !== 'extension') { nudges = 0; touched = false; }
    return { action: 'continue' };
  });
  pi.on('before_agent_start', event => {
    let guidance = GUIDANCE;
    if (extraGuidance) guidance += `\n\nTask-specific delivery context:\n${extraGuidance}`;
    if (required.length) guidance += `\nUser-owned required validators will be added to your plan automatically: ${JSON.stringify(required)}. Run delivery_check id="all"; repair failures rather than replacing or bypassing these checks.`;
    return { systemPrompt: event.systemPrompt + '\n\n' + guidance };
  });
  pi.on('context', event => {
    if (!state || state.status === 'blocked') return;
    // Re-injected after compaction without replacing Pi's summary or pruning user messages.
    const summary = { goal: state.plan.goal, status: state.status, acceptance: state.plan.acceptance, steps: state.plan.steps, artifacts: state.plan.artifacts, checks: state.plan.checks, evidence: Object.fromEntries(Object.entries(state.evidence).map(([id, e]) => [id, { passed: e.passed, fingerprint: e.fingerprint, code: e.code, outputTail: e.outputTail ? e.outputTail.slice(-400) : undefined }])) };
    return { messages: [...event.messages, { role: 'custom' as const, customType: 'delivery-context', content: `Delivery contract (evidence may be stale after edits):\n${JSON.stringify(summary)}\nUse delivery_status to inspect current freshness.`, display: false, timestamp: Date.now() }] };
  });
  pi.on('tool_call', (event, ctx) => {
    if (
      event.toolName === 'edit' &&
      event.input &&
      typeof event.input === 'object' &&
      typeof event.input.edits === 'string'
    ) {
      try {
        const edits = JSON.parse(event.input.edits);
        if (
          Array.isArray(edits) &&
          edits.every(edit => edit && typeof edit === 'object' && !Array.isArray(edit))
        ) {
          event.input.edits = edits;
        }
      } catch {
        // Leave invalid input unchanged so the tool returns its normal validation error.
      }
    }
    const shellCommand =
      ['bash', 'powershell'].includes(event.toolName) &&
      event.input &&
      typeof event.input === 'object' &&
      typeof event.input.command === 'string'
        ? event.input.command
        : '';
    const mutatingShell =
      /(?:^|[;&|]\s*)\b(?:rm|mv|cp|mkdir|touch|truncate|install)\b/i.test(shellCommand) ||
      /(?:^|[^>])>(?!>)/.test(shellCommand) ||
      /\bsed\b[^\n]*\s-i(?:\s|$)/i.test(shellCommand) ||
      /\b(?:open|write_text|writeFileSync|writeFile)\s*\(/i.test(shellCommand);
    if (
      pi.getFlag('delivery-strict') &&
      !state &&
      (['write', 'edit'].includes(event.toolName) || mutatingShell)
    ) {
      return { block: true, reason: 'Call delivery_plan first. Read-only inspection and API probes remain available.' };
    }
    if (['write', 'edit'].includes(event.toolName) && event.input && typeof event.input === 'object') {
      const path = typeof event.input.path === 'string' ? event.input.path.replaceAll('\\', '/') : '';
      const cwdAsRelativePath = ctx?.cwd?.replaceAll('\\', '/').replace(/^\/+/, '') ?? '';
      const cwdName = ctx?.cwd ? basename(ctx.cwd).replaceAll('\\', '/') : '';
      if (
        cwdAsRelativePath &&
        (path === cwdAsRelativePath ||
          path.startsWith(`${cwdAsRelativePath}/`) ||
          path === cwdName ||
          path.startsWith(`${cwdName}/`))
      ) {
        return {
          block: true,
          reason: 'This path recreates the working directory inside itself. Use a workspace-relative product path such as README.md or src/app.py.',
        };
      }
      if (
        event.toolName === 'write' &&
        ctx?.cwd &&
        initialFiles.has(resolve(ctx.cwd, path))
      ) {
        return {
          block: true,
          reason: `Preserve the existing ${path} implementation. Inspect it and use focused edit calls instead of replacing the whole file.`,
        };
      }
    }
    const rewriteCap = Math.max(0, Number(pi.getFlag('delivery-rewrite-cap')) || 0);
    if (rewriteCap > 0 && event.toolName === 'write' && event.input && typeof event.input === 'object') {
      const path = typeof event.input.path === 'string' ? event.input.path : '';
      if (path) {
        const count = writeCounts.get(path) ?? 0;
        if (count >= rewriteCap) {
          return {
            block: true,
            reason: `Full-file rewrite limit reached for ${path}. Preserve working behavior and use focused edit calls for subsequent changes.`,
          };
        }
        writeCounts.set(path, count + 1);
      }
    }
    // Bounded-run protection: shell tools have no default timeout, so one un-timed
    // runaway command (observed live: `find /`) can block until the wall clock expires.
    // Mutating event.input is a documented pi guarantee and affects execution.
    const cap = Number(pi.getFlag('delivery-bash-cap')) || 0;
    if (['bash', 'powershell'].includes(event.toolName) && event.input && typeof event.input === 'object') {
      const command = typeof event.input.command === 'string' ? event.input.command : '';
      if (ctx?.cwd && initialFiles.size) {
        const redirects = [...command.matchAll(/(?:^|[^>])>(?!>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)]
          .map(match => match[1] ?? match[2] ?? match[3])
          .filter(Boolean)
          .map(path => resolve(ctx.cwd, path));
        if (redirects.some(path => initialFiles.has(path))) {
          return {
            block: true,
            reason: 'Shell redirection cannot replace a file that existed at session start. Inspect it and use a focused edit tool instead.',
          };
        }
        const replacesWithScript =
          /\bopen\s*\([^)]*,\s*['"][wax+]+['"]/i.test(command) ||
          /\b(?:write_text|writeFileSync|writeFile)\s*\(/i.test(command);
        if (
          replacesWithScript &&
          [...initialFiles].some(path => command.includes(path) || command.includes(basename(path)))
        ) {
          return {
            block: true,
            reason: 'A script cannot replace a file that existed at session start. Inspect it and use a focused edit tool instead.',
          };
        }
        const removesOrReplaces = /\b(?:rm|mv|touch|truncate)\b/i.test(command);
        if (
          removesOrReplaces &&
          [...initialFiles].some(path => command.includes(path) || command.includes(basename(path)))
        ) {
          return {
            block: true,
            reason: 'Shell commands cannot remove or replace a file that existed at session start. Inspect it and use a focused edit tool instead.',
          };
        }
      }
      const broadTermination =
        /\b(?:pkill|killall)\b/i.test(command) ||
        /\bkill\b\s+(?:-\S+\s+)*(?:-1|0)(?:\s|$)/i.test(command) ||
        /\btaskkill\b[^\n]*(?:\/im|\*)/i.test(command) ||
        /\bstop-process\b[^\n]*\s-name\b/i.test(command) ||
        /\bget-process\b[^\n]*\|\s*stop-process\b/i.test(command);
      if (broadTermination) {
        return { block: true, reason: 'Broad process termination is prohibited in bounded delivery runs. Capture the launched child PID and terminate only that PID.' };
      }
      if (cap > 0 && (typeof event.input.timeout !== 'number' || event.input.timeout > cap)) event.input.timeout = cap;
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (!event.isError && ['write', 'edit'].includes(event.toolName)) touched = true;
    const baseDelay = Math.max(0, Number(pi.getFlag('delivery-turn-delay-ms')) || 0);
    const contextTokens = ctx?.getContextUsage?.()?.tokens ?? 0;
    const delay = Math.min(30000, baseDelay * Math.max(1, Math.ceil(contextTokens / 50000)));
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const cap = Math.max(0, Number(pi.getFlag('delivery-tool-output-cap')) || 0);
    if (cap > 0 && event.content) {
      let changed = false;
      const content = event.content.map(item => {
        if (item.type !== 'text' || item.text.length <= cap) return item;
        changed = true;
        const marker = `\n...[${item.text.length - cap} characters omitted; rerun a narrower command if needed]...\n`;
        if (cap <= marker.length) return { ...item, text: item.text.slice(0, cap) };
        const head = Math.floor((cap - marker.length) / 3);
        const tail = cap - marker.length - head;
        return { ...item, text: item.text.slice(0, head) + marker + item.text.slice(-tail) };
      });
      if (changed) return { content };
    }
  });

  pi.registerTool({
    name: 'delivery_plan', label: 'Delivery plan', description: 'Create/replace the acceptance contract and generate plan.d2. Replanning resets evidence; do not drop failing requirements. Paths are relative files/directories, not globs. Checks use executable argv (no implicit shell).',
    parameters: Type.Object({
      goal: shortString(), assumptions: Type.Array(shortString(), { maxItems: 12 }),
      artifacts: strings(30), steps: strings(12),
      acceptance: Type.Array(Type.Object({ requirement: shortString(), checks: strings(12) }), { minItems: 1, maxItems: 20 }),
      checks: Type.Array(Type.Object({ id: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,39}$' }), kind: Type.String({ description: 'test, runtime, or static' }), argv: strings(40), timeoutSeconds: Type.Integer({ minimum: 1, maximum: 300 }) }), { minItems: 1, maxItems: 12 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return exclusive(async () => {
        if (configError) throw Error(configError);
        const plan = validatePlan(bindRequiredChecks(params, required), ctx.cwd);
        validateRevision(state, plan);
        state = { version: 1, runId: randomUUID(), plan, evidence: {}, status: 'implementing', createdAt: new Date().toISOString() };
        const dir = directory(ctx);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'plan.d2'), planD2(plan));
        persist(ctx);
        return text({ plan: join(dir, 'plan.d2'), report: join(dir, 'report.json'), next: 'Build a runnable slice, add regression tests, then delivery_check each check ID.' });
      });
    },
  });
  pi.registerTool({
    name: 'delivery_status', label: 'Delivery status', description: 'Show the current contract and failed/missing/stale check IDs.', parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      if (!state) return text('No delivery contract.');
      return text({ ...state, pendingChecks: pendingChecks(state, fingerprint(ctx.cwd, ['.'])) });
    },
  });
  pi.registerTool({
    name: 'delivery_check', label: 'Run delivery check', description: 'Execute a declared check, or id="all" to run all checks sequentially. Records real exit status, deadline, logs and source fingerprint. Last 12,000 characters per check, full log capped at 8 MiB. Sibling delivery calls are queued safely; do not edit during checks.',
    parameters: Type.Object({ id: shortString() }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusive(async () => {
        if (!state) throw Error('Call delivery_plan first');
        const checks = params.id === 'all' ? state.plan.checks : state.plan.checks.filter((c: any) => c.id === params.id);
        if (!checks.length) throw Error('Unknown check ID. Use delivery_status or id="all".');
        const results = [];
        for (const check of checks) {
          if (signal?.aborted) throw Error('Check cancelled before execution');
          state.status = 'verifying';
          delete state.evidence[check.id];
          const before = fingerprint(ctx.cwd, ['.']);
          persist(ctx);
          onUpdate?.(text(`Running ${check.id}: ${JSON.stringify(check.argv)}`));
          const result = await runCommand(check.argv, { cwd: ctx.cwd, timeoutSeconds: check.timeoutSeconds, signal, logPath: join(directory(ctx), `${check.id}-${randomUUID()}.log`) });
          const after = fingerprint(ctx.cwd, ['.']);
          const passed = result.code === 0 && !result.timedOut && !result.cancelled && !result.outputLimit && before === after;
          state.evidence[check.id] = { passed, fingerprint: after, code: result.code, timedOut: result.timedOut, cancelled: result.cancelled, logPath: result.logPath, durationMs: result.durationMs, changedDuringCheck: before !== after, outputTail: result.output.slice(-1200) };
          persist(ctx);
          const message = { id: check.id, ...state.evidence[check.id], outputTail: result.output };
          if (!passed) throw Error(JSON.stringify(message, null, 2));
          results.push(message);
        }
        return text(results);
      });
    },
  });
  pi.registerTool({
    name: 'delivery_finish', label: 'Finish delivery', description: 'Record review and handoff. verified requires all declared checks passing on current artifact hashes and existing artifacts; ensure the declared contract covers the prompt’s core requirements, not only the easiest subset. blocked records an honest incomplete result without pretending success.',
    parameters: Type.Object({ status: Type.String({ description: 'verified or blocked' }), review: shortString(), launch: shortString(), limitations: Type.Array(shortString(), { maxItems: 20 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      return exclusive(async () => {
        if (!state) throw Error('Call delivery_plan first');
        if (configError) throw Error(configError);
        if (!['verified', 'blocked'].includes(params.status)) throw Error('status must be verified or blocked');
        const hash = fingerprint(ctx.cwd, ['.']);
        if (params.status === 'verified') {
          const missing = state.plan.artifacts.filter((p: string) => !existsSync(localPath(ctx.cwd, p)));
          const pending = pendingChecks(state, hash);
          if (missing.length || pending.length) throw Error(`Cannot verify. Missing artifacts: ${missing.join(', ')}. Failed/missing/stale checks: ${pending.join(', ')}`);
        } else if (!params.limitations.length) throw Error('Blocked delivery requires an explicit limitation/reason');
        state.status = params.status;
        state.handoff = { ...params, fingerprint: hash, at: new Date().toISOString() };
        persist(ctx);
        return text({ status: state.status, report: join(directory(ctx), 'report.json'), note: 'Evidence covers declared checks, not a guarantee of correctness. Distinguish automated evidence from unperformed manual/visual review.' });
      });
    },
  });
  pi.on('agent_end', (event, ctx) => {
    const last = [...event.messages].reverse().find((m: any) => m.role === 'assistant') as any;
    let fresh = false, pending: string[] = [], failures: string[] = [];
    try {
      const hash = fingerprint(ctx.cwd, ['.']);
      fresh = !!state && state.handoff?.fingerprint === hash;
      if (state) {
        pending = pendingChecks(state, hash);
        failures = Object.entries(state.evidence).filter(([, e]: any) => !e.passed)
          .map(([id, e]: any) => `check ${id} failed (exit ${e.code}, timedOut ${e.timedOut})${e.outputTail ? `; last output: ${String(e.outputTail).slice(-400)}` : ''}`);
      }
    } catch { /* explicit re-verification required */ }
    if (!shouldContinue({ state, touched, nudges, stopReason: last?.stopReason, pendingMessages: ctx.hasPendingMessages(), fresh })) return;
    nudges++;
    if (state) persist(ctx);
    const specifics = [...(pending.length ? [`pending checks: ${pending.join(', ')}`] : []), ...failures].join('\n');
    pi.sendMessage({ customType: 'delivery-gate', display: true, content: `Delivery follow-up ${nudges}/2: implementation ended without current verified evidence.${specifics ? `\n${specifics}\n` : ''}Read the quoted output, repair the root cause it points to (do not rationalize a failing probe as an environment limitation without evidence), rerun the failing checks, then delivery_finish. If genuinely blocked, record status=blocked with specific limitations. Do not merely repeat a success claim.` }, { triggerTurn: true, deliverAs: 'followUp' });
  });
}
