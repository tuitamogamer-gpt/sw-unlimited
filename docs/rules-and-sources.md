# Star Wars: Unlimited — rules and sources

Researched: 2026-10-08 (session date). Rules baseline: **official Comprehensive Rules 9.0 currently linked by the official site**, with an important date discrepancy: its cover says **10/9/26** (2026-10-09), one day after the session date. The application pins Forceteki commit `1f0e9783c4743acdc67df0c4ab3f3610a349c32a`; see [rules-version.md](rules-version.md) for the actual inspected behavior and version limits. Retrieval success establishes what is publicly linked, not when tournament enforcement begins.

## Actual application rules baseline

The application uses the vendored **Forceteki engine at commit `1f0e9783c4743acdc67df0c4ab3f3610a349c32a`**. The research below records implementation requirements and rule interpretations; it is **not a claim that every feature, every card or every interaction has been independently validated** in this application.

Source inspection confirms two especially important current-rule behaviors: Ambush directly allows an exhausted unit to attack without readying it, and shield prevention suppresses Overwhelm damage to the enemy base. The upstream Overwhelm test source explicitly asserts the second case. This research task inspected those test assertions but did not execute them. The application's executed checks are documented by its implementation/test workflow.

The official site already serves CR9 while its cover is dated the following day. This report does not claim CR9 tournament effective status on 2026-10-08. There is no legacy-rules selector or automatic claim that old forum answers match the pinned engine.

## Source hierarchy and provenance

1. **Official rules hub / errata / suspended list**: https://starwarsunlimited.com/how-to-play?chapter=rules — full page fetched through Firecrawl with maxAge 0. A full research snapshot was retained under `/workspace/research/official-rules-page.md` during implementation.
2. **Official CR 9.0 PDF**: https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v9_0_c4aa591948.pdf — directly downloaded and extracted with pdftotext. Downloaded research files: `/workspace/research/comprehensive-rules-v9.pdf` and `/workspace/research/comprehensive-rules-v9.txt`. The authoritative portable reference is the linked official PDF.
3. **Official first-set Quickstart**: https://images-cdn.fantasyflightgames.com/filer_public/36/f6/36f6e0a5-a7a9-4cbe-8d73-70e61fe6f548/sw_unlimited_quickstart_rules.pdf
4. **Official set-two Quickstart**: https://cdn.starwarsunlimited.com//Quickstart_Rules_Set_2_271c735e17.pdf
5. **Official set-three Quickstart**: https://cdn.starwarsunlimited.com//Quickstart_Rules_Set_3_EN_e3609d68ab.pdf
6. **Official basic teaching page**: https://starwarsunlimited.com/how-to-play?chapter=how-to-play
7. **Cascade Nexus judge clarifications**: https://nexus.cascadegames.com/resources/Rules_Clarifications/ — full page fetched; research snapshot `/workspace/research/judge-clarifications.md`. Explicitly describes developer answers as subject to change; distinguish individual quoted FFG rulings from unofficial explanations.
8. **Forceteki engine**: https://github.com/SWU-Karabast/forceteki — public TypeScript implementation, MIT license, based on Ringteki; readme fetched (research snapshot `/workspace/research/forceteki-overview.md`). An engineering reference and candidate reusable engine, not the rules authority.

Reddit/BGG were actually searched; see the community section below. Reddit full-page scrape calls returned INVALID_ARGUMENT errors, and BGG full pages often exposed only metadata/navigation. The report therefore identifies community excerpts as excerpts and verifies conclusions in CR9.

## Core implementation contract

- One legal action per turn, alternating players; actions are Play a Card, Attack, Use Action Ability, Take Initiative, Pass. No Magic-style response stack and no opponent interrupt window between paying a card and resolving its effects.
- Keep all legality in one engine shared by player controls and AI. The AI must use legal actions and legal choices, never UI-only mutation shortcuts.
- A card-data import is not an ability implementation. Use explicit ability scripts with defined triggers, restrictions, costs, effects, and prompts. Maintain a coverage registry showing supported / unsupported cards and never silently ignore an unsupported card text.
- Persist phase, round, action owner, initiative holder plus available/taken status, all card instances/zones/owners/controllers, damage, exhaustion, attached upgrades, captured cards, temporary effects and their expiry, once-per-round usage, epic-use flags, pending choices, and nested trigger windows.
- Card ownership and control are distinct. Cards leaving play ordinarily go to their owner's appropriate zone.
- Never expose the human hand/resource faces/deck order to the AI unless a resolved ability grants that information. Counts and public revealed/captured/discard information are available.

## Setup, action phase and regroup

CR5.2:
1. Put bases into play; put leaders in base zones on their leader faces.
2. Randomly choose a player who decides who starts with initiative.
3. Shuffle, draw 6 each.
4. Initiative player chooses first whether to mulligan the entire six-card hand. One mulligan, shuffle hand back and draw 6; second hand must be kept. Then opponent decides.
5. Each chooses exactly two opening-hand cards as ready facedown resources.
6. Begin round one action phase. There is no opening draw beyond setup.

CR1.15, CR5.4:
- Initiative holder takes the first action each round.
- A normal pass forfeits just the current action. A player who passed may act again if the opponent takes an action.
- Two consecutive passes finish the action phase.
- Claiming initiative is available once per round; a player may claim while already holding it. Claiming counts as a pass and permanently passes all their remaining turns that action phase.
- Claiming immediately after an opponent pass ends the phase.
- If nobody claims, the previous holder retains initiative.
- A claimant still resolves triggered abilities and required choices.
- Non-pass actions must change game state; paying a cost or moving a card can itself satisfy this even if its effect has no eligible targets.

CR5.5, in order:
1. Resolve start-of-regroup triggers and expirations.
2. Both players draw 2.
3. Starting with the active player, each may resource at most one hand card, facedown/exhausted. Skipping is legal.
4. Ready all exhausted controlled units, resources and leaders.
5. Expire end-of-regroup/end-of-round effects; begin next action phase and mark initiative available.

CR8.6: a draw from an empty deck deals 3 damage to that player's base per undrawn card; running out of cards does not itself lose. Deck searches/discards from an empty deck do not cause draw damage. Damage persists across phases.

## Playing cards and costs

CR6.2:
1. Declare the card and mode (unit / upgrade when relevant).
2. Check play/attachment restrictions.
3. Determine costs: base/alternate cost, increases including aspect penalties, then reductions; minimum resource cost is zero.
4. Pay all costs, rollback if all costs cannot be paid.
5. Unit enters correct arena exhausted; upgrade attaches to an eligible target; event moves to discard before resolving its text.
6. Resolve resulting triggers only after the play/effect finishes, subject to nested action rules.

- Add **2 resources for each missing aspect icon**, matching icon multiplicity from leader plus base (CR8.1). Two same-color icons require two provided icons. Aspects are not resource colors.
- Playing “for free” bypasses resource costs and aspect penalties, but not non-resource additional costs.
- Referenced printed card cost is distinct from actual amount paid.
- Events may be played even if their effects can do nothing; upgrades require an eligible attachment at legality check. Eligible targets are selected when that effect resolves, not globally preselected before all earlier effects.
- Resolve as much as possible, in text order. “Then” and “if you do” need distinct dependency semantics. “Up to” allows zero; optional “you may” must offer decline.
- Each play/re-entry is a new rules object for lasting effects; instance identity should not incorrectly preserve prior modifiers.
- Ordinary units cannot attack on entry because exhausted, but this is not a summoning-sickness flag: an effect that readies them can allow attacks.

## Combat

CR6.3:
- Attacker normally must be a ready controlled unit; select an enemy unit in its arena or enemy base. No defending choice/block assignment by the opponent.
- Enforce Sentinel in the attacker's arena, attack restrictions, and Saboteur exceptions when selecting the defender.
- Begin attack/exhaust attacker; activate “while attacking/defending” modifiers.
- Resolve On Attack and On Defense triggers in the same trigger window before combat damage, including Restore and Saboteur.
- Calculate current powers immediately before combat; defender and attacker normally deal damage simultaneously. Bases do not retaliate.
- Defeated units leave immediately; do not allow a unit with lethal damage to stay as an attack target.
- If defender leaves before combat, no combat damage is dealt unless the attacker has Overwhelm. If attacker leaves, combat cannot proceed.
- Snapshot simultaneous damage values before applying them, so ordinary Grit does not amplify retaliation from damage received in that same exchange.
- First-damage effects change this: a surviving Grit defender does benefit from damage received before its own combat-damage step.
- Triggered ability damage during combat is not combat damage. “Dealt combat damage to a base” differs from “attacked a base.”
- Resolve attack-completion triggers and nested effects before returning to the parent action and changing turn.

## Keywords and mechanics

All below checked against CR9; do not blindly reuse launch-era reminder text.

| Mechanic | Required behavior |
|---|---|
| Ambush, CR7.5.5 | On play/deploy/create, may attack an eligible enemy unit even while exhausted. It does **not ready** the unit. Cannot target base. If no legal enemy unit exists, no attack. Does not stack. |
| Shielded, CR7.5.12 | On play/deploy/create, create a Shield token. Shares timing window with other enter triggers; controller chooses ordering. |
| Shield token, CR3.7.6 | Prevent one damage instance and defeat one shield. Multiple shields do not all disappear from one damage instance. Tokens are upgrades but creating/giving one is not playing an upgrade. |
| Overwhelm, CR7.5.7 | Excess combat damage goes to defender controller's base simultaneously. Under this baseline, if defender would not be defeated (including a shield preventing damage), **no excess goes to base**. If defender leaves before combat, all attacker combat damage goes to base. Does not stack. |
| Sentinel, CR7.5.11 | Protects non-Sentinel units and base only from attackers in same arena. Multiple Sentinels allow choosing any one. A Sentinel may be attacked despite a “can't be attacked” ability. |
| Saboteur, CR7.5.10 | May ignore Sentinel when selecting target; On Attack destroys every Shield on chosen defending unit. Does not globally remove Sentinel or shields elsewhere. |
| Raid X, CR7.5.8 | +X power only while attacking; numeric instances add. Recompute if gained/lost during attack. |
| Restore X, CR7.5.9 | On Attack heal own base X; instances add, resolve before combat; cannot heal below zero damage. |
| Grit, CR7.5.6 | +1 power per damage counter; instances do not stack. Damage is not subtracted from printed HP. |
| Bounty, CR7.5.13 | Opponent may resolve when defeated/captured, including when owner sacrifices own bounty unit. Multiple bounty abilities are independent. Capture triggers bounty but is not defeat. |
| Smuggle, CR7.5.14 | Play from own resources for alternate smuggle cost plus relevant aspect penalties. The resource being smuggled can help pay its own cost. Replace it with top deck card as exhausted resource. Empty deck: no replacement and no draw damage. Still a play; relevant When Played triggers fire. |
| Coordinate, CR7.5.15 | Conditional ability active while controller has 3+ units; constantly reevaluate after additions/removals/control changes. Keyword still exists below threshold. |
| Exploit X, CR7.5.16 | During cost determination defeat up to X friendly units, reducing cost by 2 each; numeric instances add. Resulting defeat triggers wait until card-play action completes. |
| Piloting, CR7.5.17 | Alternate play as upgrade onto friendly Vehicle without a Pilot upgrade, using alternate cost/aspects. Not a unit while attached. Normal out-of-play unit classification still matters for searches. |
| Hidden, CR7.5.18 | Cannot be attacked if played/deployed/created that phase; Sentinel overrides this protection. |
| Plot, CR7.5.19 | On leader deploy may play eligible resource Plot cards paying costs, replace from deck exhausted. Identify/reveal the Plot cards triggered from resource zone at deploy; newly drawn replacement Plot cards do not also trigger. Resolve each play and nested triggers before next. |
| Support, CR7.5.20 | On play/deploy/create may attack with another unit; that unit gains source's other abilities for attack. Nested attack resolves completely before pending sibling triggers. Does not stack. |
| Fortify, CR7.5.21 | Upgrade attaches to own base instead of a unit; base upgrades have distinct target eligibility. |
| Capture/rescue, CR8.33 | Captured unit leaves play; remove damage, defeat upgrades, place publicly inspectable facedown under guard. Rescue when guard leaves; returns exhausted under owner, enters play but is not played. Captured token goes set aside. |
| Indirect damage, CR8.35 | Chosen player allocates among own units/base. Cannot assign more to a unit than remaining HP. Damage unpreventable, ignores shields without destroying them, all applied simultaneously. |
| Force, CR8.37 | At most one Force token per player. “The Force is with you” creates token; “Use the Force” defeats it, requires owning one. |
| Disclose, CR8.38 | Reveal hand cards collectively covering required aspect icons; check multiplicity; revealing more than necessary is allowed. |

## Leaders, upgrades and state maintenance

- Deploying usually checks total resource count, not unexhausted resources and not spending that count. Follow specific leader text.
- A leader may use its exhaust action and later deploy while exhausted; deployment enters ready. Deploying is not playing (CR3.4.4).
- Epic Action use is once per game, including after leader defeat. Defeated leader returns leader-face-up to own base zone exhausted; do not discard.
- A leader moving to an out-of-play zone or changing controller is defeated instead, unless a specific exception applies.
- Leader unit is still a unit; “non-leader” target restrictions exclude it.
- Only currently faceup leader abilities are active.
- Upgrades leaving because their host leaves are defeated simultaneously with that host leaving under CR9. Cascade explicitly calls out correcting the earlier state-maintenance wording (notably Zeb interactions).
- Experience supplies +1/+1 each. Removing an HP upgrade can cause immediate defeat.
- Unique restriction is per controller and exact name **plus subtitle**, across unit/upgrade modes. Same name with different subtitle is allowed. Owner chooses which duplicate to defeat, and play/defeat triggers still occur.
- State-maintenance priority CR1.16.5: base defeat/loss, resolve unique duplicates, rescue units whose guard left, defeat units with zero remaining HP; repeat until stable.
- Simultaneous base destruction is a draw (CR5.6); evaluate damage batches atomically.
- No fixed board-slot cap or maximum hand size. No resource cap. Unlimited token supply.

## Trigger/effect ordering: must be represented, not flattened

CR7.6:
- Trigger captures whether condition happened; it can still resolve after its source leaves.
- Triggered abilities mandatory unless optional wording.
- Controller orders own simultaneous triggers.
- If both players have simultaneous triggers, **active player chooses which player resolves their entire group first**; each owner orders their own group.
- Nested triggers produced while resolving a trigger resolve before returning to siblings from earlier window.
- “When Played”, Ambush, Shielded share a window, but keyword abilities are not literally When Played abilities when a card copies a When Played ability.
- “After completing this attack/play” waits for the nested action and its trigger tree to finish.
- Check choices/targets as effect resolves; do not cache now-invalid targets from before previous trigger resolution.
- Expiring HP modifiers can defeat units; continuous effects and state checks must run before next choice/action.
- “Can't” beats “can/may” except defined special exceptions (Sentinel attackability, unpreventable damage).

## Errata

The full official list and exact card identifiers are on the linked official rules hub (research snapshot `/workspace/research/official-rules-page.md`). Apply corrected text over stale image/API text, preserving original text for display if useful. Particularly relevant core/starter-era fixes:

- Blizzard Assault AT-AT (SOR 88): excess damage may go to an enemy ground unit.
- Bo-Katan Kryze (SHD 12): On Attack first optional 1 damage, then a conditional second optional 1 if another Mandalorian attacked this phase; same/different unit allowed.
- Migs Mayfeld (SHD 163): player discarding from a hand, optional 2 damage, once each round.
- Millennium Falcon (SHD 204): Ambush gained for phase if played from hand.
- Unrefusable Offer (SHD 226): bounty can play from owner's discard **or capture** under claimant's control, ready, then defeat at start regroup.
- Count Dooku (TWI 5): leader action plays Separatist from hand with Exploit 1 for phase.
- I Have the High Ground (TWI 72): while chosen friendly unit defends this phase, attacker gets -4/-0.
- Aayla Secura (TWI 96): corrected traits include Twi'lek.
- Sly Moore (TWI 211): take/ready enemy token, owner regains at start regroup.
- Brain Invaders (TWI 255): non-upgrade leaders lose abilities except epic actions and cannot gain abilities.
- Admiral Yularen (JTL 47): chosen keyword applies to Vehicles controlled or played while source stays.
- Wingman Victor Three (JTL 86): when played as upgrade, optional Experience to unit other than attached unit.
- Third Sister (LOF 10): next unit played this phase gains Hidden for phase.

Later entries exist through Homeworlds; import should retain all official overrides. Official fetched suspension list: Premier Cad Bane (Ashes of the Empire 11); Twin Suns/Eternal none. Starter casual mode should clearly distinguish chosen deck/rules mode from tournament legality, especially if older sets rotate.

## Reddit and BoardGameGeek specifics

Community sources find realistic failure cases; official rules settle them.

1. Reddit “When vs After: Clarification on Shielded & Ambush”:
   https://www.reddit.com/r/starwarsunlimited/comments/1cfi4jc/when_vs_after_clarification_on_shielded_ambush_re/
   Search excerpt says Ambush and Shielded share a timing window, so shield can be given after ambush attack. Verified CR7.6.13b and CR7.5.5f. If unit dies in ambush, it cannot receive a shield out of play. Full scrape unavailable.
2. Reddit “Order for Ambush & When played”:
   https://www.reddit.com/r/starwarsunlimited/comments/1bmwkpw/order_for_ambush_when_played/
   Excerpt discusses same controller-selected ordering; use for regression scenario. Full scrape unavailable.
3. Reddit “Questions about overwhelming 0 health units”:
   https://www.reddit.com/r/starwarsunlimited/comments/1guouwr/questions_about_overwhelming_0_health_units/
   Excerpt asks whether lethal pre-attack damage leaves a unit available to attack. Answer from current CR: zero-remaining-HP units are immediately defeated and cannot be selected for a later attack. Distinguish defender removed after an attack has already begun, which lets Overwhelm hit base.
4. BGG “Overwhelm vs Shielded Unit”:
   https://boardgamegeek.com/thread/3269976/overwhelm-vs-shielded-unit
   Metadata confirms exact question, but full replies unavailable. **Historical answers may conflict with current rules:** CR9 7.5.7e explicitly says shield preventing combat damage also prevents Overwhelm damage to base. Version pinning is essential.
5. BGG “How exactly does the Mandalorian (leader) work?”:
   https://boardgamegeek.com/thread/3343267/how-exactly-does-the-mandalorian-leader-work
   Search excerpt: The Armorer/Shielded gives a token, so it does not trigger abilities requiring playing an upgrade. Verified current CR3.7.2. Metadata date 2024-08-01; full replies unavailable.
6. BGG “Status of captured cards when rescued”:
   https://boardgamegeek.com/thread/3611784/status-of-captured-cards-when-rescued
   Search discovery only. Resolve by CR8.33: exhausted, owner control, new object, not a play.
7. BGG “Star Wars Unlimited Solo Mode: Simulate an AI Opponent for Any Deck”:
   https://boardgamegeek.com/thread/3533191/star-wars-unlimited-solo-mode-simulate-an-ai-oppon
   Metadata links author rules at https://docs.google.com/document/d/1zqbqwb41oDBkoVjuYwVCsEVRKHrQi8KJgb2_srV6Bqw/edit?usp=sharing . Not reviewed in full; do not claim its algorithms adopted.
8. BGG “SWU Streamlined, Simple Solo Variant You Can Play Right Now”:
   https://boardgamegeek.com/thread/3363377/swu-streamlined-simple-solo-variant-you-can-play-r
   Search excerpt describes initiative/pass behavior. Solo variants can inspire policies, but automated 1v1 bot should follow actual two-player rules.

## AI decision requirements

Use a rules-compliant game engine and a policy operating on the bot's visible observation.

- Opening hand/mulligan: evaluate playable first two turns, curve, synergy with leader, arena distribution, resource candidates.
- Resourcing: retain a plan for next turns; price duplicates, near-term affordability, answer value, synergy, smuggle/plot value and remaining resource threshold for leader.
- Candidate generator: cards with all legal modes/targets/cost choices, attacks against every legal target, abilities, deploy, pass/initiative, trigger ordering, optional effects, indirect allocation.
- Priority: immediate lethal; prevent opponent known-board lethal; exploit profitable removal/trades; deploy timing; develop board/tempo; value card advantage; evaluate initiative race.
- Evaluate health using damage/race risk, units by threat and survivability (not cost alone), readiness, future resource curve, hand value, arena advantage, buffs/auras, sentinel walls, shields, keywords and remaining epic abilities.
- For stronger level, look ahead across alternating opponent turns with beam-limited search; use sampled unknown opponent hands/deck order, not hidden truth. Sample from public decklist only when decklist is declared open.
- Explanations should derive from policy scores and chosen tactical objective, e.g. “removes ready attacker to prevent lethal,” rather than pretending the AI used a language model.
- Deterministic seeded randomness is useful for replaying/debugging games. Avoid arbitrary action caps that silently corrupt rules; detect repeated states and fail visibly in debug mode.

## Regression scenarios worth implementing

1. Pass, opponent acts, original passer acts again; double pass; claim after pass; claim blocks further actions but not triggers.
2. Two draws with one deck card gives one card plus 3 base damage; with zero gives 6; lethal draw stops game.
3. Exhaust leader action then deploy ready; defeated leader keeps epic-used flag.
4. Sentinel arena-local restriction; Saboteur ignores it and destroys defender shields before damage.
5. Multiple shield tokens consume exactly one per damage instance; unpreventable indirect damage leaves shields attached.
6. Current-version shield blocks Overwhelm to base; removed defender during On Attack sends full Overwhelm to base.
7. Shielded/Ambush ordering can change outcome; nested death triggers finish before remaining enter triggers.
8. Grit simultaneous combat does not increase current retaliation; first-damage exception does.
9. Experience/temporary HP removal defeats damaged unit immediately.
10. Exploit defeat triggers resolve after new unit's play action, allowing interaction with entered card.
11. Capture/rescue removes upgrades/damage, rescues exhausted without When Played; bounty still triggers capture.
12. Smuggle pays with its own resource, substitutes new exhausted resource, no draw damage if deck empty.
13. Coordinate activates/deactivates immediately at third-unit changes.
14. Unique same name+subtitle choice, different subtitle legal, cross unit/pilot duplicate checked.
15. Played upgrade versus created Shield/Experience token distinction for The Mandalorian.
16. Costs apply +2 per missing aspect, reductions after penalties, and “free” handles penalties correctly.
17. Each starter card has an explicit support entry and ability scenario; imports with unknown IDs fail validation.

