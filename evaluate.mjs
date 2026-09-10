#!/usr/bin/env node
/** Opt-in live A/B runs. Separate directories are NOT security sandboxes. */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, cpSync, realpathSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson, runCommand, turnBudgetExceeded } from './lib/delivery.mjs';

const { values: args } = parseArgs({ options: {
  mode: { type: 'string', default: 'both' }, task: { type: 'string', default: 'cli' }, scenario: { type: 'string' },
  model: { type: 'string', default: 'mercury-2.5' }, provider: { type: 'string', default: 'inception' },
  thinking: { type: 'string', default: 'medium' },
  timeout: { type: 'string', default: '600' }, 'max-turns': { type: 'string', default: '100' }, 'max-cost': { type: 'string', default: '3' },
  'pi2-cli': { type: 'string' }, 'pi-cli': { type: 'string' }, python: { type: 'string' }, 'seed-from': { type: 'string' }, 'allow-live': { type: 'boolean', default: false },
} });
if (!args['allow-live']) throw Error('Live calls spend API credit and generated code runs with your permissions. Use --allow-live explicitly.');
if (!['baseline', 'custom', 'both'].includes(args.mode)) throw Error('Use --mode baseline|custom|both');
for (const key of ['timeout', 'max-turns', 'max-cost']) if (!(Number(args[key]) > 0 && Number.isFinite(Number(args[key])))) throw Error(`Invalid ${key}`);

const root = dirname(fileURLToPath(import.meta.url)), project = dirname(root);
// Layout: standalone checkouts keep evaluation fixtures beside this script;
// when this package is nested inside a workspace, fixtures, venv and evidence
// directories live in the parent project instead.
const home = existsSync(join(root, 'default', 'minecraft.py')) ? root : project;
const candidates = [args['pi2-cli'], args['pi-cli'], process.env.PI2_CLI, process.env.PI_CLI, ...[dirname(process.execPath), dirname(realpathSync(process.execPath))].map(dir => join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'))].filter(Boolean);
const cli = candidates.find(existsSync);
if (!cli) throw Error('Cannot find pi CLI; pass --pi2-cli or --pi-cli /absolute/path/to/pi-coding-agent/dist/cli.js');
const python = args.python || join(home, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) throw Error('Pass --python with an absolute Python executable path');
const seedFrom = args['seed-from'] ? realpathSync(args['seed-from']) : null;
if (seedFrom && !statSync(seedFrom).isDirectory()) throw Error('--seed-from must name a candidate directory');
const continuationEvidence = (() => {
  if (!seedFrom) return '';
  const summaryPath = join(dirname(seedFrom), 'summary.json');
  if (!existsSync(summaryPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const summary = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    const failed = (summary.finalChecks || [])
      .filter(check => check.code !== 0)
      .map(check => `${check.id}:\n${check.output}`)
      .join('\n\n');
    return failed.slice(-6000);
  } catch {
    return '';
  }
})();

const rendererProbe = join(root, 'skills', 'game-development', 'scripts', 'verify_ursina.py');
const cliAcceptance = ({ cwd }) => [{
  id: 'acceptance',
  kind: 'runtime',
  argv: [python, join(root, 'tests', 'grade_cli.py'), cwd],
  timeoutSeconds: 45,
}];
const minecraftAcceptance = ({ cwd }, id, interactive) => [{
  id,
  kind: 'runtime',
  argv: [
    python,
    join(root, 'tests', 'grade_minecraft_clone.py'),
    cwd,
    '--probe',
    rendererProbe,
    ...(interactive ? [] : ['--skip-interactive']),
  ],
  timeoutSeconds: interactive ? 120 : 90,
}];
const scenarios = {
  cli: {
    prompt: 'Build a simple Python command-line task tracker. It should let me add, list, and complete tasks, save them between runs, and include tests and a short README.',
    setup: () => '',
    seed: () => [],
    context: () => '',
    developmentChecks: cliAcceptance,
    holdoutChecks: cliAcceptance,
  },
  game: {
    prompt: 'Build me a simple Minecraft-style game in Python. I should be able to explore the world, break and place different blocks, pause, and save my progress. Make it feel complete enough to play, and include tests and setup instructions.',
    setup: () => `Ursina and Pillow are already installed in the supplied Python. External renderer probe: ${JSON.stringify(rendererProbe)}. Run it early against minecraft.py and again after renderer changes; the required check uses the same probe. Preserve the seeded renderer lifecycle: default launch must call app.run() and stay interactive, while app.destroy() belongs only after the bounded --smoke path. Normal-window acceptance drives the public keyboard and mouse paths and rejects smoke-only state changes, so attach input/update methods to a live Entity. Keep the initial positive-Z movement path on terrain and clear while leaving a target reachable afterward.`,
    seed: () => [{
      from: join(root, 'skills', 'game-development', 'assets', 'ursina_starter.py'),
      to: 'minecraft.py',
    }],
    context: () => {
      const skill = join(root, 'skills', 'game-development');
      return [
        readFileSync(join(skill, 'SKILL.md'), 'utf8'),
        `Skill-relative assets/scripts resolve under: ${skill}`,
        seedFrom
          ? 'This workspace contains an earlier generated candidate. Every behavior not listed in the independent failures already passes. Preserve those behaviors, avoid subsystem rewrites, and make the smallest focused correction that addresses only the listed failures.'
          : 'minecraft.py starts as the verified Ursina vertical slice described by this skill. Preserve its live Entity callback and framebuffer setup while extending it.',
        continuationEvidence && `Independent failures from the candidate being continued:\n${continuationEvidence}`,
      ].join('\n\n');
    },
    developmentChecks: context => [
      ...minecraftAcceptance(context, 'acceptance_core', false),
      ...minecraftAcceptance(context, 'acceptance_interactive', true),
    ],
    holdoutChecks: context => minecraftAcceptance(context, 'acceptance_holdout', true),
  },
};
const scenarioName = args.scenario || args.task;
const scenario = scenarios[scenarioName];
if (!scenario) throw Error(`Unknown scenario ${JSON.stringify(scenarioName)}. Available: ${Object.keys(scenarios).join(', ')}`);

const base = join(home, '.harness', 'evaluations', `${Date.now()}-${scenarioName}-${randomUUID().slice(0, 6)}`);
mkdirSync(base, { recursive: true });
const environment = `Evaluation execution context:
The current working directory is the isolated product workspace. Write product files with workspace-relative paths such as README.md or src/app.py; do not prefix them with the current directory or recreate an absolute path as nested folders. Python executable: ${JSON.stringify(python)}. Node: ${JSON.stringify(process.execPath)}. Invoke these exact executable paths and quote them in shell commands. Absolute paths in this context identify external tools and are valid as-is; do not hunt for them.
Set a bounded timeout on every shell command and never run filesystem-wide searches (find /, ls -R from the root, find of whole drives): one hung command can consume the entire time budget. Do not touch files outside this work directory or run nested pi agents. No network installs or deployment.
You have at most ${args['max-turns']} productive model turns (recovered provider connection errors do not consume that budget) and ${args.timeout} seconds; reserve time for verification. If declared checks pass with budget unused, re-check every user requirement and finish missing behavior rather than stopping at the first passing slice. Generated logs/screenshots go in artifacts/.
${scenario.setup({ root, home, python })}`;
const environmentPath = join(base, 'execution-context.md');
writeFileSync(environmentPath, environment);
const summaries = [];

function copySeeds(cwd) {
  if (seedFrom) {
    const excluded = new Set(['.harness', 'artifacts', '__pycache__', '.pytest_cache', '.venv', 'node_modules']);
    for (const entry of readdirSync(seedFrom, { withFileTypes: true })) {
      if (!excluded.has(entry.name)) {
        cpSync(join(seedFrom, entry.name), join(cwd, entry.name), { recursive: true });
      }
    }
    return;
  }
  for (const seed of scenario.seed({ root, home, python })) {
    const target = join(cwd, seed.to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(seed.from, target);
  }
}

async function runScenarioChecks(mode, cwd, tier, checks) {
  const results = [];
  for (const check of checks({ root, home, cwd, python })) {
    const result = await runCommand(check.argv, {
      cwd,
      timeoutSeconds: check.timeoutSeconds,
      logPath: join(base, `${mode}-${tier}-${check.id}.log`),
    });
    results.push({
      id: check.id,
      tier,
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
    });
  }
  return results;
}

for (const mode of args.mode === 'both' ? ['baseline', 'custom'] : [args.mode]) {
  const cwd = join(base, mode);
  mkdirSync(cwd, { recursive: true });
  copySeeds(cwd);
  const flags = [cli, '--offline', '--mode', 'json', '--no-session', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--provider', args.provider, '--model', args.model, '--thinking', args.thinking, '--append-system-prompt', environmentPath];
  if (mode === 'custom') {
    const manifest = join(base, 'required-validators.json');
    const checks = scenario.developmentChecks({ root, home, cwd, python });
    atomicJson(manifest, { version: 1, checks });
    flags.push(
      '-e', join(root, 'extensions', 'delivery.ts'),
      '--skill', join(root, 'skills'),
      '--delivery-strict',
      '--delivery-validators', manifest,
      '--delivery-bash-cap', '120',
      '--delivery-protect-existing',
      '--delivery-rewrite-cap', '3',
      '--delivery-turn-delay-ms', '3000',
      '--delivery-tool-output-cap', '12000',
    );
    const context = scenario.context({ root, home, cwd, python });
    if (context) {
      const contextPath = join(base, `${basename(scenarioName)}-context.md`);
      writeFileSync(contextPath, context);
      flags.push('--delivery-context', contextPath);
    }
  }
  flags.push('--', scenario.prompt);
  const controller = new AbortController();
  let buffer = '', turns = 0, providerErrors = 0, cost = 0, tokens = 0, budgetReason = null, lastStop = null, deliveryStatus = null;
  const tools = {}, errors = [];
  function budget(reason) { if (!budgetReason) { budgetReason = reason; controller.abort(); } }
  console.log(`Starting ${mode} ${scenarioName} with ${args.provider}/${args.model}; ${cwd}`);
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
  const productiveTurnStarts = turns - providerErrors;
  const productiveTurns = budgetReason === 'productive model turn limit'
    ? Math.min(productiveTurnStarts, Number(args['max-turns']))
    : productiveTurnStarts;
  const summary = {
    mode,
    task: scenarioName,
    oracleGuided: mode === 'custom',
    provider: args.provider,
    model: args.model,
    cwd,
    exitCode: result.code,
    timedOut: result.timedOut,
    budgetReason,
    turns,
    productiveTurns,
    providerErrors,
    endedOnProviderError: lastStop === 'error',
    reportedCost: cost,
    reportedTokens: tokens,
    lastStop,
    deliveryStatus,
    errors,
    tools,
    durationMs: result.durationMs,
  };
  summary.developmentChecks = await runScenarioChecks(mode, cwd, 'development', scenario.developmentChecks);
  summary.holdoutChecks = await runScenarioChecks(mode, cwd, 'holdout', scenario.holdoutChecks);
  summary.finalChecks = [...summary.developmentChecks, ...summary.holdoutChecks];
  summary.externalGrade = {
    code: summary.holdoutChecks.some(check => check.code !== 0 || check.timedOut) ? 1 : 0,
    output: summary.holdoutChecks.map(check => `# ${check.id}\n${check.output}`).join('\n'),
  };
  summaries.push(summary);
  atomicJson(join(base, 'summary.json'), summaries);
  console.log(JSON.stringify(summary, null, 2));
}
console.log(`Evidence: ${join(base, 'summary.json')}`);
if (summaries.some(s =>
  s.exitCode !== 0 ||
  (s.endedOnProviderError && s.deliveryStatus !== 'verified') ||
  (s.mode === 'custom' && s.deliveryStatus !== 'verified') ||
  s.timedOut ||
  s.budgetReason ||
  s.finalChecks?.some(check => check.code !== 0 || check.timedOut)
)) process.exitCode = 1;
