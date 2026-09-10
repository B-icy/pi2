# pi2: Evidence-driven delivery

A package and CLI for [pi2](https://github.com/B-icy/pi-evidence-driven-delivery) and the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) that turns one-prompt software requests into evidence-backed deliveries: acceptance contracts with executable checks, source-freshness fingerprints that invalidate stale evidence, user-owned required validators, explicit task context, bounded repair nudges, and an opt-in scenario evaluation runner for smaller models. See `docs/workflow.svg` for the delivery flow and `docs/evaluation.md` for the honest live-trial history, failures included.

## CLI Usage

The package exposes the standalone `pi2` command line interface:

```sh
# Calculate workspace SHA-256 source freshness fingerprint
pi2 hash

# Run all declared verification checks
pi2 check all

# Inspect current plan, fingerprint, and pending status
pi2 status

# Launch the interactive web dashboard & workflow visualizer
pi2 serve

# Run test suite
pi2 test
```

## Install

Install or run via `pi2`:

```sh
pi2 install git:github.com/B-icy/pi-evidence-driven-delivery
```

Or try it for one run only:

```sh
pi2 -e git:github.com/B-icy/pi-evidence-driven-delivery -p "Build the requested software"
```

Tested with pi 0.85.1 / Node 23.9.0. No npm install is needed when loaded by pi: it supplies the declared peer dependencies (`typebox`, `@earendil-works/pi-coding-agent`). Core tests use Node built-ins; extension integration tests also need an installed pi.

## Design

The failure pattern addressed here is **plausible code -> untested success claim**. A larger system prompt alone doesn't fix it. This package couples a compact workflow with executable, durable evidence:

1. Inspect real code, runtime versions and uncertain APIs.
2. Define a small acceptance contract and a runnable vertical slice.
3. Generate a D2 plan and implement incrementally.
4. Execute checks, collect actual exit status/logs, invalidate evidence after changes.
5. Review behavior and limitations; repair failures or report a blocker.
6. Only mark the contract verified when every required check has current evidence.

`lib/delivery.mjs` contains the testable mechanics; `extensions/delivery.ts` adapts them to pi lifecycle events. No pi internals, credentials, provider payloads, default model or trust policy are replaced.

## Tools

| Tool | Purpose |
|---|---|
| `delivery_plan` | Goal, assumptions, artifact roots, steps, acceptance/check mappings; writes `plan.d2` |
| `delivery_status` | Current contract, evidence and missing/failed/stale check IDs |
| `delivery_check` | Execute a declared ID, or **`id="all"`** for all suites sequentially |
| `delivery_finish` | Record reviewed `verified` or explicitly `blocked` handoff |

Use a few meaningful suites, not one command for every bullet. A criterion may reference the same suite as other criteria. Check commands use **argv arrays**, without an implicit shell. On Windows use a real `.exe`, `node script.mjs`, or an explicit shell for `.cmd`/shell syntax. All commands run in the project cwd.

Example plan shape:

```json
{
  "goal": "A working task CLI",
  "assumptions": ["Python standard library is sufficient"],
  "artifacts": ["tasks.py", "tests", "README.md"],
  "steps": ["Runnable add/list slice", "Persistence and errors", "Tests and handoff"],
  "acceptance": [{"requirement": "Commands work in fresh processes", "checks": ["tests"]}],
  "checks": [{"id": "tests", "kind": "test", "argv": ["python", "-m", "unittest", "discover", "-s", "tests"], "timeoutSeconds": 60}]
}
```

Artifact roots are files/directories, not globs. `["."]` is usually simplest. Generated-only roots such as `artifacts/` are rejected. Fingerprinting covers the **entire cwd**, not merely declared artifacts, so an undeclared new source/config file still invalidates previous results. Replanning resets evidence but cannot silently drop original acceptance text while work is active.

Excluded directory names: `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.harness`, `artifacts`, `saves`, `.tools`, `.pytest_cache`, `.ruff_cache`; `.pyc`/`.pyo` files are also excluded. Do not put product source in excluded directories. Fingerprinting is deliberately bounded to 5,000 files / 64 MiB; it fails explicitly rather than silently omitting large inputs. Use an appropriately scoped cwd for larger repositories.

## User-owned required validators

Model-written tests can repeat the model's mistakes. Supply known tests or external probes independently of the model's proposed contract:

```json
{
  "version": 1,
  "checks": [
    {"id": "acceptance", "kind": "test", "argv": ["python", "/absolute/path/to/acceptance_tests.py"], "timeoutSeconds": 90}
  ]
}
```

Put that in **`.pi/delivery.json`** in a trusted project, or pass an explicit manifest:

```sh
pi -e /path/to/repo/extensions/delivery.ts \
  --skill /path/to/repo/skills \
  --delivery-strict --delivery-validators /path/to/validators.json \
  -p "Build the requested software"
```

Required check IDs must be at most 31 characters; they receive a `required_` ID prefix and are injected into every plan. The model cannot replace them by proposing the same ID or omit them from `delivery_finish`. Invalid manifests fail closed. The extension snapshots configuration on session startup/reload; restart/reload after changing it. Project configuration is read only when pi trusts the project; explicit CLI paths are deliberate opt-in.

These are workflow protections against mistakes, **not tamper-proof security**. A model with shell access can still edit test scripts or escape its work directory. For untrusted code use a disposable OS/container sandbox with restricted secrets/network; this package does not provide one. Test quality remains your responsibility.

## Explicit task context

The core delivery extension is task-agnostic. If a benchmark or project needs domain notes, pass them explicitly instead of hard-coding prompt matching into the extension:

```sh
pi -e /path/to/repo/extensions/delivery.ts \
  --skill /path/to/repo/skills \
  --delivery-strict \
  --delivery-context /path/to/context.md \
  --delivery-validators /path/to/validators.json \
  -p "Build the requested software"
```

Use this for any domain: browser-app accessibility checks, service API contracts, data-migration invariants, GUI/game renderer probes, or organization-specific deployment constraints. Keep the user prompt natural; put evaluator-owned quality standards and API-specific lessons in the context and required validators.

## Recovery, state and budgets

- Delivery operations are FIFO-queued. Parallel sibling check calls no longer cause an error/retry storm.
- Checks have 1–300 second deadlines and cancellation/process-tree termination support. They fail on source changes during execution, nonzero exit, output overflow, or cancellation.
- **Bounded shell commands (`--delivery-bash-cap N`):** pi's bash/powershell tools have no default timeout, so a single un-timed runaway command (observed live: `find /` consumed a whole 600 s trial) can block a bounded run until the wall clock expires. With the cap enabled, the extension patches un-timed or oversized shell timeouts to N seconds through the documented `tool_call` input mutation; 0 disables. The evaluation runner passes 120 s and tells the model to set bounded timeouts and avoid filesystem-wide searches.
- **Protected starting files (`--delivery-protect-existing`):** built-in whole-file writes, direct shell redirection, common scripted replacements, and shell remove/move/truncate commands cannot replace top-level files present at session start; focused edits remain available. This preserves verified starter slices and user-owned entry points during bounded repair loops.
- **Bounded whole-file rewrites (`--delivery-rewrite-cap N`):** after N built-in `write` calls to one path, the extension requires focused `edit` calls. This limits context growth and accidental regressions during long repair loops; 0 disables.
- **Provider pacing (`--delivery-turn-delay-ms N`):** waits after tool results so high-context tool loops do not burst into provider input-token rate limits. The base delay scales once per 50,000 active context tokens, is capped at 30 seconds, and 0 disables it.
- **Bounded tool context (`--delivery-tool-output-cap N`):** retains the beginning and end of oversized text tool results and directs the model to rerun a narrower command. This limits repetitive source/log dumps without discarding the durable evidence file; 0 disables.
- Logs have unique per-attempt paths under `.harness/<session>/<run>/`. Captured output is capped at 8 MiB per command. Check evidence also persists a short output tail (1,200 characters), so failures stay readable after compaction and in follow-up nudges.
- Contracts/evidence live in active-branch session entries and JSON reports. Restore uses `getBranch()`, not unrelated branches. Context reinjection preserves the contract after compaction without replacing pi's summary or dropping user messages; it carries compact evidence (pass/fail, fingerprint, short tails) rather than full logs.
- Incomplete implementations can trigger **at most two automatic follow-ups per user prompt**. Aborts, provider errors, blocked handoffs and pending user messages are respected. Follow-ups name the pending checks and quote the failing checks' exit codes and output tails, so a compacted or smaller model repairs the recorded failure instead of repeating a success claim or rationalizing a probe result as an environment limitation. This is not an unlimited autonomous retry loop.
- Normal interactive pi retains its usual token/time behavior. The opt-in evaluation runner additionally bounds wall time, **productive model turns, output and provider-reported cost**. Provider/connection errors are counted separately (`providerErrors`, `productiveTurns`, `endedOnProviderError` in the summary) and do not consume the turn budget; the wall-clock deadline still bounds the run. Cost limits are checked after responses and can overshoot by an in-flight response; they are not a billing guarantee.
- A required check passing is not a semantic proof that its name matches its behavior. Development validators, final holdout checks and manual/visual review should be tracked separately when evaluating output quality.

## Skills and prompts

- `/oneshot <task>` — explicit end-to-end delivery prompt.
- `software-delivery` — vertical slices, real subprocess tests, data integrity, Windows/Unicode pitfalls, services/web/refactors.
- `game-development` — import-safe game architecture, performance, real input smoke, screenshots, API-specific lessons. Scenario runners may inject this skill and starter recipe explicitly for graphics tasks; the core extension does not special-case game prompts.
- `game-development/assets/ursina_starter.py` — a runnable, tested graphics/input slice to adapt, **not a finished game**. Its smoke asserts a nonblank framebuffer by sampling pixels (`assert_nonblank`): a saved PNG alone is not render evidence. The assertion is unit-tested to reject flat, black and missing images.
- `game-development/scripts/verify_ursina.py` — independent real-renderer/nonblank-framebuffer probe. It reports framebuffer dimensions and sampled color counts, so a blank render cannot be rationalized as a headless-environment limitation.

D2 source is always generated; D2 itself is optional for rendering. With D2 installed: `d2 path/to/plan.d2 artifacts/plan.svg`. This repository's workflow was rendered with D2 0.7.1. A local downloaded binary is under `.tools/` on this workstation, not required for package installation.

## Test without model calls

```sh
node --test tests/*.test.mjs
```

Run from the repository root. If pi is not found by the integration tests, set `PI_CLI` to its absolute `dist/cli.js`. Pure-library tests need only Node. Tests cover contract validation, stale evidence, path boundaries, generated-only scope rejection, command errors/timeouts, cancellation, parallel queuing, branching, compaction context, bounded repairs and required validators.

## Live evaluation (opt-in, spends API credit)

```sh
node ./evaluate.mjs --allow-live --task cli --mode both
.venv/bin/python -m pip install -r requirements-game.txt
xvfb-run -a node ./evaluate.mjs --allow-live --task game --mode both --timeout 600 --max-turns 100 --python .venv/bin/python
```

Defaults: `inception/mercury-2.5`, the direct Inception Labs Mercury 2.5 model configured in pi, with a 100-productive-turn cap. Override `--provider`, `--model`, `--python`, `--pi-cli`, `--timeout`, `--max-turns`, `--max-cost`. Existing pi authentication is used; no keys are copied into the repo.

Each trial gets a new directory. The concise scenario request remains the only user prompt; executable paths and bounded-run rules are appended as evaluator-owned system context. Baseline disables project context, extensions and skills. Custom loads this package, any scenario context through `--delivery-context`, and fixed required validators outside the candidate workspace. Both are scored after the run with development checks and final holdout checks, preserving each check's tier/provenance in `summary.json`; `externalGrade` is the holdout verdict. **The custom condition receives validator feedback during development**; this measures oracle-assisted harness behavior, not an unassisted model benchmark.

Game trials are one scenario, not a core-harness special case. They begin from the included deliberately-defective baseline `default/minecraft.py` (a preserved original one-shot result, not an upgraded game), require `--python` pointing at an interpreter with Ursina and Pillow installed, and use `tests/grade_minecraft_clone.py` as the scenario acceptance grader. Development runs include both headless and normal-window checks so renderer-only success cannot hide a broken public launch path; the holdout reruns the full grade independently after the model exits. The interactive Linux grade also requires a display plus `xdotool` and `scrot` (for example, run the evaluation under `xvfb-run`).

Evidence includes event JSONL, tool counts, model turns, reported cost/tokens, deadlines, external scores and generated products. Recovered connection errors are logged without falsely marking a completed run as failed. One/few stochastic trials are not statistically sufficient to claim a general win.
