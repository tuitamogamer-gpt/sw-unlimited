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

Card inspection separates readable rules and current state from zoomable
artwork. It shows the card's current legal action and blocking reason, supports
leader faces, and lets players navigate attachments and captured cards. Pilot
upgrades display their active pilot text and stat bonuses. Deck inspection
supports searching, type filters, sorting, and a quantity-weighted cost curve;
closing a card returns to the same filtered deck list.

Short landscape screens place the hand and commands beside the battlefield.
Damage and new units receive brief visual feedback, and the latest public move
appears above the hand. Overflow cues appear only when a card row has hidden
content. Arena tabs support keyboard navigation. Replacing an unfinished game
requires confirmation.

The browser client writes a versioned checkpoint atomically and bounds both
network and response-body waits. An uncertain mutation triggers read-only
recovery, never an automatic mutation retry. A failed recovery requires a
refresh attempt before another action; storage failures produce a visible
notice. Cross-tab locking is used where available, but a game should still be
played in one tab.

Reproduce with `npm run build && npm run test:ui`. The test checks 375 × 667,
390 × 844, 430 × 932, 844 × 390, 1024 × 600, and 1440 × 900, plus the Serbian
interface at 375 × 667. It verifies loaded base images, two human card plays
(one through the inspector), artwork zoom, deck search retention, both arena
tabs, confirmation/cancellation, and resume after page refresh. It also drops
an action response after the HTTP server accepts it, verifies read-only
recovery, and checks that exactly one mutation was sent. Reports and
screenshots go to `/tmp/swu-ui-regression`, or `SWU_SCREENSHOTS` if set.

`npm test` covers engine, bot, metadata, privacy, legality, checkpoint, and
browser-client cases, including four focused human-flow regressions. The
Droid Deployment regression checks that its name does not cause its Play
action to be misclassified as leader deployment. `scripts/browser-smoke.mjs`
also drives a complete match through the visible interface and verifies that
the finished mobile battlefield does not overflow horizontally or vertically.

The [custom-deck import](custom-decks.md) and full card library have a separate
browser regression, `npm run test:custom-ui`. It verifies JSON file and text
imports, invalid counts, saved collections, both custom seats, a real card
play, and resuming after removing both local deck lists and evicting the
server's in-memory session. It also checks card-library search, filtering,
inspection, and mobile modal bounds.

Exhausted units keep upright grayscale artwork and a 12 px red token in a
reserved footer below the card face. Only the art is desaturated; action labels,
stats, and damage counters retain their colors. New units settle into the arena;
damage uses a brief impact pulse and rising red number, healing uses green, and
lost shields use blue. Defeated units leave a short note in the arena divider.
The [physical reference notes](battle-visual-reference.md) document the sources
behind the compact token treatment.

Feedback derives from successive public board snapshots and the viewer's own
hand. Damage uses changes to damage counters, so changing maximum HP does not
produce a false hit. Each effect expires independently; repeated hits receive
new animation identities. Resume and connection recovery suppress old effects.
This is visual feedback for observed state changes, not a chronological replay
of every intermediate rules event in a combined AI response.

Run `npm run test:motion-ui` after the build for real HTTP gameplay through card
entry, repeated unit damage, base damage, and shield loss. The check verifies
that the exhausted token stays below the artwork, effects expire, and reduced
motion keeps readable damage numbers without moving animations. It also checks
375 × 667 and 844 × 390 bounds. Reports and frames go to
`/tmp/swu-battle-motion`, or `SWU_MOTION_REPORT` if set.

Opponent plays and leader deployments now have a full-color spotlight before
placement. The engine emits an ordered, bounded public play history with
immutable printed card snapshots. Native resolved play events distinguish
actual plays from resources, discards, tokens, and control changes; events and
cards that already left play still have the correct public artwork.

Each spotlight stays for three seconds after its artwork or readable fallback
is ready. Image loading is bounded to 1.5 seconds. Multiple plays queue in order,
including replaying the same physical card. The underlying interface is inert
and action submission remains locked until the queue finishes. Each card is
revealed after its own preview; arena cards then receive normal entry feedback,
and mobile tabs follow their destination. The projection masks unshown cards
from the final server view; it is not a replay of intermediate rules states.

The authoritative checkpoint is saved before presentation starts. Refresh or
recovery shows the latest saved board without replaying old previews. Reduced
motion keeps the same reading duration without travel/countdown animation.
`npm run test:preview-ui` exercises real HTTP engine actions, measures single and
queued three-second previews, verifies blocked controls and image fallback,
and checks refresh during presentation and both mobile orientations. Reports
and screenshots go to `/tmp/swu-opponent-preview`.
