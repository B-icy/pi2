---
name: software-delivery
description: Complete substantial software implementation from one prompt: CLIs, services, web apps and multi-file refactors. Use for acceptance contracts, vertical slices, process-level integration tests, platform/encoding failures, and evidence-backed handoff.
---
# Large-task delivery

One user prompt can require many small implementation and verification turns. Prefer complete, testable behavior over generating a large code dump.

1. Inspect the repository, current tests, dependency manifests, runtime versions, and actual APIs. Establish the user's observable requirements and sensible scope. Don't silently delete requirements when tools fail.
2. Use `delivery_plan` before implementation: a few steps, explicit assumptions, source/test/config/documentation roots (usually `["."]`), and 2–4 check suites. Reuse a check suite across acceptance criteria. D2 is emitted automatically; use D2 for other flowcharts.
3. Get one vertical slice running early: CLI command -> output/file; request -> handler -> response; UI action -> state -> visible feedback. Keep logic separable from infrastructure.
4. Implement remaining requirements, failure behavior, dependency pins, and README commands. Check uncertain APIs by reading installed implementations or running a tiny probe. Don't add tests requiring an uninstalled framework; use the existing framework or standard-library tools.
5. Verify like a user, in a **fresh process with the normal environment**, not just by calling internal functions. Use `delivery_check` with `id="all"`. Keep generated output under `artifacts/` so it doesn't invalidate source fingerprints. Do not edit while checks run.
6. Review behavior, failure paths, data integrity, usability, performance and scope. Repair root causes, add regression tests, rerun stale checks, then `delivery_finish`. A blocked report is preferable to a false verified report.

## CLI and filesystem pitfalls
- Test exit codes, stdout/stderr separation, filesystem side effects, paths with spaces, alternate cwd, and repeat invocations. Use subprocess argument arrays; shell quoting is platform-specific.
- Test non-ASCII text (not just accented Latin) through the actual command with captured stdout. On Windows, Python stdout may be cp1252 even when files are UTF-8. `ensure_ascii=False` alone can crash JSON CLI output. Either emit ASCII-escaped JSON (preserves Unicode after decoding) or explicitly configure UTF-8 stdout/stderr in the application. Do not make only the test environment UTF-8 and claim the default executable works.
- Reject malformed schema as well as malformed syntax. Avoid coercing booleans to integer IDs. Test duplicate records, missing files, invalid identifiers, whitespace-only values, and idempotency where relevant.
- Write to a temporary file in the destination directory, flush, then atomically replace. On failure leave the previous bytes untouched and clean up temporary files. Never discard corrupt user data to make a test pass.
- Import safety: a subprocess should import the module without starting a service/window, parsing unrelated argv, writing files, or printing output. `if __name__ == '__main__'` belongs on entry points.

## Other task types
- Games/GUI: read the game-development skill and use its real-renderer probe for Ursina. Never substitute a hand-drawn image for a renderer screenshot.
- Web: test real browser actions, empty/loading/error states, keyboard focus and screenshots; do not mistake a dev server's readiness for correct UI.
- Services: boot/readiness, schema validation, failure status codes, persistence and shutdown; avoid unauthorized live integrations.
- Refactors: preserve the public contract and existing tests, add a failing regression first, keep changes scoped, examine the final diff.

## Evidence discipline
Checks written by the same model can share its blind spots. External behavioral tests and visual inspection are separate evidence. A passing gate proves recorded commands passed on the current project, not that all requirements are objectively satisfied. Never remove assertions, relabel runtime work as static checks, or narrow the contract to achieve a green status. If context compacts, retrieve `delivery_status` and continue from the durable contract.
