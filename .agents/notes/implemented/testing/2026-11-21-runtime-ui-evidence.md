# Agent Note: Distinguish app verification from design reference

Status: implemented

## Problem

The fixture suite launched a second Electron window for `design/preview`. Both windows showed the same seeded catalogue, which made a prototype/fixture screenshot easy to mistake for the installed product. Matching box geometry did not show whether a button actually received input, whether live artwork loaded, or which `app.asar` ran.

## Decision

Keep `design/` immutable and remove its preview launcher from application tests. The [fixture](../../../../e2e/fixture.ts) loads one hidden compiled renderer with controlled IPC/data. The [live runner](../../../../e2e/desktop.ts) validates the one window, local renderer URL, and production app path; packaged acceptance additionally records the ASAR SHA-256 and checks the renderer bundle. Reports separate `desktop-fixture`, `desktop-build-live` and `desktop-packaged-live`. Compare TV behavior on the installed signed APK by byte hash, not version name alone. See the [evidence review](../../../../docs/ui-evidence-review.md) for boundaries and historical references.

## Alternatives considered

- **Refresh or badge the prototype.** That still splits the UI into two independently maintained implementations and does not verify the production API path. Keep it as a frozen design input only.
- **Drop all fixture tests.** Deterministic empty/error and media-failure tests would become dependent on intermittent third-party behavior. Keep those tests hidden, explicitly labeled, and out of live acceptance.
- **Use all E2E output as installer evidence.** A renderer loaded from `out/` or an unpacked package does not exercise NSIS installation. Record which path was used rather than inferring installation from the version string.

## Consequences

UI regression and live acceptance run separately; the latter needs network access. New output stays in `.tmp/`. Old reports and design checks remain historical evidence and are not the current release gate.

Return-focus baselines belong to the real departure point. The first extended root-eviction check captured a deep movie card, then pressed Up through the grid and filters to reach navigation; comparing the later return to that earlier card was invalid. Keep those failed outputs as a withdrawn probe finding. The corrected D-pad case captures the actual filter departure focus; the separate auxiliary-tap case preserves a deep scroll position without claiming remote reachability. Navigation scripts already replay remote reachability independently.

The first auxiliary root taps only focused Android's touch-focusable nav pills; they never activated the destination. A per-step selected-page assertion exposed this. Auxiliary state replays now verify the tapped focus, use Confirm to activate, and verify the selected tab before continuing. Prior auxiliary failures did not exercise eviction and remain withdrawn, not quietly relabeled as product bugs.

An early pagination replay used the first text anywhere in the poster's accessibility subtree as its identity. A rating and a changing image placeholder let the check mistake the same poster for a newly loaded one. The replay now reads the actual title control, tracks visible titles row by row, and checks the last card and its position before entering Retry and after confirming. Then it requires a new title to receive focus on Down. Preserve the misleading early report alongside the corrected evidence.

The detail return replay must use the episode selectors actually visible after a previous test writes history. A selected episode can scroll the first two out of the viewport. A playback success also requires movement across clock samples while the expected episode is visible, Pause is available, and buffering is absent. Resume can display a stale nonzero clock before first playback.
