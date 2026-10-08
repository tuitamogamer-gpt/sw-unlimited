# Pinned rules behavior

- **Engine:** [SWU-Karabast/forceteki](https://github.com/SWU-Karabast/forceteki), MIT license.
- **Pinned commit:** [1f0e9783c4743acdc67df0c4ab3f3610a349c32a](https://github.com/SWU-Karabast/forceteki/tree/1f0e9783c4743acdc67df0c4ab3f3610a349c32a).
- **Research date:** 2026-10-08.
- **Official reference:** [Comprehensive Rules 9.0](https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v9_0_c4aa591948.pdf), cover dated **2026-10-09**.
- **Official rules/errata hub:** https://starwarsunlimited.com/how-to-play?chapter=rules

The official hub already linked CR9 when researched, although its cover date is one day after the session date. The application uses the pinned engine implementation. This documentation does not claim that CR9 was already tournament-effective on 2026-10-08 or that every current ruling has been independently verified.

## Behavior inspected in the pinned engine

| Interaction | Implemented behavior and evidence | Official reference |
|---|---|---|
| Ambush | Allows an exhausted attacker directly; no ready effect is performed. Triggers on play, leader deployment and token entering play. Ordinary Ambush targets units; a specific card effect can permit a base. [AmbushAbility.ts](../vendor/forceteki/server/game/abilities/keyword/AmbushAbility.ts) uses `allowExhaustedAttacker: true`. Some upstream test titles retain older “readying” wording; the implementation is authoritative for this build. | CR9 7.5.5 |
| Shield + Overwhelm | Shield replaces/prevents the defender damage event, so it does not generate excess damage to the base. [Shield.ts](../vendor/forceteki/server/game/cards/01_SOR/tokens/Shield.ts), [AttackFlow.ts](../vendor/forceteki/server/game/core/attack/AttackFlow.ts). Existing upstream [Overwhelm.spec.ts](../vendor/forceteki/test/server/core/abilities/keyword/Overwhelm.spec.ts), “CASE 2: shield prevents overwhelm,” expects zero base damage. | CR9 7.5.7c/e |
| Shielded | Creates a shield on play, deploy or token entering play; separate from playing an upgrade. [ShieldedAbility.ts](../vendor/forceteki/server/game/abilities/keyword/ShieldedAbility.ts). | CR9 7.5.12, 3.7.2 |

These findings are **source inspection and existing-test inspection**. This research task did not run the upstream tests; do not equate the presence of a test with a successful execution. Application test results and card/deck coverage should be reported separately.

## Source access and limits

- Official rules hub: full live page fetched via Firecrawl; official PDF downloaded and text extracted.
- Cascade Nexus: full judge-clarification page fetched. Its own disclaimer says rulings are subject to comprehensive-rules updates; it also includes unofficial explanations.
- Reddit: search excerpts retrieved for specific Ambush/Shielded/Overwhelm questions. Full-page scrape attempts returned `INVALID_ARGUMENT`; no unseen replies were treated as evidence.
- BoardGameGeek: search excerpts and question metadata were retrievable. Full-page fetches often returned only navigation/metadata, so complete reply threads were not reviewed.
- Old Reddit/BGG answers may describe earlier rules, particularly Shield versus Overwhelm. Current-rule conclusions above come from the official PDF and pinned engine, not forum consensus.
- No older CR8 official URL/effective-date comparison was established during this research.

[Detailed rule requirements, errata notes, community URLs and regression scenarios](rules-and-sources.md).

