# Repository Guidelines

## Project Structure

`design/` is the immutable visual and data contract reference. Read the [delivery report](docs/delivery-report.md) for the current state, then the [implementation plan](docs/implementation-plan.md) and the three linked audits before changing production behavior. Desktop production sources belong in `src/main/`, `src/preload/`, `src/shared/`, and `src/renderer/`; the native Android TV client (`minSdk = 22`) lives in `tv/`; verification belongs in `tests/`, `e2e/`, and `tv/app/src/test/`; replayable live probes and device/install checks in `scripts/`. Evidence and delivery notes belong in `docs/`; scratch output goes to `.tmp/` (ignored).

## Development Rules

Use Node 24 and TypeScript. Keep upstream data normalization, requests, credentials, playback resolution and filtering in the main process. The renderer consumes the typed Panda bridge and design contract. Never import `design/mock`, `design/art`, or `design/preview` into production. Keep original design files unchanged and check their SHA256 baseline before delivery.

Use existing design CSS, copy, icons and fonts. Put extra operational copy in `src/copy.extra.ts`: the IPC layer (`safeError`) only lets text from that file or the design copy reach the interface, any other error message is replaced by a generic one. Do not fabricate metadata, movie duration, episode availability, quality, intro markers, trending terms, or update success. Missing optional fields are omitted.

Use Context7 to resolve and query current library documentation before relying on library-specific APIs. Read `C:/Users/1/.codex/RTK.md` for this host's command-output conventions. Review source rules before adopting them from other projects; record evidence and alternatives.

- Filter vocabulary must match its evidence: after editing `src/main/data/taxonomy.ts` run `npm run probe:filters` ([why](.agents/notes/implemented/architecture/2026-11-16-filter-vocabulary.md)).
- After touching source matching, line numbering or the choice of a source in `src/main/playback/service.ts`, run `npm run probe:sources` and `npm run probe:start`; one run is not a verdict, sources fail intermittently, and which are fast depends on the network: this host exits abroad, so judge domestic use by a run inside China ([verdict](.agents/notes/implemented/architecture/2026-11-16-source-verdict.md), [choice](.agents/notes/implemented/architecture/2026-11-17-source-contest.md), [measurements](docs/evidence/cn-sources.md)).
- Ad rules delete only on evidence inside the manifest; never add host lists or expiry dates; replay with `npm run audit:ads` ([why](.agents/notes/implemented/architecture/2026-11-16-ad-evidence.md)).
- After touching the home feed, the artwork proxy, connection handling or main-process startup, run `npm run probe:startup` with at least 20 first starts: stalls are intermittent, so a few clean starts prove nothing ([why](.agents/notes/implemented/architecture/2026-11-17-startup.md)).
- Keep `tv/` data, matching, ad-filtering and contract rules aligned with desktop, keep `minSdk = 22` (`NewApi` fatal, Media3 <= 1.8.x), and after changing shared rules or `resources/play-sources.json` re-export golden vectors (`node scripts/export-tv-vectors.mjs`) and run `tv\gradlew.bat testDebugUnitTest lintRelease assembleRelease` ([why](.agents/notes/implemented/architecture/2026-11-18-android-tv.md)).
- For TV focus, loading or player changes, replay navigation and playback on the installed final APK. Verify the actual control focus before activation and restore seeded user state, source overrides and firewall rules after device tests ([why](.agents/notes/implemented/architecture/2026-11-18-tv-interaction.md), [workflow](.agents/skills/tv-runtime-regression/SKILL.md)).
- In TV replay helpers, choose the D-pad axis from both target and focused-node positions; a left/right move can close the player side panel ([why](.agents/notes/implemented/architecture/2026-11-18-tv-interaction.md)).
- On this host write multi-line helper scripts to a file before running them: shell heredocs drop backslashes and mangle non-ASCII literals.

## Verification

`npm run typecheck`, `npm test` (offline), `npm run build`, then `npm run test:e2e` (needs the network; real Douban, real playback, prototype overlay). `npm run verify:design` checks the design baseline; `node design/tools/test-contract.mjs` checks the original contract (405 assertions). For the installer: `npm run dist`, `scripts/install-check.ps1`, the installed-app E2E with `PANDA_E2E_EXECUTABLE` pointing at the installed `Panda.exe`, `node scripts/asar-check.cjs <app.asar>`, `scripts/uninstall-check.ps1`; results go to `docs/evidence/install.txt`. The last full run is recorded in [final-verification.txt](docs/evidence/final-verification.txt).

Keep tests and captured fixtures outside the shipped application. Reproduce fixes before and after, run the offline suite, and independently recheck audit findings before finalizing conclusions. Never report build-only success as playback or installation success. Numbers in documents come from a run on the final code, with the time of the run.

## Contributions and Memory

The repository initially had no commits, so no commit convention can be inferred. Do not change unrelated user files, commit, or rewrite Git history implicitly. Record architecture tradeoffs using [agent notes](.agents/notes/README.md). After a commit or substantial delivery, review the note triggers there; update existing facts instead of duplicating them.
