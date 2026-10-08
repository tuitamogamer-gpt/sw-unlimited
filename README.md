# Star Wars Unlimited · Command

Play Star Wars: Unlimited against a tactical AI with scripted card abilities and
automated rules. English is the default interface language; Serbian (Latin) is
available from the EN / SR language control. Card names and printed card text
retain their official English wording.

**[Play online](https://sw-unlimited-mu.vercel.app)**

## Included decks

18 verified starter and Spotlight decks, each with 50 main-deck cards, a leader,
and a base:

| Product | Leaders |
| --- | --- |
| Spark of Rebellion | Luke Skywalker, Darth Vader |
| Shadows of the Galaxy | The Mandalorian, Moff Gideon |
| Twilight of the Republic | Ahsoka Tano, General Grievous |
| Jump to Lightspeed | Boba Fett, Han Solo |
| Legends of the Force | Qui-Gon Jinn, Darth Maul |
| Secrets of Power | Padmé Amidala, Chancellor Palpatine |
| A Lawless Time | Leia Organa, Jabba the Hutt |
| Ashes of Empire | Luke Skywalker, Emperor Palpatine |
| Intro Battle: Hoth | Leia Organa, Darth Vader — 20 HP bases |

## Custom decks and card library

Choose **Import a deck** to paste a SWUDB JSON export, a text list, or a public
SWUDB deck link, or upload a `.json` / `.txt` file. Review the card list and
validation results, then save it for yourself or the AI. Saved custom decks
can be selected, inspected, exported, and removed in your browser collection.
See [import formats and validation](docs/custom-decks.md).

The searchable **Card library** contains 2,600 normal printing records across
12 sets, including reprints and tokens. Of these, 2,579 have complete data and
implemented engine rules; 21 incomplete IC27 preview entries remain unavailable
for play. Alternate art and promo codes resolve to their corresponding game
identities. Homeworlds is explicitly marked as preview data at the October 8,
2026 snapshot cutoff. See [full card inventory and coverage](docs/card-catalog.md).

Custom matches use Solo Premier construction rules with all available sets;
tournament rotation and suspensions are not enforced. Sideboards are validated
and saved but are not used during a single game.

## Playing

Choose your deck, an opponent deck, and an AI difficulty. During setup, keep or
mulligan your hand and select exactly two cards to become resources. During the
action phase, play cards by paying their cost, attack with ready units, or use a
leader or card ability. Actions alternate between you and the AI.

The interface distinguishes resource selection from playing cards. Hand cards
show their effective play cost and action status. A card that cannot currently
be played explains why. Claiming initiative ends your actions for the round and
gives you the first action next round. At regroup, adding one resource is
optional; you can keep your entire hand.

On a phone, Ground and Space are tabs within a single-screen battlefield. Your
hand and current decision stay visible. Base and leader cards have artwork and
inspection controls; the battle log and reference information open separately.
Landscape phones use a side panel for the hand and commands. Exhausted units
keep grayscale artwork with a small red token beneath it. Cards settle into
play; damage, healing, and lost shields have distinct brief effects. Red damage
counters follow the [physical tabletop references](docs/battle-visual-reference.md).
Reduced-motion preferences keep the numbers without movement. Crowded rows
show when more cards are available by scrolling.

Inspect a card to read its rules, zoom its artwork, view attachments, and use
its currently legal action. Deck details include a searchable card list,
type filters, and a cost curve. Starting another game asks before replacing an
unfinished match.

The AI uses the same legal action system as the human. It evaluates lethal
attacks, base defense, unit trades, Sentinel, shields, its resource curve,
leader deployment, and initiative. It sees its own hand and public information,
without access to your hidden hand, deck order, or shuffle seed.
See [AI design](docs/ai.md).

## Run locally

Requires Node.js 24.

```sh
npm ci
npm run engine:setup
npm run dev
```

Open `http://localhost:5173`. Vite forwards API requests to the Node server on
port 3001. To serve a production build from one process:

```sh
npm run build
npm start
```

Open `http://localhost:3001`. `PORT` and `HOST` configure the server address.
Alternatively, use `docker build -t swu-command .` followed by
`docker run --rm -p 3001:3001 swu-command`.

## Rules and data

The MIT-licensed [Forceteki engine](https://github.com/SWU-Karabast/forceteki)
executes rules and card abilities. Its source is vendored at a pinned commit.
Decks with unsupported cards are rejected. Full script coverage is not a claim
that every possible card interaction is free of bugs.

Local correctness and hosting compatibility fixes are documented in
[upstream patches](docs/upstream-patches.md), including the regression test for
grouped Advantage triggers.

Card definitions use a local snapshot so playing does not depend on a live card
API. Artwork loads from the card CDN. The official rulebook, errata, API sources,
and separately identified Reddit / BoardGameGeek interpretations are documented
in [rules and sources](docs/rules-and-sources.md). See
[rules version](docs/rules-version.md) for the implementation's version boundary.

## Validation

```sh
npm test
npm run test:smoke
npm run cards:check
npm run build
npm run test:ui
npm run test:custom-ui
npm run test:motion-ui
node scripts/sync-card-catalog.cjs --check
```

The UI check requires Chromium (`npx playwright install chromium`) and uses a
local HTTP server with a deterministic, encrypted game checkpoint. It checks
manual card plays (including from the card inspector), artwork and zoom,
searchable deck details, loaded base artwork, portrait and landscape viewport
bounds, arena tabs, confirmation dialogs, language persistence, and game
restoration after a lost action response.

The motion check follows real engine actions through entry, repeated damage,
and shield loss. It verifies exhaustion tokens, image-only grayscale, effect
expiry, reduced motion, and portrait/landscape bounds.

Tests exercise real games, manual human play from setup through regroup,
information privacy, illegal action rejection, and restoration of encrypted
checkpoints. The upstream engine includes its own detailed rules tests under
`vendor/forceteki/test`.

The custom-deck checks cover invalid lists, alternate printing identities,
special deck-building rules, real matches from ten expansion pools, and
restoration on a fresh server with no custom-deck library. The browser test
imports files and text, selects both custom decks, plays a unit, and restores
the match after removing the saved deck lists.

## Saved games and hosting

Games are stored as encrypted browser checkpoints for six hours from creation.
The host can restore a game after its server instance changes without exposing
hidden cards. Use one browser tab per game. For local persistence across server
restarts, configure a stable `SWU_SESSION_SECRET`; development otherwise uses a
temporary key.

The client saves the checkpoint and its version together, limits request wait
times, and attempts a read-only restore if an action response is lost. It never
automatically repeats an uncertain action. Connection and browser-storage
problems are shown with a recovery message.

Custom deck recipes are included inside the encrypted game checkpoint, so
removing a deck from the collection does not prevent resuming that game.

See [deployment](docs/deployment.md) for Vercel build and environment settings.
The AI is a local tactical system and needs no LLM service or API key.

This application supports 1v1 Premier. Twin Suns is a different multiplayer
format. Product details and deck-list sources are in
[deck data](docs/deck-data.md).

Unofficial fan project. See [licenses and credits](THIRD_PARTY_NOTICES.md).
