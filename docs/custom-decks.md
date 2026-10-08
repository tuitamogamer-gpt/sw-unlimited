# Importing custom decks

Open **Import a deck**, paste an export or upload a `.json` / `.txt` file,
and choose **Validate deck**. Review the commander images, main-deck list,
card count, and any errors. A valid list can be saved and assigned to either
the human or AI seat. The browser collection supports inspection, selection,
JSON export, and removal with confirmation.

Decks are stored only in that browser. Export JSON to transfer one to another
device. Storage failures produce an explicit error instead of claiming a deck
was saved. Imported recipes are validated again on the server before every
new game, independently of the browser's cached display data.

## Accepted formats

SWUDB's JSON export uses `metadata.name`, one `leader:{id}`, one `base:{id}`,
`deck:[{id,count}]`, and an optional `sideboard:[{id,count}]`. The importer also
accepts `mainDeck` or `mainboard` for the main list. An optional import name
overrides the exported name. Exports downloaded from this application's
collection can be imported again through the same flow.

Text lists require sections named `Leader`, `Base`, `Main Deck` (or `Deck` /
`Mainboard`), and optionally `Sideboard`. A header may have a colon and an
inline entry. Main-deck and sideboard rows begin with a quantity, such as
`3 SOR_042` or `3x SOR_042`. Leader and base quantities default to one.
`Name: My fleet` names the list. Blank lines and comments beginning with `#`
or `//` are ignored. The import dialog includes a short format example.

Card references may be set codes (`SOR_005`, `SOR 5`, or `SOR5`), official
numeric card IDs, or unambiguous names including their subtitles. Alternate
art and promotional codes map to the same underlying card identity. If a
name identifies more than one card, validation asks for its subtitle or code.

Public links may use `https://swudb.com/deck/{id}`,
`https://swudb.com/deck/view/{id}`, or the corresponding
`https://swudb.com/api/getDeckJson/{id}` endpoint. `www.swudb.com` is accepted
as well. Fetching always uses the fixed SWUDB API origin, refuses redirects,
and has an eight-second deadline and 100 KB response limit. A private,
blocked, or unavailable link shows a message directing the player to paste
the JSON export. Public-link access returned HTTP 403 from the research
environment; file and pasted imports do not depend on that service.

## Validation and format

Solo Premier requires one leader, one base, and at least 50 main-deck cards.
The validator checks actual card types and aggregates identical card identities
across reprints and across the main deck and sideboard. The normal maximum is
three copies. It honors the pinned engine's card-text exceptions: Thermal
Oscillator allows a 45-card minimum, Data Vault requires 60, and Swarming
Vulture Droid permits up to 15 copies. Sideboards contain at most ten cards.
Tokens, a second leader, invalid quantities, unknown cards, and incomplete
or unsupported card data are rejected.

The application accepts at most 200 main-deck cards, 256 rows per section,
100 KB of input, and a 120-character deck name. These upper limits bound
import and replay work; they are application limits rather than printed rules.

All available sets can be used in Solo Premier, including explicitly labeled
complete preview cards. Tournament rotation and suspensions are not checked.
This application plays a single game, so sideboards are validated and retained
for export but never swapped into the deck during a match. Twin Suns' two-leader
multiplayer format is not supported.

## API and saved games

`POST /api/decks/import` accepts `{input, name?}` and returns `deck`,
`errors`, `warnings`, and structured `issues` with a message template and
parameters for localization. A valid import returns HTTP 200; a parsed but
invalid list returns 422, while malformed input and unavailable URLs return
400. A card preview is returned when the leader and base can be resolved.
`deck.recipe` is the compact canonical list used to start a game.

`POST /api/games` accepts `playerDeck` and/or `opponentDeck` recipes in
addition to the existing `deckId` / `opponentDeckId` starter selections.
Each supplied recipe is revalidated server-side. No browser-provided supported
flag, card statistics, rules text, or image is trusted by the game engine.

Custom recipes are embedded in the authenticated, encrypted replay checkpoint.
A new server can rebuild the game even when neither list exists in the starter
catalog or browser collection. The checkpoint format remains compatible with
existing starter games. Custom decks do not change the six-hour game lifetime.

Run `npm test` for parser, rules, alias, HTTP, and independent-process restore
checks. Run `npm run build && npm run test:custom-ui` for the actual browser
import, collection, card-library, and custom match flow.
