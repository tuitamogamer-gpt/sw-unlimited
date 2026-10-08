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

## Scope and verification

All 18 imported decks currently pass the implementation audit. The Intro Battle: Hoth bases retain their verified 20 HP definition and are labeled as that variant; the adapter does not silently replace them with 30 HP. It likewise preserves printed 28 HP LOF and 27 HP LAW bases.

The pinned upstream engine remains the authority for card resolution. A fully registered card is not a mathematical proof of every possible interaction; runtime acceptance and upstream rule tests supplement the coverage check. A local grouped-trigger completion fix is documented in `docs/upstream-patches.md`; it preserves all effects and choices. One observed edge case is deployed Jabba the Hutt's repeatable play-unit action remaining available when its play cannot resolve because the delayed conditional effect can still register. The bot avoids repeating unchanged public states and unaffordable play lines. No card rules were patched to conceal this behavior.

See `tests/acceptance.test.cjs`, `scripts/smoke.cjs`, and `docs/validation-smoke.json` for reproducible checks and final run results. Research provenance and the official rules-version date caveat are documented separately in `docs/rules-and-sources.md`.
