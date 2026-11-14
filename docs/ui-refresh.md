# Gameplay and mobile interface verification

Both classic and fan hands provide previous/next controls when cards overflow.
Arrow keys, Home and End move focus without submitting a game action, including
when starting from a card's inspect button. I opens that card's details and
closing the inspector restores focus. Reopening the fan returns to the last
focused card, or the first remaining card if it has left the hand.
`npm run test:hand-ui` checks these interactions with real engine checkpoints,
resource selection, Ambush, and training completion on desktop and mobile,
including 667 × 375 and 844 × 390 landscape layouts.

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

Exhausted units keep upright grayscale artwork and a compact red token (12 to
18 px, scaling with the card) in a reserved footer below the card face. Only the art is desaturated; action labels,
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
artwork, impact flashes, and exact damage numbers; see *Combat animation* below
for how each exchange is staged. Both combat directions share one exchange; the
defender's return damage is labeled explicitly. Ability, Overwhelm, and excess
damage remain separate. Exchanges with more than four hits use consecutive
panels so no damage event is omitted.
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

## Interface polish

The lobby has its own fluid stylesheet (`src/lobby.css`). Type sizes and spacing
use `clamp()` instead of per-breakpoint pixel overrides, so labels no longer
shrink to 5–8 px on phones. Deck tiles, mission portraits, collection rows, the
deck inspector and battle leader tiles zoom into the illustration half of the
landscape leader card rather than showing a cropped card with unreadable rules
text; the hero shows both leader cards whole. Card images share one component
with a quiet placeholder while loading and a short fade when a late image
arrives.

Selecting a seat in the mission panel scrolls to the deck archive. Once the
mission panel has scrolled out of view, a launch bar shows the matchup and a
**Start battle** button (labelled *Start battle with the selected decks* for
assistive technology, so the main button keeps a unique name). The header
status light reports the deck catalog: connecting, online, or offline. Notices
stack in one corner instead of overlapping, and collection confirmations clear
themselves after six seconds; connection and recovery notices stay until
dismissed.

In battle the lobby header is no longer repeated above the table. One top bar
carries back, round and phase, account, log, help, language, settings and new
game on every screen size. Arena lanes are size containers: a unit is as tall
as its lane allows (up to 236 px), narrows when two to eight units share the
lane, and never exceeds the lane, which removes the clipping seen at 1024 × 768.
Names, stats, cost, damage counters and the Exhausted token scale with the card.
Browsers without container units keep the previous fixed sizes. Small labels
follow a stepped type scale (`--type-micro`, `--type-label`, `--type-chip`,
`--type-note`) defined in `battle-polish.css`. **Compact cards** scales hand
cards to 84 % and caps units at 128 px.

Leader tiles show a portrait with the leader's name and state (Leader,
Exhausted, Deployed); narrow tiles overlay the name on the portrait. A selected
card is marked in the middle of its artwork, clear of the cost and inspect
corners. Resource and discard piles no longer reuse hand labels: resources show
Ready or Exhausted, and discarded cards have no action label.

Dialogs share one shell with a short rise animation, consistent corner radii,
pill switches, a single-column rules layout on phones and a full-width latest
decision in the battle log. Inspector, import, catalog and account text was
raised to at least 9–10 px, and confirmation dialogs lay out two equal choices.
Text fields use 16 px on touch devices so iOS does not zoom the page on focus.
The app ships a favicon, a touch icon and social metadata.

Reproduce with the same suites listed above; `npm run test:ui` additionally
covers the 1024 × 600 and 1440 × 900 single-bar layouts.

## Combat animation

Each damage exchange is a short duel on a stage above the dimmed table
(`src/components/DamagePresentation.tsx`, `damage-presentation.css`). The two
cards face each other across a gap of known width, so motion is exact at every
size: the attacker winds up for about 140 ms, crosses the gap in about 120 ms
and returns; a card that is only hit recoils; and when both cards deal combat
damage they meet in the middle. Impact, at about 430 ms, brings a flash, a ring,
sparks, a slash for combat, a short shake of the stage, and the damage number.
Ability, Overwhelm and other non-combat damage keep their source in place and
send a projectile across the gap instead. Several sources or targets use one
row per real hit, and the rows land one after another.

Everything shown is read from the native damage events. Each event's card
snapshot is taken after its own hit and before a defeated card leaves play, so
the health line shows the earlier value struck through beside the real value
that follows it, with no estimation. A unit at zero health is stamped
**Defeated** only if it is also absent from both arenas once the whole response
has resolved; a base at zero is stamped **Destroyed**. The dot beside each role
uses the same colours as the two command labels on the table. The dimming stays
in place for a run of consecutive hits and lifts with the last one.

On the table (`battle-motion.css`, `src/battle-duel.ts`) the real participants
are ringed while their exchange plays: gold for a card that strikes, red for a
card that is hit, gold turning red for a card that does both. Outlines of legal
choices are muted meanwhile, because that choice has already been made. When
the table catches up, a damage counter lands on its card like a token being put
down, the health value shows that it changed, base health counts down, and a
defeated unit keeps its place for about three quarters of a second while it is
shown leaving, after which the lane closes up. No second hit is played on the
table and no aggregate damage number returns.

Impact scales with the hit. Five damage or more, or a hit that removes a card,
shakes the stage further, brings the number in larger and echoes the ring. When
the viewer's own base is the target, a red vignette pulses at the edges of the
screen at the moment of impact.

Around the exchanges the table marks its own rhythm. When an action phase
begins, a band with the round number sweeps open across the arenas for a second
and a half and the round number in the top bar ticks over; it is decoration
over that label, takes no input and is hidden from assistive technology. The
initiative token rings when it changes hands, resource pips fade between spent
and ready, and a deployed leader enters with a gold rim. The end-of-game dialog
lands its emblem first and then its words, with slow rays around a win. None of
these runs when a game is loaded or resumed (`useRoundCue` and `useRise` in
`src/battle-feedback.tsx` only react to a change they have seen happen).

Every element rests in its final, readable state and the keyframes only describe
how it gets there. With `prefers-reduced-motion` nothing moves: the exchange
shows its result at once, the rings are static, and a defeated unit simply
leaves. The 1.6-second timing, the event order and the input lock are unchanged.

`tests/battle-duel.test.cjs` covers which cards are marked, and
`tests/battle-feedback.test.cjs` covers which units are shown leaving and when
a round is announced. The
`test:damage-ui` and `test:motion-ui` suites above run against the new
presentation without changes.

## Premium layer

`src/premium.css` is imported last and changes only how surfaces are painted.
Sizes, spacing and structure stay with the stylesheets before it, so every
layout rule the UI suites measure is untouched. It adds one material system:

- **Atmosphere.** The lobby sits in deep space: film grain, three sparse star
  fields with unequal periods so no pattern repeats in view, and faint light
  from the edges. The battle table is calmer, with grain and a pool of light
  under the arenas.
- **Depth.** Panels use a top-lit gradient, a one-pixel inner highlight and one
  of three elevation shadows. The mission console, training panel, hand tray
  and dialogs have a rim that catches gold at one corner and cyan at the other.
- **Gold as a material.** Primary buttons have a lit top edge, a darker foot
  and a sheen that crosses on hover. Headline accents, the round number and the
  selected deck use the same gradient.
- **Sides read by colour.** The opponent's half of each arena takes a little red
  from its far edge and yours a little teal, and commander tiles are rimmed the
  same way. Cards that can be used now have a clearer ring than before.
- **Motion.** The two leader cards in the hero drift a few pixels and catch a
  sheen, the hero text arrives in order, deck tiles lift and bloom on hover, and
  the table fades in when a battle opens. Entrance animations fill backwards
  only, so they leave no layer behind. With reduced motion none of them run.

Gradient lettering falls back to plain text when colours are forced. Small
per-card controls do not use backdrop blur, which keeps a crowded table cheap to
paint.

The page shows a small emblem and a loading line from the first byte until the
app has mounted (`index.html`), so it is never blank on a slow connection.

Three details were corrected in the same pass. The option dialog now names what
is asking, taken from the prompt's own subtitle, and opens that card when
exactly one visible printing carries the name. Choosing a number has a stepper
and direct picks for ranges of up to 21 values; `#prompt-number` and the single
button inside `.number-prompt` are unchanged for the suites that drive them.
An upgrade in the card inspector shows the power and health it adds instead of
a unit's power and remaining health, and the deck inspector's base tile shows
the illustration rather than the card's title bar.
