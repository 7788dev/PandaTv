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
   - `python -X utf8 scripts/verify-tv-navigation.py --serial <serial> --label <label> --extended --library`
   - `python -X utf8 scripts/verify-tv-search-state.py --serial <serial> --label <label>`
   - `python -X utf8 scripts/verify-tv-playback-transitions.py --serial <serial> --label <label> --case all`
   - `python -X utf8 scripts/verify-tv-motion.py --serial <serial> --label <label> --repeat 2`
4. For an explicit empty-catalogue UI verdict, use `--case missing --enabled-sources <real-enabled-key> --require-missing` on the playback replay. This is a temporary subset of the real configured catalogues; keep that scope visible in the report. A retryable network result does not prove absence. Check `userStateRestored` for navigation, search and playback; check `sourceRulesRestored` and `firewallRulesRestored` when that replay changes them, and `libraryUserStateRestored` for seeded library cases. Restore the complete pre-run user state rather than retaining a replay's search history.
5. To obtain a before/after comparison, install the saved prior APK using `install -r -d`, replay the same case and arguments, then restore the final APK and replay again. Repeat timing-sensitive transitions. Confirm the actual descendant focus before activating a control; screenshots can allow an idle overlay to hide. For a Pause action, wait for actual playback with no buffering spinner; a nonzero clock alone can persist during a refill. Keep transition-time zero-progress and black-frame checks immediate. A system package-service timeout invalidates application timing conclusions: inspect instance readiness and restart the unhealthy emulator before drawing a verdict.
6. Run the required offline checks after the fix and record the final APK version, exact report paths and run times in the delivery report. Preserve failed before outputs; summarize a source-dependent E2E failure separately from the release build result.

## Do not

- Run two device replays concurrently on one serial.
- Use `pm clear` or the older full `verify-tv-mumu.py` main routine without a complete user-data backup; the other scripts import only its helpers.
- Send repeated media-play keys to keep an overlay visible; use ordinary D-pad reveal and verify focus.
- Replace real runtime metadata or catalogue responses with fabricated films to manufacture a live success.
- Leave the prior APK installed or a test source/firewall override in place.
- Report emulator playback as target-TV playback, or build success as playback success.
