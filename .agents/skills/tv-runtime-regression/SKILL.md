---
name: tv-runtime-regression
description: Use after changing Panda TV remote focus, pagination, search cancellation, source admission or episode transitions to replay the installed release APK and preserve seeded state and temporary network rules.
---

# TV runtime regression

Read the [delivery report](../../../docs/delivery-report.md) for the current APK and the [interaction decision](../../notes/implemented/architecture/2026-11-18-tv-interaction.md) for acceptance criteria and corrected test failures.

## Steps

1. Read root `AGENTS.md`. For shared playback changes, export `node scripts/export-tv-vectors.mjs`; run `.\gradlew.bat testDebugUnitTest lintRelease assembleRelease` from `tv/`, then verify that the release APK has the final build's bytes and signature.
2. Query the actual MuMu instance before device actions: `mumu-cli.exe info --vmindex 1`. Wait for `is_android_started: true` and `player_state: start_finished`, and use the returned host and port for the serial; do not derive the instance from a port formula. Connect `adb.exe connect <serial>` and install the reported APK with `adb.exe -s <serial> install -r <apk>`.
3. From the repository root, run the following sequentially on that same device, with a new evidence label for each comparison:
   - `python -X utf8 scripts/verify-tv-surfaces.py --serial <serial> --apk <apk> --output <evidence-dir>` for focus ownership, tab/card memory, confirmation and safe-area geometry. Run at the native viewport and test overrides separately; restore the exact original display settings.
   - `python -X utf8 scripts/verify-tv-navigation.py --serial <serial> --label <label> --extended --library`
   - For home More links or root navigation changes: `python -X utf8 scripts/verify-tv-nav-selection.py --serial <serial> --label <label> --repeat 2`
   - `python -X utf8 scripts/verify-tv-search-state.py --serial <serial> --label <label>`
   - For title matching or custom-keypad changes: `python -X utf8 scripts/verify-tv-title-search.py --serial <serial> --label <label> --case all --repeat 2`
   - For poster loading or pagination: `python -X utf8 scripts/verify-tv-pagination.py --serial <serial> --output <new-evidence-dir>`. Test both channel and person works. The replay records titles from the actual title controls row by row. It requires last-row Down to focus Retry, Up and Confirm to restore the same card position, and then Down to focus a new title after recovery.
   - `python -X utf8 scripts/verify-tv-playback-transitions.py --serial <serial> --label <label> --case all`
   - `python -X utf8 scripts/verify-tv-motion.py --serial <serial> --label <label> --repeat 2 --hold` on devices that support `input keyevent --duration` (omit `--hold` and mark sustained input untested elsewhere).
4. For an explicit empty-catalogue UI verdict, use `--case missing --enabled-sources <real-enabled-key> --require-missing` on the playback replay. This is a temporary subset of the real configured catalogues; keep that scope visible in the report. A retryable network result does not prove absence. Check `userStateRestored` for navigation, search and playback; check `sourceRulesRestored` and `firewallRulesRestored` when that replay changes them, and `libraryUserStateRestored` for seeded library cases. Restore the complete pre-run user state rather than retaining a replay's search history.
5. To obtain a before/after comparison, install the saved prior APK using `install -r -d`, replay the same case and arguments, then restore the final APK and replay again. Repeat timing-sensitive transitions. Confirm the actual descendant focus before activating a control; screenshots can allow an idle overlay to hide. For a Pause action, wait for actual playback with no buffering spinner; a nonzero clock alone can persist during a refill. Keep transition-time zero-progress and black-frame checks immediate. A system package-service timeout invalidates application timing conclusions: inspect instance readiness and restart the unhealthy emulator before drawing a verdict.
6. Run the required offline checks after the fix and record the installed APK hash, report paths and run times. Runtime output defaults to `.tmp/e2e-evidence/`; promote only reviewed evidence. Preserve failed before outputs. Read `cases`, `failures` and `unavailable` independently; a successful process exit does not turn an unobserved switch or network failure into a pass.

## Do not

- Run two device replays concurrently on one serial.
- Use `pm clear`, clear logcat, or implicitly install a different APK as part of a UI probe. The legacy `verify-tv-mumu.py` runner was removed; its replacement helpers require an explicit device serial.
- Send repeated media-play keys to keep an overlay visible; use ordinary D-pad reveal and verify focus.
- Replace real runtime metadata or catalogue responses with fabricated films to manufacture a live success.
- Leave the prior APK installed or a test source/firewall override in place.
- Report emulator playback as target-TV playback, or build success as playback success.
