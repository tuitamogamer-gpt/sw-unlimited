# Physical table references for the battle UI

Research checked 8 October 2026. The references below were opened as images,
including the actual tabletop photograph; observations do not rely solely on
article text. Scratch copies live in `/workspace/research/battle-visual/` and
are research material, not bundled product artwork.

## Sources and visible evidence

1. [FFG Quickstart Rules, pages 4–5](https://images-cdn.fantasyflightgames.com/filer_public/36/f6/36f6e0a5-a7a9-4cbe-8d73-70e61fe6f548/sw_unlimited_quickstart_rules.pdf).
   The setup illustration puts the landscape base above the landscape leader,
   resources behind them, hand nearest the player, and deck to the side. The
   accompanying instruction places the leader's horizontal non-unit face below
   the base. Page 5 shows round red/orange damage counters numbered 1, 5 and 10.
   Inspected renders: `quickstart-setup.png`, `quickstart-board.png`.
2. [FFG, Launch Sequence](https://starwarsunlimited.com/articles/launch-sequence).
   Its [full setup diagram](https://cdn.starwarsunlimited.com/Star_Wars_Unlimited_Full_Game_Setup_Example_14ec4f6ef7.png)
   shows mirrored opponents, bases facing each other and private hands at the
   outer edges. The [readying diagram](https://cdn.starwarsunlimited.com/Star_Wars_Unlimited_Gameplay_Preview_Diagram_Readying_Cards_1cb4832cb2.png)
   explicitly turns exhausted units/resources 90 degrees back to ready. A
   leader's naturally landscape face must not be confused with exhaustion.
   Inspected copies: `official-setup.png`, `official-ready.png`,
   `official-attack.png`.
3. [FFG, Unlimited Accessories](https://starwarsunlimited.com/articles/unlimited-accessories).
   The licensed [Gamegenic XL mat](https://cdn.starwarsunlimited.com//SHW_01_Gamegenic_Accessories_XL_Game_Mat_0d957c2afc.png)
   marks separate ground and space areas, central base/leader positions,
   resources at the rear, and deck/discard at the side. Thin white zone lines
   sit on dark navy hyperspace artwork. The [token photograph](https://cdn.starwarsunlimited.com//SHW_01_Gamegenic_Accessories_Tokens_72a6320c06.png)
   shows red/orange damage, blue shields, green +1/+1 experience and an orange
   epic-action X. Inspected copies: `gamegenic-mat.png`, `tokens.png`.
4. [LaserGaming, Intro Battle: Hoth tabletop article](https://lasergamingshop.com/2025/10/26/learn-to-play-star-wars-unlimited-with-intro-battle-hoth/).
   Its genuine physical-game photograph shows portrait ready units, sideways
   exhausted units, facedown rear resources, a fanned hand, a separate
   initiative marker, and small circular red counters numbered **1, 3 and 5**.
   These are this retailer's aftermarket counters; 3 is not evidence that the
   official starter supplies a 3-denomination counter. The photo also shows a
   compact Sentinel marker. Inspected page screenshot:
   `lasergaming-tabletop.png`.

## Translation to the digital table

Preserve the relationship between zones: opposing rows within clearly named
ground and space arenas, visible bases, a leader command area, and a rear hand
and resource area. Ground's literal left/right position is not a rule; the
licensed mat mirrors the players. Keep opposing artwork readable to the human
instead of turning the bot's text upside down. A deployed leader belongs in its
arena as a unit.

The user's explicit direction takes priority over physical card rotation:
**keep the exhausted card upright, grayscale its artwork, and display a small
red “Exhausted” token.** Apply grayscale to the artwork image only, so the token
stays red. The implemented token is 12 px high in a reserved 14 px lower-edge
gutter, below the illustration. Retain a text label/accessibility
name; color alone should not carry this state. Avoid faded artwork plus a large
banner obscuring the card.

Use one compact red numeric damage marker at the border; represent damage 3 as
one readable value rather than three overlapping tokens. Blue shield and green
experience icons can occupy separate perimeter slots with counts. Keep cost,
power and HP corners readable. Put detailed modifiers, attached upgrades and
captured cards in the inspector, with small attachment tabs on the table.

On mobile, prioritize recognizable card art, both base HP totals, the current
decision and the hand. Use compact command strips and horizontally scrollable
unit rows. If arenas share a tabbed area, show both arena names and unit counts,
retain the active arena when opening an inspector, and make a target in another
arena discoverable. Full tabletop spacing should not force tiny cards or cover
them with controls.

## Palette and motion recommendations

These values are design proposals, not official rules or brand specifications.
Use a matte near-black/navy table (`#080D16`, lane `#111D2B`, border `#213549`),
off-white text (`#E9EEF4`), restrained cyan legal-action outlines (`#59D7EF`),
red status/damage tokens (`#B83940`), blue shields (`#4FA9DB`), green experience
(`#54A879`) and amber initiative (`#D4AB53`). Let card art provide most color;
avoid constant glow on every card. Damage numbers and the Exhausted label must
remain distinguishable despite sharing red.

Animate confirmed game-state changes, keeping controls and targeting hitboxes
stable. Selection can lift 3 px over 120–180 ms; an attack can lunge 10–18 px
toward its actual target over 180–240 ms, followed by a brief impact ring and
damage update. Fade defeated cards in 150–220 ms; flip a deploying leader in
220–300 ms. Exhaustion can desaturate over 200 ms while the small token appears.
Queue effects so multiple bot actions remain understandable. With
`prefers-reduced-motion`, remove travel, shaking and 3D flips and use instant
updates or short opacity fades.
