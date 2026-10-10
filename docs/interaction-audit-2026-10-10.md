# Interaction audit — 10 October 2026

The audit found and corrected one native rules defect and two missing selection
indicators. The tested scenarios now pass. This is evidence for the covered
interactions, not proof of every possible combination of cards.

## Corrections

- **Yoda, Old Master / multiple-player choices:** selecting You, selecting
  Opponent, then deselecting You previously cleared both choices. Deselecting
  now removes only the clicked choice, so only the opponent draws after Done.
  The regression fails against the original handler and passes with the fix.
- **Visible menu state:** selected choices now retain a checkmark, highlighted
  button, and `aria-pressed` state. The adapter also supplies that state to the
  AI, whose existing policy avoids toggling already selected options.
- **Ordered card selection:** search choices such as U-Wing Reinforcement show
  their native one-based play order. Removing a selection renumbers the
  remaining cards; selecting it again appends it. The browser regression
  resolves Leia's intervening When Played ability and verifies actual play
  events follow the displayed order.

Existing encrypted checkpoints remain compatible. Historical actions reproduce
their original results; decisions made after resuming use the corrected rule.
Per-action revisions preserve mixed histories across repeated restoration.
The regression independently loads the original native bug in a child process
to produce a historical checkpoint, then compares both players' restored views.
Invalid actions cannot mutate a selection, and HTTP payloads cannot request
historical behavior. See [adapter details](engine-adapter.md) and
[the native patch](upstream-patches.md).

## Validation

- Complete patched upstream suite: **8,930 passed, 0 failed, 9 pre-existing
  pending**; no suite failures or excluded tests.
- Complete application suite after the fixes: **181 passed, 0 failed, 0
  skipped**, including four new native-menu and historical-replay regressions.
- Additional fixed-build matrix: **54 completed games / 7,471 legal actions**.
  Each of the 18 decks appeared in both seats at each difficulty; games ended
  in four to ten rounds with matching winners in both views. Every decision
  checked hidden-card privacy, arena consistency, legal actions, prompt/version
  progress, repeated positions, and warnings. No failures or stalls occurred.
  The run exercised six numeric, three dropdown, 32 stateful, 17 per-card,
  18 grouped-trigger, 170 optional-trigger, and 60 trigger-window prompt visits.
  Ordered searches were covered by the dedicated browser regression.
  Reproduction parameters: deck order from `readDecks()`, difficulty/seed/
  opponent-index offset **easy/4301/5**, **normal/5503/7**, **hard/6701/11**;
  opponent index is `(playerIndex + offset) % 18`. Both seats use the local
  policy through the public adapter, with fresh policy memory per game.
- All six existing browser suites passed: general UI, custom deck imports,
  battlefield motion, opponent previews, Ambush/hover, and chronological damage.
  The new seventh suite checks the actual Yoda menu and U-Wing ordered search
  through HTTP, native actions, and the rendered interface.
- New selection views fit **375 × 667** and **1440 × 900** without document
  overflow or browser errors. Existing UI checks also cover portrait and
  landscape sizes, base artwork, arena tabs, English/Serbian persistence,
  manual card plays, inspection, and recovery after a lost action response.
- A complete production browser game finished after **66 player choices in
  eight rounds**, including nine card plays, eight attacks, two abilities,
  leader deployment, ten AI plays, and refresh/resume. This baseline run used
  the pre-patch production build; targeted selection checks used the patched
  build.
- The patched production build also passed a fresh **19-choice** browser smoke
  with four manual plays and three AI plays. R2-D2's attack into Superlaser
  Technician resolved one outgoing damage and two return damage; the test
  observed the damage presentation and blocked controls during it. Language
  persistence, exact-version resume, and both mobile sizes passed with no
  browser errors. The owned test game was then deleted successfully.
- Deck and catalog checks passed: **18 supported preconstructed decks**, **2,600
  normal card printings**, **2,579 complete playable entries**, and **21
  incomplete entries blocked from play**. This audit did not expand the card
  implementation inventory.
- TypeScript and the production Vite build passed.

Reproduce the application checks from the repository root:

```sh
npm run engine:setup
NODE_OPTIONS=--no-experimental-require-module npm test
npm run cards:check
npm run cards:catalog-check
npm run build
npx playwright install chromium
npm run test:ui
npm run test:custom-ui
npm run test:motion-ui
npm run test:preview-ui
npm run test:ambush-hover-ui
npm run test:damage-ui
npm run test:menu-ui
```

Run the complete upstream suite separately with `npm test` from
`vendor/forceteki`. Its test build also compiles server files, so do not rebuild
that directory while another validation process is using it. The audit used an
isolated build and three Jasmine workers.

## Remaining upstream coverage gaps

Eight card cases were already disabled with `xit` in the vendored suite; the
ninth is an intentionally disabled debugger/performance suite. These scenarios
were not established as passing by this run:

| Card / case | Existing pending scenario |
| --- | --- |
| Corvus, Inferno Squadron Raider | Preserve cards captured by a pilot when Corvus takes that pilot. |
| Krayt Dragon | Nested When Played / Krayt triggers with Yoda resolving last. |
| L3-37, Get Out of My Seat | Preserve cards captured by a pilot after L3-37's replacement effect. |
| Latts Razzi, Deadly Whipmaster | Krayt Dragon uses last-known information from the deck. |
| Luke Skywalker, You Still With Me? | A pilot returns to its owner's ground arena after control changes and defeat. |
| Migrate | Fewer than three resources when calculating Beast tokens. |
| Oppo Rancisis, Ancient Councilor | Oppo and Clone do not grant Restore to each other. |
| Reckless Torrent | Damage an enemy unit with no friendly unit in that arena. |
| Republic Attack Pod / Undo | Detached ongoing cost reduction in the disabled performance investigation. |

Passing the active suite does not resolve these pending cases or exhaustively
test every cross-set interaction.
