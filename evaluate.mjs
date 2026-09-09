#!/usr/bin/env node
/** Opt-in live A/B runs. Separate directories are NOT security sandboxes. */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson, runCommand, turnBudgetExceeded } from './lib/delivery.mjs';

const { values: args } = parseArgs({ options: {
  mode: { type: 'string', default: 'both' }, task: { type: 'string', default: 'cli' },
  model: { type: 'string', default: 'inception/mercury-2.5-preview' }, provider: { type: 'string', default: 'openrouter' },
  timeout: { type: 'string', default: '600' }, 'max-turns': { type: 'string', default: '100' }, 'max-cost': { type: 'string', default: '3' },
  'pi2-cli': { type: 'string' }, 'pi-cli': { type: 'string' }, python: { type: 'string' }, 'allow-live': { type: 'boolean', default: false },
} });
if (!args['allow-live']) throw Error('Live calls spend API credit and generated code runs with your permissions. Use --allow-live explicitly.');
if (!['baseline', 'custom', 'both'].includes(args.mode) || !['cli', 'game'].includes(args.task)) throw Error('Use --mode baseline|custom|both and --task cli|game');
for (const key of ['timeout', 'max-turns', 'max-cost']) if (!(Number(args[key]) > 0 && Number.isFinite(Number(args[key])))) throw Error(`Invalid ${key}`);
const root = dirname(fileURLToPath(import.meta.url)), project = dirname(root);
// Layout: standalone checkouts keep the evaluation fixture (default/minecraft.py)
// beside this script; when this package is nested inside a workspace, fixture,
// venv and evidence directories live in the parent project instead.
const home = existsSync(join(root, 'default', 'minecraft.py')) ? root : project;
const candidates = [args['pi2-cli'], args['pi-cli'], process.env.PI2_CLI, process.env.PI_CLI, ...[dirname(process.execPath), dirname(realpathSync(process.execPath))].map(dir => join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'))].filter(Boolean);
const cli = candidates.find(existsSync);
if (!cli) throw Error('Cannot find pi CLI; pass --pi2-cli or --pi-cli /absolute/path/to/pi-coding-agent/dist/cli.js');
const python = args.python || join(home, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) throw Error('Pass --python with an absolute Python executable path');
const base = join(home, '.harness', 'evaluations', `${Date.now()}-${args.task}-${randomUUID().slice(0, 6)}`);
mkdirSync(base, { recursive: true });
const prompts = {
  cli: `Build a simple Python command-line task tracker. It should let me add, list, and complete tasks, save them between runs, and include tests and a short README.`,
  game: `Improve the supplied minecraft.py into a polished, playable creative voxel sandbox using the installed Ursina 7.0.0 engine. Preserve minecraft.py as the launcher; modules are welcome. Requirements: safe spawn, WASD/jump/collision, reach-limited mining and placing without overlap/player intersection, eight selectable block types, visible target feedback and readable hotbar, actual pause/resume via Escape, procedural or bundled textures, deterministic terrain, scalable rendering (not one entity per solid block), save/load with corruption handling, README with controls/setup, and automated tests. Importing minecraft must not open a window. Implement --help and --smoke --screenshot PATH: smoke must instantiate the real renderer, exercise actual input handlers for mine/place/selection/pause/save-load, save a screenshot and exit zero only if assertions pass. Work in verified stages: first adapt the verified starter recipe bundled in your system context into a --smoke path that renders a real nonblank offscreen frame (assert pixel variety, not just file existence) and make the external renderer probe pass; only then extend gameplay breadth. Do not defer graphics verification to the end. Run the product, fix failures, and deliver a complete small game rather than an ambitious scaffold. Use D2 for flowchart planning.`,
};
const probe = join(root, 'skills', 'game-development', 'scripts', 'verify_ursina.py');
const environment = `\nEnvironment: cwd is the isolated work directory. Python executable: ${JSON.stringify(python)}. Node: ${JSON.stringify(process.execPath)}. Invoke these exact executable paths (quote them in shell commands). Set a bounded timeout on every bash command and never run filesystem-wide searches (find /, ls -R from the root, find of whole drives): one hung command can consume the entire time budget. Paths given in this prompt are absolute and valid as-is; do not hunt for them. Ursina and Pillow are already installed in that Python. Do not touch files outside this work directory or run nested pi agents. No network installs, no deployment. You have at most ${args['max-turns']} productive model turns (recovered provider connection errors do not consume that budget) and ${args.timeout} seconds; reserve time for verification. If your declared checks pass with much of the budget unused, re-check whether every task requirement is implemented and verified, and use the remaining budget to complete missing requirements rather than stopping at the first passing slice. Generated logs/screenshots go in artifacts/.` + (args.task === 'game' ? `\nExternal renderer probe: ${JSON.stringify(probe)}. Run it against minecraft.py early (example: PYTHON "..." minecraft.py --screenshot artifacts/probe.png) and again after renderer changes; its required check runs the same way. The path is absolute; use it as-is.` : '');
const summaries = [];
for (const mode of args.mode === 'both' ? ['baseline', 'custom'] : [args.mode]) {
  const cwd = join(base, mode);
  mkdirSync(cwd, { recursive: true });
  if (args.task === 'game') copyFileSync(join(home, 'default', 'minecraft.py'), join(cwd, 'minecraft.py'));
  const flags = [cli, '--offline', '--mode', 'json', '--no-session', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--provider', args.provider, '--model', args.model, '--thinking', 'medium'];
  if (mode === 'custom') {
    const manifest = join(base, 'required-validators.json');
    const argv = args.task === 'cli' ? [python, join(root, 'tests', 'grade_cli.py'), cwd]
      : [python, join(root, 'skills', 'game-development', 'scripts', 'verify_ursina.py'), 'minecraft.py', '--screenshot', 'artifacts/required-smoke.png'];
    atomicJson(manifest, { version: 1, checks: [{ id: 'external_behavior', kind: 'runtime', argv, timeoutSeconds: 90 }] });
    flags.push('-e', join(root, 'extensions', 'delivery.ts'), '--skill', join(root, 'skills'), '--delivery-strict', '--delivery-validators', manifest, '--delivery-bash-cap', '120');
  }
  flags.push('--', prompts[args.task] + environment);
  const controller = new AbortController();
  let buffer = '', turns = 0, providerErrors = 0, cost = 0, tokens = 0, budgetReason = null, lastStop = null, deliveryStatus = null;
  const tools = {}, errors = [];
  function budget(reason) { if (!budgetReason) { budgetReason = reason; controller.abort(); } }
  console.log(`Starting ${mode} ${args.task} with ${args.provider}/${args.model}; ${cwd}`);
  const result = await runCommand([process.execPath, ...flags], {
    cwd, timeoutSeconds: Number(args.timeout), signal: controller.signal, logPath: join(base, `${mode}-events.jsonl`),
    onOutput(chunk) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'turn_start') { turns++; if (turnBudgetExceeded({ turns, providerErrors, maxTurns: Number(args['max-turns']) })) budget('productive model turn limit'); }
        if (event.type === 'tool_execution_start') tools[event.toolName] = (tools[event.toolName] || 0) + 1;
        if (event.type === 'tool_execution_end' && event.toolName === 'delivery_finish' && !event.isError) {
          try { deliveryStatus = JSON.parse(event.result.content.find(c => c.type === 'text').text).status; } catch { /* no verified result */ }
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          cost += event.message.usage?.cost?.total || 0;
          tokens += event.message.usage?.totalTokens || 0;
          lastStop = event.message.stopReason;
          if (lastStop === 'error') { providerErrors++; errors.push(event.message.errorMessage); }
          if (cost >= Number(args['max-cost'])) budget('reported cost limit');
        }
      }
      if (buffer.length > 2 * 1024 * 1024) budget('oversized event');
    },
  });
  const summary = { mode, task: args.task, oracleGuided: mode === 'custom', provider: args.provider, model: args.model, cwd, exitCode: result.code, timedOut: result.timedOut, budgetReason, turns, productiveTurns: turns - providerErrors, providerErrors, endedOnProviderError: lastStop === 'error', reportedCost: cost, reportedTokens: tokens, lastStop, deliveryStatus, errors, tools, durationMs: result.durationMs };
  if (args.task === 'cli') {
    const grade = await runCommand([python, join(root, 'tests', 'grade_cli.py'), cwd], { cwd, timeoutSeconds: 45, logPath: join(base, `${mode}-grade.log`) });
    summary.externalGrade = { code: grade.code, output: grade.output };
  } else {
    const smoke = await runCommand([python, join(root, 'skills', 'game-development', 'scripts', 'verify_ursina.py'), 'minecraft.py', '--screenshot', 'artifacts/external-smoke.png'], { cwd, timeoutSeconds: 90, logPath: join(base, `${mode}-smoke.log`) });
    summary.externalLaunch = { code: smoke.code === 0 && !smoke.output.includes('URSINA_PROBE_RESULT ') ? 1 : smoke.code, timedOut: smoke.timedOut, screenshotExists: existsSync(join(cwd, 'artifacts', 'external-smoke.png')), output: smoke.output };
    summary.caveat = 'External probe requires real graphics startup and a nonblank framebuffer. Gameplay assertions are still candidate-written; this is not a full gameplay/visual score.';
  }
  summaries.push(summary);
  atomicJson(join(base, 'summary.json'), summaries);
  console.log(JSON.stringify(summary, null, 2));
}
console.log(`Evidence: ${join(base, 'summary.json')}`);
if (summaries.some(s => s.exitCode !== 0 || s.endedOnProviderError && s.deliveryStatus !== 'verified' || s.mode === 'custom' && s.deliveryStatus !== 'verified' || s.timedOut || s.budgetReason || s.externalGrade?.code !== undefined && s.externalGrade.code !== 0 || s.externalLaunch?.code !== undefined && s.externalLaunch.code !== 0)) process.exitCode = 1;
