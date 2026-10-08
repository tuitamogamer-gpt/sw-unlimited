# Rules engine adapter

`server/engine.cjs` embeds the pinned MIT-licensed Forceteki production engine from `vendor/forceteki`. It creates real `Game`, `Player`, `Deck`, card classes, event windows, costs, targeting prompts, setup, action, and regroup phases. It does not substitute a simplified combat engine or parse printed text into guessed effects.

The card getter uses the official card definitions downloaded by upstream `scripts/fetchdata.js`. Upstream applies documented data corrections and implementation-specific supplements during import. `npm run engine:setup` installs and builds the vendored engine. Verified artwork URLs are imported separately into `data/card-images.json`.

## Session API

```js
const { createGame, listDeckStatus, loadCard } = require('./server/engine.cjs');
const session = await createGame({ playerDeck, botDeck, seed, difficulty });
const humanView = session.view();
const botView = session.botView();
session.submit(action, 'human'); // synchronous; returns this player's next view
session.close();
```

Deck inputs are SWUDB-format objects: `leader: { id: 'SOR_005' }`, `base: { id: 'SOR_025' }`, and `deck: [{ id, count }]`. `listDeckStatus` instantiates each complete list and checks every card's actual `isImplemented` property. A normal game refuses any unimplemented card. Catalog status includes `supported`, `coverage`, the original `leaderRef` / `baseRef`, rich leader/base cards, and `cards: [{ count, card }]`.

Each view contains `players`, `prompt`, `legalActions`, `log`, `phase`, `round`, `version`, and `winnerIds`. Player IDs are `human` and `bot`. The bot receives its own view, never the engine object. Hidden opponent hand/resources have no name, identifier, artwork, text, cost, or UUID. Neither view includes deck order or the shuffle seed. Cards revealed by a rules prompt are visible only to the prompted player. Public action labels do not identify face-down targets.

Submit an exact current legal action. Actions are `card`, `button`, `perCard`, or `stateful`. A `promptId` is required; optional `version` prevents replay within the same prompt. `ActionError` carries `status: 409` and a machine-readable `code`. Stateful distributions require legal unique targets and nonnegative integer amounts, obey the prompted total/target limit, and enforce indirect-damage unit HP caps before invoking the engine. Engine exceptions are surfaced rather than converted into automatic passes.

The adapter normalizes button arguments to strings for the browser and restores native numeric menu indices when dispatching. This distinction matters for upstream `HandlerMenuPrompt`. Pilots attached as upgrades use native summary fields, avoiding invalid unit-damage access. Numeric keyword values and adjusted action resource costs are exposed to the bot. `attackPower` includes current modifiers and Raid; target-dependent effects still resolve through the engine.

Play/deploy labels use native play-action identity before leader deployment labels, so names such as Droid Deployment remain normal card plays. Own-hand `playable` and `playOptions[].legal` follow the engine's current legal actions. `playCost` is the lowest native adjusted resource cost of a legal play option, or the lowest available option when none is currently legal. It includes aspect penalties and may assume optional payment choices such as Exploit; the engine still prompts for those choices before payment. It is not a promise that no additional choice or cost is required.

Visible cards expose `pilotText`, `upgradePower`, and `upgradeHp`. An attached pilot's active `text` is its piloting text, while `frontText` preserves the unit text. Native summaries supply current power, HP, and damage, including attachments and effects; `remainingHp` is current HP minus damage. Shield, Experience, and Advantage tokens remain inspectable entries in `upgrades`. Current `keywords` come from the engine after gained effects, removal, and numeric keyword aggregation. Leader deployment availability is represented by legal actions, and the native `epicDeployActionSpent` field reports whether deployment has been used.

Base attachments use the same `upgrades` tree, including Fortify cards. Base captures use `captured`; each child still passes through normal visibility checks. Base cards never access the damage/power methods reserved for arena units.

`normalizeDeckRecipe(recipe)` validates custom recipes before native deck construction. It resolves known set-number aliases, merges entries by the engine's shared card identity, and counts main deck plus sideboard copies together. One leader and one base are required; token cards and misplaced card types are rejected. Printed construction exceptions are preserved: Swarming Vulture Droid allows 15 copies, Thermal Oscillator requires at least 45 main-deck cards, and Data Vault requires 60. Other cards/decks use the normal three-copy and 50-card limits. Game creation runs this same validation, so the native `Deck` map cannot silently discard duplicate rows.

Custom solo play uses all complete supported sets without applying tournament rotation or suspension lists. These are separate from scripting support: the compiled registry already loads every card implementation in the pinned engine. Cards needing only standard keywords or no abilities are supported by native base classes. Synthetic preview definitions containing mock data are rejected even if a corresponding script exists. Input-size, main-deck maximum, and sideboard-size limits are enforced by the HTTP product layer.

## Scope and verification

All 18 imported decks currently pass the implementation audit. The Intro Battle: Hoth bases retain their verified 20 HP definition and are labeled as that variant; the adapter does not silently replace them with 30 HP. It likewise preserves printed 28 HP LOF and 27 HP LAW bases.

The pinned upstream engine remains the authority for card resolution. A fully registered card is not a mathematical proof of every possible interaction; runtime acceptance and upstream rule tests supplement the coverage check. A local grouped-trigger completion fix is documented in `docs/upstream-patches.md`; it preserves all effects and choices. One observed edge case is deployed Jabba the Hutt's repeatable play-unit action remaining available when its play cannot resolve because the delayed conditional effect can still register. The bot avoids repeating unchanged public states and unaffordable play lines. No card rules were patched to conceal this behavior.

See `tests/acceptance.test.cjs`, `scripts/smoke.cjs`, and `docs/validation-smoke.json` for reproducible checks and final run results. Research provenance and the official rules-version date caveat are documented separately in `docs/rules-and-sources.md`.
