# Gameplay and mobile interface verification

The human flow is covered explicitly, without using the bot to choose human
actions: keep the starting hand, resource two expensive cards, confirm, play a
cost-one unit, receive the bot's response, claim initiative, optionally add one
resource, and play a cost-three unit next round. The checks exercise both the
engine and HTTP checkpoint protocol, and the same sequence through Chromium.

The interface now distinguishes Resource, Play, Attack, and target selection.
Effective costs include aspect penalties and card effects. Unavailable hand
cards expose a reason. Claiming initiative explains that the opponent may keep
playing after the human ends their own actions for the phase.

Both bases render their official artwork with health overlays. Mobile Ground
and Space tabs share the arena area. Commanders, the hand, and current decision
remain inside one viewport; extra choices, card inspection, and logs use
scrollable dialogs. Crowded card rows scroll horizontally within the board.

English is the default. Serbian Latin is selectable and saved between visits.
Official card names and printed card text stay in English. Earlier checkpoints
containing legacy interface wording remain readable through the translation
mapping.

Reproduce with `npm run build && npm run test:ui`. The test checks 375 × 667,
390 × 844, 430 × 932, and 1440 × 900, plus the Serbian interface at 375 × 667.
It verifies actual loaded base images, two human card plays, both arena tabs,
initiative confirmation/cancellation, and resume after page refresh. Reports
and screenshots go to `/tmp/swu-ui-regression`, or `SWU_SCREENSHOTS` if set.

`npm test` covers 76 engine, bot, privacy, legality, and checkpoint assertions,
including three focused human-flow regressions. `scripts/browser-smoke.mjs`
also drives a complete match through the visible interface and verifies that
the finished mobile battlefield does not overflow horizontally or vertically.
