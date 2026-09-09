---
name: game-development
description: Build or repair games, simulations, and interactive visual applications from a single prompt. Covers engine API probes, asset completeness, frame budgets, deterministic logic tests, real input smoke tests, screenshots, and packaging. Read before implementing a Minecraft/voxel clone or other GUI game.
---
# One-prompt game delivery

## First 10%: discover and de-risk
- Inspect entry point, installed engine version/source, assets, platform, and run instructions. Preserve the user's original before a major rewrite; do not overwrite unrelated work.
- Translate the prompt into 5–10 observable acceptance criteria. Choose a small complete scope, not a long list of half-implemented features. State ordinary assumptions and proceed; ask only if a consequential ambiguity blocks implementation.
- Create a `delivery_plan` with source + tests + dependency files + docs in artifact roots, acceptance-to-check mappings, and a short vertical-slice sequence. Map every explicit prompt requirement to an acceptance criterion with a real check: a renderer-only contract does not verify a game whose prompt requires movement, collision, mining and saving. It emits D2. Use D2, never Mermaid, for additional flowcharts.
- Probe uncertain methods/signatures before relying on them. An import test is not a gameplay test. In Ursina, `FirstPersonController.camera_raycast()` is not a supported API; inspect installed code and use supported raycasting or tested grid traversal.

## Implement a vertical slice, then deepen it
1. Window, camera, one visible surface, one actual input action, bounded automated launch. For Ursina 7, read `assets/ursina_starter.py` beside this skill: it is an executable, API-verified starting slice with real offscreen rendering. Adapt its lifecycle/capture pattern before implementing more systems; do not leave the starter as the finished game. Graphics feasibility is step zero: make the adapted slice render a nonblank frame and pass the external probe **before** writing gameplay code, and re-run the probe after renderer changes — never defer render verification to the end where repair budgets run out.
2. Keep pure world/state/physics/persistence logic importable without constructing a window. Avoid module-level `app.run()`; use a main guard and lazy graphical imports.
3. Finish the core loop: spawn safely, move, jump, collide, select, interact, pause/resume, recover from falling, quit. Avoid placing blocks inside the player or overlapping occupied cells; limit reach; address negative coordinates and boundary hits.
   In Ursina, callbacks nested inside `main()` are not automatically dispatched. Put `input`/`update` on a live `Entity` (or at module scope), and use a real controller such as `FirstPersonController`; do not prove controls by calling otherwise-disconnected local functions only from smoke mode.
   Use this dispatch shape:
   ```python
   class Runtime(Entity):
       def input(self, key):
           ...

       def update(self):
           ...

   runtime = Runtime()
   ```
   Smoke mode must call `runtime.input(...)`; normal mode receives the same methods through Ursina.
4. Budget rendering: a world dictionary for O(1) lookup; chunk/batched geometry; remove hidden faces; rebuild only affected chunks including neighbors at boundaries. Do not create thousands of UI Buttons or colliders. Measure startup and report real counters; do not claim FPS you didn't measure.
5. Supply all assets, generate deterministic assets, or use verified engine resources. Missing texture warnings are defects. Prefer a coherent palette, readable hierarchy, clear selection/target feedback, and a pause overlay over decorative feature sprawl.
6. Handle data honestly: atomic saves, schema/version validation, bounded input size, corrupted-save errors without destroying existing data, deterministic seed, round-trip tests.

## Last 25%: verification and repair
- Pure tests: world invariants, seeded generation, hit/miss/reach, placement rejection, collision and jump/ceiling, persistence round-trip and malformed files, mesh face/winding/count invariants.
- Integration smoke: instantiate the REAL app, step frames, invoke the SAME input handlers used by keyboard/mouse, assert the resulting world/UI state, close automatically, return nonzero on failure. Exercise break/place, selection, pause/resume, save/load when present. An offscreen graphics context still needs a working graphics driver. Never implement --smoke as a separate pure-logic demonstration or draw a substitute screenshot with PIL. For this evaluator, print one line beginning `GAME_SMOKE_RESULT ` followed by JSON proving: `spawn_safe`, `moved`, `jumped`, `looked`, `selected_block_changed`, `break_changed_world`, `place_changed_world`, `pause_toggled`, `save_roundtrip`, `block_type_count`, `world_blocks_before`, `world_blocks_after_break`, and `world_blocks_after_place`.
- The independent interactive probe launches normal mode and sends `W`, `2`, `P`, and `S`. Those controls must visibly move the view, update the selected-block UI, show a paused state, and write the path supplied by `--save`.
- A saved PNG's existence is NOT render evidence: smoke must sample the saved image's pixels and require several distinct colors (the starter's `assert_nonblank` is the tested pattern). A smoke that passes while the framebuffer is blank is a defect, not a probe limitation.
- Diagnose blank frames from evidence, not excuses. A flat window-color frame with one oversized bar means the offscreen UI lens was not sized or the camera is inside/away from geometry: compare your init order with the starter, fix, re-capture. The probe reports real framebuffer dimensions and sampled color counts; "headless environment limitations" is a rationalization those numbers already disprove.
- For Ursina, declare an additional runtime check using the bundled `scripts/verify_ursina.py` (resolve relative to this SKILL.md): `PYTHON /absolute/skill/path/scripts/verify_ursina.py minecraft.py --screenshot artifacts/probe.png`. This independently requires actual Panda3D startup and a nonblank framebuffer; it rejects fake smoke paths. It is not a full gameplay oracle.
- Ursina 7 pitfalls confirmed by executable probes: use `color.rgb32` for 0–255 channels (`color.rgb` expects normalized floats); initialize `camera.ui_lens` film size for offscreen buffers; don't set mouse lock/visibility on a GraphicsBuffer; `Entity.material` is a reserved property, not a safe name for a Text label. Ursina mesh winding is opposite mathematical right-handed outward normals. Inspect a rendered frame, not only cross-product unit tests.
- Capture a deterministic screenshot to `artifacts/`. If image-capable, read it and inspect terrain visibility, composition, text clipping, contrast, overlays, and blank/missing assets. Non-vision models must not claim visual inspection: record the image path and limitation. Screenshot existence is not evidence of good UX.
- Run checks with `delivery_check`; repair the root cause, add a regression test, and rerun all stale checks after final edits. A timeout, skipped graphics check, empty test suite, or syntax-only check is not a pass.
- Review adversarially: fresh install, default launch, alternate cwd, boundary input, unavailable assets, failure recovery, and performance. Call `delivery_finish` only with genuine evidence (or explicit blocked status).
- Deliver: what works, exact setup/run/test commands, controls, evidence paths, and remaining limitations. Never label a prototype a complete Minecraft clone. A renderer-only verified slice with unimplemented prompt gameplay is an incomplete delivery: with budget remaining, finish the required behavior and its checks before delivery_finish.

## Port this to other large software tasks
Use the same vertical-slice/evidence approach: for web apps, browser interaction tests + screenshots + accessibility; for services, boot/readiness + API/error-path tests; for CLIs, subprocess tests + exit codes + filesystem side effects. Prefer the project's existing stack and tooling. Preserve acceptance state across compaction using the delivery tools, not a long narrative transcript.
