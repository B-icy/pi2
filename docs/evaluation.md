# Verification and live Mercury trials

> Context: these trials ran in the development workspace of this package, alongside a voxel-game fixture used as the evaluation task. `default/minecraft.py` in this repository is that fixture: the deliberately defective one-shot baseline copied into each trial's isolated work directory. References to "the repository game"/"the improved game" mean an upgraded reference implementation from that workspace, which is not part of this repository; screenshots and raw event streams live in its ignored `artifacts/` and `.harness/` directories.

## Scope of the evidence

The improved game in the repository was implemented and repaired in this coding session. **It was not produced by Mercury in the trials below.** Mercury trials started from `default/minecraft.py` in new work directories. Do not attribute the repository game's passing checks to the smaller model.

Environment: Windows, Python 3.11, Ursina 7.0.0, Panda3D 1.10.16, Node 23.9.0, pi 0.85.1. Model: `openrouter/inception/mercury-2.5-preview` (the available Mercury 2.5 endpoint). This model's catalog advertises text input, not image input.

## Deterministic local checks

- Node library + actual-extension integration tests cover contract/check validation, subprocess exit/error/timeout behavior, stale evidence, undeclared file edits, generated-only scopes, serial check queues, required validators, active-branch restore, compaction context and bounded follow-ups.
- Python core tests cover deterministic/solid worlds, safe spawn, placement, protected bedrock, chunk-boundary remeshing, face winding, grid traversal, reach, movement/jump/wall/ceiling collisions, stalled-frame substeps, void recovery, atomic saves, malformed saves and import safety.
- A bounded onscreen check (`scripts/onscreen_smoke.py`) verifies actual keyboard-event dispatch, hotbar selection, pause/resume and mouse capture. It passed on this workstation; this is not extended human playtesting.
- The real game smoke checks selection/scroll, mining/placing, pause/resume, save/load, jump, movement, framebuffer output and HUD placement. The external Panda3D probe independently verifies real renderer construction and captures its framebuffer.
- The final default world has 12,644 blocks, 16 terrain entities and 9,456 visible faces. These are measured counters, not FPS claims. A representative combined generation/interaction smoke run took about 1.3–1.7 seconds on this workstation; it excludes some engine startup overhead.
- The inspected screenshot is `artifacts/game.png`. Screenshot review caught missing top faces, huge offscreen UI scale, weak text contrast and inconsistent overlay depth; those were repaired. Logic tests alone did not catch them.
- D2 0.7.1 rendered `workflow.d2` and `game-architecture.d2`. The local Go toolchain could not build D2 0.7.1, so an official release binary was downloaded into ignored `.tools/`; no system toolchain was changed.

## Live trials and what changed

Raw evidence remains under `.harness/evaluations/<trial>/`: exact event streams, generated programs, execution logs, summary JSON and delivery reports. All trials were opt-in and bounded. Provider-reported costs are recorded, not assumed to be the actual invoice.

| Trial folder prefix | Condition | Observed result |
|---|---|---|
| `1788823697128-cli-7817b8` | Baseline vs initial custom | Both passed 7/7 external CLI checks. Baseline exceeded its 45-turn budget; custom ended in 35 turns. Custom wasted many calls rejecting parallel check siblings. |
| `1788823943886-game-9e9a8d` | Initial custom game | Candidate smoke exited zero and wrote an image, but did not establish real rendering. It also declared only `artifacts/`, producing an empty source fingerprint. **This was an invalid apparent success**, not a playable-game pass. |
| `1788824255457-cli-cc97dc` | Baseline vs queued/fingerprinted custom | Baseline passed 7/7 in 24 turns. Custom passed 6/7 in 29 turns: Unicode output crashed under Windows cp1252. Two connection errors recovered. No claim of a custom win. |
| `1788824548169-game-d4a443` | Baseline vs stricter custom game | Both failed the external framebuffer probe. Baseline exceeded 90 turns; custom ended after repeated connection errors. Neither is a successful game delivery. |
| `1788825278064-cli-8a4aab` | Custom with required external validators | Completed in 42 turns; 7/7 external behavioral checks passed, including non-Latin Unicode output. Required-validator feedback was available during development. Two connection errors recovered. |
| `1788825278071-game-bb7c52` | Custom with required renderer validator | Failed graphics verification and exceeded the 90-turn budget. Thirteen connection errors were observed. An inspected real framebuffer showed a gray screen and oversized white line, not a world. The failure remains recorded. |
| `1788827018813-game-83c5b1` | Custom, first run of the revised harness | Burned the whole 600 s wall clock on an un-timed `find / -name verify_ursina.py` despite the absolute probe path being in the prompt; 2 turns, zero product work. (13 of the previous trial's 91 turns were zero-token connection errors that had also eaten its budget.) Drove the bounded-shell and productive-turn changes below. |
| `1788827921291-game-6bbbae` | Custom + bash cap + staged prompt + productive-turn accounting | **First verified game delivery:** 23 productive turns, 100 s, $0.022 reported. External probe passed with 106 sampled colors at 1280×720; import-safe launcher, procedural textures, save/load. Honest limitations still listed missing WASD/collision/chunked meshing/gameplay tests — a premature, scope-short completion. |
| `1788828169501-game-9d5ccd` | Custom + scope-reconciliation guidance | Verified in 41 productive turns, 186 s, $0.050 reported. Probe passed at the 3-color minimum ("3 colored cubes"); O(1) dict world, 15 world tests, versioned atomic saves with corruption handling, pause/selection. Movement/collision still absent and honestly declared in the handoff. |

### Changes driven by those failures

1. **FIFO check queue and `id="all"`:** no retry storm when Mercury batches verification calls.
2. **Full-project source fingerprint:** undeclared source changes invalidate evidence; output-only scopes are rejected. Changing source during a check also fails it.
3. **Required external validators:** user-owned checks are injected into the contract; the model cannot omit or replace their IDs to finish. Invalid config fails closed. This project enables core, harness and renderer checks in `.pi/delivery.json`.
4. **Renderer credibility probe:** a hand-drawn screenshot or logic-only smoke branch does not count as graphics evidence. The probe records actual framebuffer dimensions and sampled colors; its minimal three-color threshold is a coarse blank-frame heuristic, not a visual quality metric. A later re-probe confirmed the failed Mercury framebuffer had only two sampled colors; the tested starter has three and the actual game substantially more.
5. **Cross-platform integration guidance:** run actual subprocesses in the normal environment, include non-ASCII output, and do not hide encoding errors by fixing only the test's environment.
6. **Verified Ursina starter and API notes:** provide a runnable slice for offscreen lifecycle, UI lens sizing, correct color APIs, no GraphicsBuffer mouse locking, actual input handling and framebuffer capture.
7. **Eager recipe context for explicit Ursina/Minecraft/voxel requests:** smaller models sometimes skip skill discovery, so those prompts receive the game skill and starter directly. The 2025-09-07 trials below exercise this path end-to-end.
8. **Honest completion states and budgets:** failed/stale checks cannot produce verified tool status; a blocked handoff is supported, follow-ups are bounded, and the evaluation runner records time/turn/provider failures instead of treating them as success.
9. **Productive-turn accounting:** provider connection errors (13 of 91 turns in `1788825278071`) no longer consume the model-turn budget; the runner records `productiveTurns`, `providerErrors` and `endedOnProviderError` per trial (unit-tested in `lib/delivery.mjs`).
10. **Bounded shell commands (`--delivery-bash-cap`):** pi's bash/powershell tools have no default timeout, so one un-timed `find /` consumed an entire 600 s trial (`1788827018813`). The extension now caps un-timed/oversized shell timeouts at 120 s in trials via the documented `tool_call` input mutation (integration-tested), and the environment forbids filesystem-wide searches and tells the model to use provided absolute paths as-is.
11. **Renderer-first staging and self-verifying smoke:** the game prompt now requires adapting the verified starter into a probe-passing `--smoke` before gameplay breadth. The starter asserts pixel variety (`assert_nonblank`, unit-tested against flat/black/missing images), so a saved PNG alone is no longer accepted as render evidence; check evidence persists output tails and repair nudges quote the failing check's exit code and tail, denying the "environment limitation" rationalization observed in `1788825278071`.
12. **Scope-reconciliation guidance:** "verified" with a contract that omits core prompt requirements is now explicitly called a scope failure in the delivery guidance, the finish tool description, the game skill and the trial environment. Two post-fix trials still stopped before movement/collision while honestly declaring it — the remaining gap is model behavior, now visible rather than hidden.

## Interpretation

These trials are engineering regression evidence, **not a statistically powered benchmark**. The implementation changed between trials, task sizes/budgets differ, and the final custom condition receives external validator feedback during development while baseline is scored afterward. Later trials are informed by earlier failures. Do not compare them as a blind, identical-condition model ranking.

The evidence supports better failure detection and a tested verification/recovery mechanism. It **does not establish reliable one-shot game generation by Mercury 2.5**, nor a general solve-rate improvement. Model capability, endpoint reliability, independent test quality and visual review still matter. The upgraded repository game is a working reference and test fixture, not proof that the smaller model can recreate it unaided.

After the 2025-09-07 hardening, Mercury 2.5 under the improved harness went from zero successful game trials to **verified, external-probe-passing deliveries in 23–41 productive turns** (100–186 s, $0.02–$0.05 reported) where it previously exhausted 91 turns or starved on connection errors and blank framebuffers. Both successful deliveries are still incomplete games: neither implemented movement or collision, and the second cleared the probe's blank-frame bar with only three sampled colors. Gameplay breadth within one shot remains a model-capability limit that the harness now surfaces honestly in each handoff's limitations rather than letting it hide behind green checks.

For future evaluation, run multiple fresh trials of both conditions with fixed prompts, budgets, dependency environments and a separate hidden test set. Measure behavioral correctness, final gate status, renderer/visual review, wall time, failed tool calls and reported cost. Keep the failures in the report.
