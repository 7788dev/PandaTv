# TV focus and playback transitions

Status: implemented

## Problem

Remote navigation can leave the movie grid before its first row is restored, and returning from a detail page can rebuild a saved list. Episode resolution leaves the previous video running. A metadata record can enter the player without a confirmed source. Source selection currently favors a delivered high resolution segment without a sustained playback margin.

## Decision

- [Theme.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/Theme.kt) reserves equal title and subtitle line heights and handles grid direction keys by row and column. It restores the whole first row before handing focus to a header, retains the intended column through a short final row, and resets that preference when focus leaves the grid. Channels, search, person works, favorites and history share this rule. Pagination posts notifications outside RecyclerView binding/layout.
- Search clearing cancels pending queries and rejects stale generations. The library keeps its grid when the saved entries have not changed, preserving both the selected card and scroll position on detail return.
- [HomeScreen.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/HomeScreen.kt) scopes horizontal rank-board focus search to the current rank block. At the outermost board, Left/Right stays inside the block instead of geometric focus choosing a top-bar button hundreds of pixels above. Up/Down continues to navigate through the home content normally.
- [PlayerScreen.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt) pauses, stops and clears old media at the start of a transition. It immediately updates the episode heading, resets progress and keeps a black shutter until a new frame arrives. Selected-episode generations reject obsolete resolutions and preloads; history records the episode whose media actually started. The video surface cannot take focus from the real controls, including after the overlay is hidden and revealed.
- [MainActivity.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt) checks catalogue availability before admitting a title to the player, within a 22-second request budget. Confirmed absence displays “该影片没有片源，请稍后再试” on the current page. Failed catalogues remain retryable, do not cache an absence verdict, and retain the detail page. Back, navigation and activity hiding cancel this check.
- Focus changes cancel prior animation, respond immediately and finish in 95 ms; rapid input skips intermediate motion. Page and filter reveals finish in 120 ms, and detached cards cancel pending image work and animation.
- A completed warm-media flow keeps its existing byte arrays for a reader that attaches after completion. Clearing them before that reader attached could leave a supposedly warmed first segment empty; consumed data is still released. Automatic source preference is owned by [source-contest](2026-11-17-source-contest.md).

## Alternatives considered

- Native geometric focus alone is sensitive to clipped cards and staggered column placement.
- Hiding a spinner over a playing video does not stop old audio or prevent incorrect history records.
- Entering the player before checking catalogues cannot keep a source-less title on the detail page.
- A fixed source ranking cannot represent the user's current network conditions.
- Keeping full copied warm segments indefinitely would increase heap use; retaining the existing arrays until their reader attaches or the bounded cache evicts them avoids the race without another media copy.

## Consequences

Availability checking adds a visible admission step, but a missing title never opens an unusable player. Rapid vertical input can require one more Up press while the first row is being attached; it cannot escape to a header with the row still clipped. The new package keeps API 22 and Media3 1.8.1.

Replay with [verify-tv-navigation.py](../../../../scripts/verify-tv-navigation.py), [verify-tv-search-state.py](../../../../scripts/verify-tv-search-state.py) and [verify-tv-playback-transitions.py](../../../../scripts/verify-tv-playback-transitions.py). Navigation and search restore the complete user state, including search history created by a replay, in addition to temporary library entries. The playback replay restores user state and any temporary catalogue configuration and firewall rules. [verify-tv-motion.py](../../../../scripts/verify-tv-motion.py) measures frames without clearing application data.

## Verification limits and corrected findings

The rank escape was observed in the motion replay: the fifth entry of the rightmost rank board moved to Settings on one more Right ([before](../../../../docs/evidence/runtime/tv-motion/rank-focus-before-final/report.json), [after](../../../../docs/evidence/runtime/tv-motion/final-motion/report.json)). A separate second-round motion comparison used a hero baseline collected during entry alignment (play button at y=233) and compared it to the correctly restored row (y=549); withdraw that as a return failure. The replay now establishes the complete hero before taking its baseline and records the installed APK hash to distinguish successive builds of the same unpublished version.

The episode-switch reproduction failed twice on 1.0.1 with the old timeline and video still visible under the new episode heading ([before](../../../../docs/evidence/runtime/tv-playback/episode-switch-before-final/report.json), [repeat](../../../../docs/evidence/runtime/tv-playback/episode-switch-before-repeat/report.json)). The same replay passes on 1.0.2, including the final episode's actual playback and history ([after](../../../../docs/evidence/runtime/tv-playback/final-playback/report.json), [repeat](../../../../docs/evidence/runtime/tv-playback/episode-switch-after-repeat/report.json)). The warm-flow late-reader test also failed before its fix and passes in the final 22-test Android suite.

The episode test also waits for actual playback to advance after its initial seek. A black first-episode frame captured during buffering after a fixed three-second sleep did not exercise a next-episode transition and cannot establish a transition regression. The loading assertions still sample the new heading, zero timeline and black shutter immediately after the real Next action.

A later repeat reached episode 3 at 00:02 while buffering, so the control read Play rather than Pause; the helper exhausted its focus steps just before playback resumed at 00:03 with Pause already focused ([observation](../../../../docs/evidence/runtime/tv-playback/episode-switch-buffering-observation/report.json)). Withdraw that helper timeout as a transition failure. The replay now requires a non-buffering playback state before locating Pause, verifies the resulting paused control and still checks the immediate zero timeline and black shutter without waiting for resolution.

Withdraw earlier conclusions drawn from a stopped playback clock or a hung admission check while the emulator's package service itself reported a 10-second system timeout: those runs cannot establish an application failure. Restarting the emulator restored real playback and request deadlines. Also withdraw failures caused solely by screenshots allowing the idle overlay to disappear: the replay now reveals controls and verifies their actual descendant focus before activation. Android 15 emulator evidence does not establish Android 5.1 hardware decoding performance. The delivery report owns the final results and remaining limits.
