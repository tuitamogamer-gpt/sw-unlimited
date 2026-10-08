# Serverless game sessions

The live rules engine is stateful, while Vercel function instances are disposable.
`server/replay.cjs` therefore creates an encrypted checkpoint containing the deck
IDs, private shuffle seed, every accepted human and bot action, bot memory, and
the public bot explanation history. An instance may cache a running game, but
the browser checkpoint can reconstruct it after a restart or on another worker.

The checkpoint uses AES-256-GCM with a fresh 96-bit nonce and an authentication
tag, with DEFLATE compression applied before encryption. `SWU_SESSION_SECRET`
must contain at least 32 characters; use a randomly generated 64-character hex
value in production. The application derives a 256-bit key with SHA-256.
Vercel refuses to create or restore games when the secret is absent. Local
development can use a process-local random key; set the environment variable
locally to preserve games across local server restarts. Rotating the secret
invalidates existing checkpoints.

Checkpoints expire six hours after creation and are bound to their game ID and
the pinned engine version. Limits are 4,000 accepted atomic actions, 700 KiB for
the encoded token, and 2 MiB for decompressed JSON. Malformed, modified, expired,
wrong-game, and differently signed tokens are rejected before replay. The API
uses POST bodies to carry checkpoints, avoiding HTTP header-size limits, and
sends `Cache-Control: no-store` on API responses.

## Replay and hidden information

Forceteki creates cards for both players asynchronously, so its internal card
UUIDs cannot identify cards across reconstructed games. The adapter assigns each
physical card a stable opaque public identifier derived from the private seed,
game ID, and its registration position. It retains references for departed
cards and assigns new references to newly created tokens. The identifier exposes
neither the card's name nor its deck-list position. Prompt UUIDs similarly map
to stable per-player prompt epochs; an epoch persists throughout selection in
the same prompt. Keeping the epoch stable is necessary for the bot's protection
against repeating ineffective choices.

All public views and submitted actions use these stable identifiers. Restoration
creates the same seeded game and submits each recorded action through the normal
legality checks, including card, button, per-card, and stateful distribution
choices. Bot actions are replayed exactly, and subsequent decisions resume with
the saved bot memory. Card-definition JSON is cached as immutable input, with a
fresh copy supplied to the engine for each load.

The seed and private action log are encrypted; they are never included in the
human or bot observation as plaintext. A submitted action enters the history
only after successful application. If an engine action fails partway through,
the HTTP adapter discards the live instance and the previous browser checkpoint
remains the recovery point.

This is persistence for a solo game. Retaining an older valid checkpoint can
rewind or fork that game. There is no shared database enforcing a globally
monotonic revision across workers, and this protocol is not intended for ranked
multiplayer or a competitive leaderboard.

## Verification

Run:

```sh
node --test tests/replay.test.cjs tests/http.test.cjs
```

The replay suite passed **21/21 tests** after introducing opaque card references:

- All 18 imported starters finished real games with seed `101`, against the next
  starter in the catalog, and reproduced both player views at action 40 and at
  game end.
- Restored bot memory and explanation history matched the checkpoint; all four
  action types were exercised by real card effects.
- Malformed, tampered, expired, and differently signed tokens were rejected;
  invalid and stale actions did not alter the recorded history.
- A new Node process rebuilt the 237-action Darth Maul game in **2.31 seconds**.
  Final-game replay measured **0.36–1.74 seconds**, with encrypted tokens of
  **2.3–3.8 KiB** in that local run. These measurements are local validation,
  not a hosted latency guarantee.

The HTTP integration suite additionally checks that a checkpoint can move from
one application worker to another, and that a newer checkpoint supersedes an
older cached game.
