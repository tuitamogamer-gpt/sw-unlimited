# Local Forceteki patches

Upstream baseline: `SWU-Karabast/forceteki`, commit `1f0e9783c4743acdc67df0c4ab3f3610a349c32a` (MIT). The vendored tree includes the following correctness and hosting compatibility fixes.

## Use the CommonJS-compatible UUID package

The vendor manifest and lockfile pin `uuid` to `11.1.0`. Upstream's version 14 is ESM-only, while the compiled engine uses CommonJS `require()` for prompt UUIDs. Vercel's function loader rejects that ESM import even with Node 24 selected. Version 11 retains the same UUID v1/v4 APIs used by the engine and provides a native CommonJS export. The app's Node version is pinned to `24.x` for consistent builds. Validate compatibility with `NODE_OPTIONS=--no-experimental-require-module npm test`.

## Complete grouped trigger windows through the normal pipeline

File: `vendor/forceteki/server/game/core/gameSteps/abilityWindow/TriggerWindowBase.ts`, `promptBatchResolution` / `onResolveAll`.

The original handler set `pendingBatchResolve` and immediately called `promptUnresolvedAbilities()`. If the grouped effects had become impossible because their cards had left play, that call exhausted the player order and returned `true` to indicate window completion. The prompt callback discarded the return value. The next pipeline continuation then asserted that a currently resolving player existed, crashing the match.

The fix removes the eager call. The callback records the batch selection, completes its prompt, and lets the regular `continue()` path resolve the group and observe window completion. It preserves individual trigger resolution, nested windows, player ordering, and all card effects. No choice is hidden or automatically replaced.

Reproduction: ASH Emperor Palpatine versus ASH Luke Skywalker, normal bot, seed `101`. Alphabet Squadron U-Wing attacks Bothan-5 carrying three Advantage tokens; after Luke's optional trigger, selecting `Resolve all (3)` previously raised `Contract assertion failure: Null-like object value: null`. The patched match finishes normally after 192 actions in eight rounds with three batch-resolution prompts.

Regression coverage:

- Upstream integration spec in `test/server/cards/08_ASH/tokens/Advantage.spec.ts`: `finishes a grouped window after the defender and its Advantage tokens have already left play`.
- App acceptance regression runs the actual ASH starter match with seed `101` and requires batch prompts and a completed game.
- Existing Advantage and simultaneous-trigger tests cover normal grouped resolution, single-instance choices, both players' groups, and nested triggers.

Verification: the complete upstream `Advantage.spec.ts` and `TriggeredAbilityWindow.spec.ts` suites pass together: **18 specs, 0 failures**, including the new regression. Reproduce with `npm run jasmine -- build/test/server/cards/08_ASH/tokens/Advantage.spec.js build/test/server/core/gameSteps/abilityWindow/TriggeredAbilityWindow.spec.js` from the built vendor directory.

The source change is preserved in the vendored tree and in `docs/patches/forceteki-grouped-trigger-completion.patch`. A normal engine build applies it because the patched source is compiled directly.
