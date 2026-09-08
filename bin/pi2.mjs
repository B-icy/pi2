#!/usr/bin/env node
/**
 * pi2 CLI - Evidence-driven delivery & contract verification
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  fingerprint,
  validatePlan,
  planD2,
  runCommand,
  pendingChecks
} from '../lib/delivery.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cwd = process.cwd();
const root = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const command = argv[0];

function printHelp() {
  console.log(`
\x1b[1m\x1b[36mπ² (pi2) - Evidence-Driven Delivery CLI\x1b[0m \x1b[90mv0.2.0\x1b[0m

\x1b[1mUSAGE:\x1b[0m
  pi2 <command> [options]

\x1b[1mCOMMANDS:\x1b[0m
  \x1b[32mstatus\x1b[0m, \x1b[32ms\x1b[0m             Display workspace fingerprint, active contract & pending checks
  \x1b[32mcheck\x1b[0m [id], \x1b[32mc\x1b[0m [id]     Execute check suite (default: 'all') in bounded subprocess
  \x1b[32mhash\x1b[0m, \x1b[32mfingerprint\x1b[0m     Calculate workspace SHA-256 source freshness fingerprint
  \x1b[32mvalidate\x1b[0m <file.json> Validate acceptance contract against delivery schema
  \x1b[32mserve\x1b[0m, \x1b[32mweb\x1b[0m, \x1b[32mstart\x1b[0m     Start the interactive web dashboard on port 3000
  \x1b[32mtest\x1b[0m                   Run core unit test suite (14/14 tests)
  \x1b[32meval\x1b[0m [args...]         Run evaluation harness (evaluate.mjs)
  \x1b[32mhelp\x1b[0m, \x1b[32m--help\x1b[0m, \x1b[32m-h\x1b[0m       Display this help message

\x1b[1mEXAMPLES:\x1b[0m
  pi2 hash
  pi2 check all
  pi2 status
  pi2 serve
`);
}

async function handleStatus() {
  const currentFp = fingerprint(cwd, ['.']);
  console.log(`\x1b[1mWorkspace:\x1b[0m            ${cwd}`);
  console.log(`\x1b[1mSHA-256 Fingerprint:\x1b[0m  \x1b[36m${currentFp}\x1b[0m`);

  // Check if there is an active contract or saved session
  const planPath = join(cwd, '.harness', 'plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      console.log(`\x1b[1mContract Goal:\x1b[0m        ${plan.goal}`);
      console.log(`\x1b[1mDeclared Checks:\x1b[0m      ${plan.checks?.map(c => c.id).join(', ')}`);
    } catch {
      // ignore parse error
    }
  } else {
    console.log(`\x1b[90m(No local .harness/plan.json active in cwd. Run 'pi2 serve' to manage contracts in UI)\x1b[0m`);
  }
}

async function handleHash() {
  const roots = argv.slice(1).length > 0 ? argv.slice(1) : ['.'];
  try {
    const hash = fingerprint(cwd, roots);
    console.log(hash);
  } catch (err) {
    console.error(`\x1b[31mError calculating fingerprint:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}

async function handleCheck() {
  const checkId = argv[1] || 'all';
  console.log(`\x1b[1m[pi2]\x1b[0m Running verification check: \x1b[36m${checkId}\x1b[0m`);

  const initialHash = fingerprint(cwd, ['.']);
  console.log(`\x1b[1m[pi2]\x1b[0m Pre-check fingerprint: \x1b[90m${initialHash.slice(0, 16)}...\x1b[0m`);

  // Default check if none specified in workspace
  let checks = [
    { id: 'unit_tests', kind: 'test', argv: [process.execPath, '--test', join(root, 'tests', 'delivery.test.mjs')], timeoutSeconds: 30 }
  ];

  const planPath = join(cwd, '.harness', 'plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      if (plan.checks?.length) {
        checks = checkId === 'all' ? plan.checks : plan.checks.filter(c => c.id === checkId);
      }
    } catch {
      // ignore
    }
  }

  let allPassed = true;
  for (const check of checks) {
    console.log(`\n\x1b[1m=== Running check [${check.id}] ===\x1b[0m`);
    console.log(`Command: ${check.argv.join(' ')}`);
    const res = await runCommand(check.argv, {
      cwd,
      timeoutSeconds: check.timeoutSeconds || 60
    });

    if (res.output) {
      console.log(res.output.trim());
    }

    const postHash = fingerprint(cwd, ['.']);
    if (res.code === 0 && !res.timedOut && !res.cancelled) {
      console.log(`\x1b[32m✓ Check [${check.id}] PASSED (${res.durationMs}ms)\x1b[0m`);
      if (postHash !== initialHash) {
        console.warn(`\x1b[33m⚠ Warning: Check modified workspace files! Fingerprint changed.\x1b[0m`);
      }
    } else {
      console.log(`\x1b[31m✕ Check [${check.id}] FAILED (Exit code: ${res.code})\x1b[0m`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    process.exit(1);
  }
}

async function handleValidate() {
  const filePath = argv[1];
  if (!filePath) {
    console.error('Usage: pi2 validate <path-to-plan.json>');
    process.exit(1);
  }
  try {
    const raw = readFileSync(resolve(cwd, filePath), 'utf8');
    const plan = JSON.parse(raw);
    const validated = validatePlan(plan, cwd);
    console.log('\x1b[32m✓ Acceptance contract is VALID.\x1b[0m');
    console.log(`Goal: ${validated.goal}`);
    console.log(`Checks: ${validated.checks.map(c => c.id).join(', ')}`);
    const d2 = planD2(validated);
    console.log('\n\x1b[1mGenerated D2 Outline:\x1b[0m\n' + d2);
  } catch (err) {
    console.error('\x1b[31m✕ Validation Error:\x1b[0m', err.message);
    process.exit(1);
  }
}

function handleServe() {
  console.log('\x1b[1m[pi2]\x1b[0m Launching Evidence-Driven Delivery server...');
  const serverScript = join(root, 'server.mjs');
  const child = spawn(process.execPath, [serverScript], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  });
  child.on('exit', (code) => process.exit(code || 0));
}

function handleTest() {
  console.log('\x1b[1m[pi2]\x1b[0m Running unit test suite...');
  const child = spawn(process.execPath, ['--test', 'tests/delivery.test.mjs'], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  });
  child.on('exit', (code) => process.exit(code || 0));
}

function handleEval() {
  const evalScript = join(root, 'evaluate.mjs');
  const child = spawn(process.execPath, [evalScript, ...argv.slice(1)], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  });
  child.on('exit', (code) => process.exit(code || 0));
}

// Router
switch (command) {
  case 'status':
  case 's':
    handleStatus();
    break;
  case 'hash':
  case 'fingerprint':
    handleHash();
    break;
  case 'check':
  case 'c':
    handleCheck();
    break;
  case 'validate':
    handleValidate();
    break;
  case 'serve':
  case 'web':
  case 'start':
    handleServe();
    break;
  case 'test':
    handleTest();
    break;
  case 'eval':
    handleEval();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    // If unknown command, show help or run check
    console.error(`\x1b[31mUnknown command:\x1b[0m ${command}`);
    printHelp();
    process.exit(1);
}
