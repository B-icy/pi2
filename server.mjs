import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import {
  fingerprint,
  validatePlan,
  planD2,
  bindRequiredChecks,
  loadRequiredChecks,
  pendingChecks,
  runCommand,
  createSerialQueue,
  shouldContinue,
  turnBudgetExceeded
} from './lib/delivery.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cwd = process.cwd();

const app = express();
const PORT = 3000;
const enqueue = createSerialQueue();

app.use(express.json({ limit: '5mb' }));

// Initial sample plan
const SAMPLE_PLANS = {
  cli: {
    goal: 'A reliable evidence-driven task CLI with persistent storage and robust error handling',
    assumptions: ['Node.js standard library and built-in runner are sufficient'],
    artifacts: ['lib/delivery.mjs', 'tests', 'README.md'],
    steps: [
      'Inspect repository source tree and runtime versions',
      'Runnable vertical slice: argument parser and command dispatcher',
      'Implement data persistence and error boundaries',
      'Subprocess test suite with execution and timeout checks',
      'Review limitations, edge cases and verified handoff'
    ],
    acceptance: [
      {
        requirement: 'Commands run cleanly in fresh subprocesses and exit with code 0',
        checks: ['delivery_unit_tests']
      },
      {
        requirement: 'Fingerprinting detects modifications and invalidates stale evidence',
        checks: ['fingerprint_smoke']
      }
    ],
    checks: [
      {
        id: 'delivery_unit_tests',
        kind: 'test',
        argv: ['node', '--test', 'tests/delivery.test.mjs'],
        timeoutSeconds: 30
      },
      {
        id: 'fingerprint_smoke',
        kind: 'runtime',
        argv: ['node', '-e', 'import("./lib/delivery.mjs").then(m => { const h = m.fingerprint(process.cwd(), ["."]); if (!h || h.length !== 64) process.exit(1); console.log("Valid SHA-256 fingerprint:", h); })'],
        timeoutSeconds: 10
      }
    ]
  },
  ursina_game: {
    goal: 'Interactive Minecraft/voxel game prototype with verified Ursina graphics framebuffer nonblank probe',
    assumptions: ['Python 3 with Ursina or mock graphics fallback installed'],
    artifacts: ['skills/game-development', 'skills/game-development/assets/ursina_starter.py'],
    steps: [
      'Stage graphics framebuffer test slice first',
      'Adapt Ursina starter with nonblank pixel sampling',
      'Build chunk voxel generator and player camera controller',
      'Execute render and input smoke tests',
      'Review framerate, UX limitations and record handoff'
    ],
    acceptance: [
      {
        requirement: 'Renderer starts up and produces a verified nonblank framebuffer',
        checks: ['ursina_probe']
      }
    ],
    checks: [
      {
        id: 'ursina_probe',
        kind: 'test',
        argv: ['python3', 'skills/game-development/scripts/verify_ursina.py', '--help'],
        timeoutSeconds: 15
      }
    ]
  }
};

let currentState = {
  status: 'planned',
  plan: structuredClone(SAMPLE_PLANS.cli),
  evidence: {},
  review: '',
  launch: 'npm test',
  limitations: []
};

// --- API ROUTES ---

app.get('/api/status', (req, res) => {
  try {
    const currentFp = fingerprint(cwd, ['.']);
    const pending = currentState.plan ? pendingChecks(currentState, currentFp) : [];
    res.json({
      status: currentState.status,
      plan: currentState.plan,
      evidence: currentState.evidence,
      review: currentState.review,
      launch: currentState.launch,
      limitations: currentState.limitations,
      currentFingerprint: currentFp,
      pendingChecks: pending,
      isFresh: pending.length === 0 && currentState.plan?.checks?.every(c => currentState.evidence[c.id]?.passed)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fingerprint', (req, res) => {
  try {
    const roots = req.query.roots ? req.query.roots.split(',').map(s => s.trim()) : ['.'];
    const hash = fingerprint(cwd, roots);
    res.json({ fingerprint: hash, roots, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/presets', (req, res) => {
  res.json(SAMPLE_PLANS);
});

app.post('/api/plan/validate', (req, res) => {
  try {
    const plan = req.body.plan;
    const validated = validatePlan(plan, cwd);
    const d2 = planD2(validated);
    res.json({ valid: true, plan: validated, d2 });
  } catch (err) {
    res.status(400).json({ valid: false, error: err.message });
  }
});

app.post('/api/plan/d2', (req, res) => {
  try {
    const plan = req.body.plan;
    const d2 = planD2(plan);
    res.json({ d2 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plan/set', (req, res) => {
  try {
    const plan = req.body.plan;
    const validated = validatePlan(plan, cwd);
    currentState.plan = validated;
    currentState.status = 'planned';
    currentState.evidence = {}; // Reset evidence on replan
    const d2 = planD2(validated);
    res.json({ success: true, plan: validated, d2 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plan/bind-required', (req, res) => {
  try {
    const { plan, required } = req.body;
    const bound = bindRequiredChecks(plan, required);
    const validated = validatePlan(bound, cwd);
    const d2 = planD2(validated);
    res.json({ success: true, plan: validated, d2 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/checks/run', async (req, res) => {
  const { id } = req.body;
  if (!currentState.plan?.checks?.length) {
    return res.status(400).json({ error: 'No active plan configured' });
  }

  const checksToRun = id === 'all'
    ? currentState.plan.checks
    : currentState.plan.checks.filter(c => c.id === id);

  if (!checksToRun.length) {
    return res.status(404).json({ error: `Check with ID "${id}" not found in plan` });
  }

  try {
    const results = await enqueue(async () => {
      const runResults = [];
      for (const check of checksToRun) {
        const logPath = join(cwd, '.harness', 'web-run', `${check.id}-${Date.now()}.log`);
        const cmdRes = await runCommand(check.argv, {
          cwd,
          timeoutSeconds: check.timeoutSeconds || 60,
          logPath
        });
        const currentHash = fingerprint(cwd, ['.']);
        const passed = cmdRes.code === 0 && !cmdRes.timedOut && !cmdRes.cancelled && !cmdRes.outputLimit;

        const evidenceEntry = {
          passed,
          fingerprint: currentHash,
          durationMs: cmdRes.durationMs,
          code: cmdRes.code,
          timedOut: cmdRes.timedOut,
          cancelled: cmdRes.cancelled,
          outputLimit: cmdRes.outputLimit,
          output: cmdRes.output,
          logPath: cmdRes.logPath,
          timestamp: new Date().toISOString()
        };

        currentState.evidence[check.id] = evidenceEntry;
        runResults.push({ id: check.id, ...evidenceEntry });
      }
      return runResults;
    });

    const currentFp = fingerprint(cwd, ['.']);
    const pending = pendingChecks(currentState, currentFp);

    res.json({
      success: true,
      results,
      evidence: currentState.evidence,
      pendingChecks: pending,
      currentFingerprint: currentFp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finish', (req, res) => {
  try {
    const { status, review, launch, limitations } = req.body;
    if (!['verified', 'blocked'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "verified" or "blocked"' });
    }

    if (status === 'verified') {
      const currentFp = fingerprint(cwd, ['.']);
      const pending = pendingChecks(currentState, currentFp);
      if (pending.length > 0) {
        return res.status(400).json({
          error: `Cannot verify contract: pending, failed, or stale checks: ${pending.join(', ')}`
        });
      }
    }

    currentState.status = status;
    currentState.review = review || '';
    currentState.launch = launch || '';
    currentState.limitations = Array.isArray(limitations) ? limitations : [];

    res.json({ success: true, state: currentState });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  currentState = {
    status: 'planned',
    plan: structuredClone(SAMPLE_PLANS.cli),
    evidence: {},
    review: '',
    launch: 'npm test',
    limitations: []
  };
  res.json({ success: true, state: currentState });
});

app.get('/api/test-runner', (req, res) => {
  exec('npm test', { cwd }, (err, stdout, stderr) => {
    res.json({
      code: err ? err.code : 0,
      passed: !err,
      stdout,
      stderr
    });
  });
});

app.get('/api/workflow.svg', (req, res) => {
  const svgPath = join(cwd, 'docs', 'workflow.svg');
  if (existsSync(svgPath)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(readFileSync(svgPath, 'utf8'));
  } else {
    res.status(404).send('workflow.svg not found');
  }
});

app.get('/api/docs/:name', (req, res) => {
  const { name } = req.params;
  const paths = {
    readme: join(cwd, 'README.md'),
    evaluation: join(cwd, 'docs', 'evaluation.md'),
    oneshot: join(cwd, 'prompts', 'oneshot.md'),
    'game-dev': join(cwd, 'skills', 'game-development', 'SKILL.md'),
    'software-delivery': join(cwd, 'skills', 'software-delivery', 'SKILL.md')
  };

  const target = paths[name];
  if (target && existsSync(target)) {
    res.json({ content: readFileSync(target, 'utf8'), path: target });
  } else {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Serve static UI
app.use(express.static(join(cwd, 'public')));

// Fallback for any client side route (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === 'GET') {
    const indexPath = join(cwd, 'public', 'index.html');
    if (existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Evidence-Driven Delivery server running on http://0.0.0.0:${PORT}`);
});
