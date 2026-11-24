# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron lifecycle, data retrieval, playback, and IPC; `src/preload/`: typed bridge; `src/shared/`: APIs; `src/renderer/`: React UI.
- `tv/app/src/main/`: Kotlin Android TV client, with assets in `assets/` and `res/`; `resources/`: desktop manifests, search indexes, and licenses.
- `scripts/`: probes, device checks, and release tooling; `docs/`: plans, reports, and evidence. Use `.tmp/` for scratch output.

**UI verification:** Use the actual `src/renderer/` and `tv/app/` implementations and their compiled output. The prototype was intentionally removed; do not restore it or use its pages, data, or screenshots for acceptance. Test fixtures belong at network or IPC boundaries. Build new behavioral regressions against the production code instead of restoring the deleted test suites.

## Build, Test, and Development Commands

Use Node.js 24 and npm; TV builds use JDK 21 and Android SDK/build-tools 37.

- `npm ci`: install locked dependencies.
- `npm run dev`: launch Electron development mode.
- `npm run typecheck`: check strict TypeScript.
- `npm test`: run Vitest once; `npm run test:release`: test release tooling.
- `npm run build`: compile desktop bundles into `out/`.
- `npm run dist -- --publish never`: create a Windows x64 NSIS installer in `release/`.
- `npm run test:e2e:fixture` / `npm run test:e2e`: offline fixture / live network UI tests; build first.
- From `tv/`, run `.\gradlew.bat testDebugUnitTest lintRelease assembleRelease` for unit tests, compatibility lint, and a release APK.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript/TSX and four spaces in Kotlin. Follow each file’s existing quote and semicolon style. Use PascalCase for components/classes, camelCase for functions/variables, and kebab-case for utility modules (`player-model.ts`). No ESLint or Prettier configuration exists; use typechecking and Android lint.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts` and `src/**/*.test.ts`; Playwright uses `e2e/**/*.spec.ts`; JUnit 4 uses `*Test.kt` under `tv/app/src/test/`. No coverage threshold is configured. Add behavioral regressions and run live Electron tests serially. Shared-rule changes require `node scripts/export-tv-vectors.mjs` and TV checks.

## Commit & Pull Request Guidelines

Follow the prevalent `type(scope): summary` convention, such as `fix(tv): preserve focus`; unscoped `docs:` and `test:` also occur. PRs should describe changed behavior, link related issues, and list validation results or missing inputs. Include screenshots or TV focus/playback evidence for UI changes.

## Architecture & Configuration

Keep requests, credentials, normalization, and playback resolution in the main process; the renderer uses `window.panda`. Preserve desktop/TV rule parity and Android API 22 compatibility. Exclude signing keys, cookies, `.env` files, and machine-specific `tv/local.properties` from Git. Consult Context7 before using library-specific APIs.
