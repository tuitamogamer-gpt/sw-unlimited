# Ambush

The rules reference is [Comprehensive Rules 9.0, section 7.5.5](https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v9_0_c4aa591948.pdf), inspected on 2026-10-09. Ambush lets a unit attack an eligible enemy unit when played, deployed, or created, even while exhausted. It does **not** ready the unit. Ordinary Ambush cannot attack a base; a specific card ability can override that restriction. If there is no eligible enemy unit, there is no Ambush attack.

Ambush and other “When Played” abilities resolve in the same window. The controller chooses their order. If Ambush resolves first, its attack and any resulting abilities finish before the remaining simultaneous triggers resolve. Multiple instances of Ambush do not grant additional attacks.

## Application behavior

The native engine already implements this attack through `allowExhaustedAttacker: true`. The interface previously discarded the optional trigger's ability label and source card, displaying only generic **Trigger / Pass** controls. Clicking the exhausted unit instead did not activate the pending trigger.

The adapter now preserves the public source card and ability label on prompt buttons, and exposes `prompt.ability` for the optional ability decision and Ambush target selection. This metadata comes from native trigger and attack properties, so units that gain or lose Ambush are handled without guessing from printed card text. Sources that have moved to hidden zones are not exposed.

The player chooses **Use Ambush** or clicks the marked source unit, then selects one of the engine's highlighted legal targets. **Skip Ambush** declines the attack. The named prompt explains that the attack is available while exhausted. Exhausted sources and targets show both their action label and the small red Exhausted token below the artwork.

The card remains exhausted throughout. Selecting the unit later during an ordinary action does not grant another Ambush attack. Declining the optional ability also does not save it for a later turn.

Engine reference: [AmbushAbility.ts](../vendor/forceteki/server/game/abilities/keyword/AmbushAbility.ts). Adapter: [server/engine.cjs](../server/engine.cjs). Some upstream test titles still describe “readying”; the current implementation and official rule quoted above do not ready the unit.
