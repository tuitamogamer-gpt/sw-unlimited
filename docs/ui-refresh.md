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
damage has a separate source-to-target presentation, healing uses green, and
lost shields use blue. Defeated units leave a short note in the arena divider.
The [physical reference notes](battle-visual-reference.md) document the sources
behind the compact token treatment.

Entry, healing, shield loss, and defeat feedback derive from successive public
board snapshots and the viewer's own hand. Damage instead uses native resolved
damage events, including the real source, target, and post-prevention amount.
Changing maximum HP does not produce a false hit. Each effect expires
independently; repeated hits receive new animation identities. Resume and
connection recovery suppress old effects.

Run `npm run test:motion-ui` after the build for real HTTP gameplay through card
entry, repeated native damage, base damage, and shield loss. The check verifies
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

Ambush now names its source unit and offers **Use Ambush / Skip Ambush**. The
source unit is also clickable while this choice is pending. Both the prompt and
target selection explain the exhausted attack; legal exhausted targets retain
their action label above the red status token. Native rules are unchanged; see
[Ambush](ambush.md).

Desktop pointer hover and keyboard focus show a compact card-art preview after
250 ms. Public card surfaces share one preview, including hand and arena cards,
leaders, bases, deck lists, imported decks, attachments, and the card library.
Previews stay inside the viewport, dismiss on interaction, and do not intercept
clicks. Touch devices, hidden cards, blocked actions, and the opponent spotlight
do not open hover previews. Reduced-motion preferences remove the entrance effect.

`npm run test:ambush-hover-ui` verifies a real Ambush attack, mobile source-card
activation, exhausted target labels, desktop previews and dismissal, touch
suppression, and portrait/landscape bounds. Reports and screenshots go to
`/tmp/swu-ambush-hover`. Engine regressions also cover Sentinel restrictions,
skipping, no eligible enemy, bot handling, and the HTTP prompt metadata.

Damage now has an ordered, 1.6-second presentation with source and target
artwork, directional bolts, impact flashes, and exact damage numbers. Both
combat directions share one exchange; the defender's return damage is labeled
explicitly. Ability, Overwhelm, and excess damage remain separate. Exchanges
with more than four hits use consecutive panels so no damage event is omitted.
Native plays and damage share an ordering counter, preserving the three-second
opponent spotlight in its proper place among damage effects.

The bounded public damage feed records actual damage after prevention. A
Shield-blocked hit does not show a false damage number. Public snapshots retain
cards that are subsequently defeated, including deployed leader artwork;
hidden sources remain anonymous. IDs and order survive checkpoint replay.
Input stays blocked during the queue, and refreshing skips past effects. The
board still uses public snapshots rather than reconstructing every intermediate
HP or zone change; the overlay explains each actual damage event. Aggregate
board damage is suppressed after the timeline to avoid showing the same hit twice.

`npm run test:damage-ui` verifies source attribution for ready and exhausted
2-power defenders while Vader is present, the 1.6-second timing, mobile bounds,
reduced motion, input locking, and refresh behavior. Reports and screenshots go
to `/tmp/swu-damage-presentation`.
