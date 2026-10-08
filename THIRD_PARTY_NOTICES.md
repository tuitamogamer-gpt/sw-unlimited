# Third-party components and assets

The rules engine in `vendor/forceteki` is Forceteki, copyright Stuart Walsh
(Ringteki architecture) and Addison Mayberry, distributed under its MIT license.
The full original notice is preserved in `vendor/forceteki/LICENSE`.

Upstream: https://github.com/SWU-Karabast/forceteki

Pinned revision: `1f0e9783c4743acdc67df0c4ab3f3610a349c32a`.

Local corrections applied on top of that revision are documented in
`docs/upstream-patches.md`, with a regression test for batched triggered abilities.

The app's engine adapter, HTTP service, tactical bot, and interface are separate
integration code. Card definitions are a snapshot downloaded using Forceteki's
official data importer. Card data/image URL metadata also comes from the public
SWUDB API. Individual starter lists cite their source in `data/decks.json`.

Star Wars: Unlimited names, artwork, card text, and rules belong to their
respective owners (including Lucasfilm and Fantasy Flight Games). This is an
unofficial fan project, not affiliated with or endorsed by them. The MIT software
license does not grant rights to the card artwork or trademarks.

User project patterns reviewed: `tuitamogamer-gpt/lotrlcg`, `marvel-lcg`,
`mtg-commander-simulator`, and `riftbound-duel-lab`. Provenance and architecture
notes are in `docs/reference-projects.md`.
