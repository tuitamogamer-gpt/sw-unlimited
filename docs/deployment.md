# Deployment

GitHub: https://github.com/tuitamogamer-gpt/sw-unlimited

Vercel project: `sw-unlimited`, team `tuitamogamer-7851s-projects`.
Runtime: Node.js 24. The Vite frontend and `/api/*` Node function are deployed
together from the `main` branch.

## Build

`npm ci`, then `npm run engine:setup && npm run build`. The engine source and
card definitions are pinned in this repository; deployment does not fetch live
card data. `vercel.json` includes dynamically loaded engine scripts and JSON.
The function entry point is `api/index.js`; local hosting still uses `npm start`.

## Game continuity

Vercel function instances can disappear between any two moves. The server
returns an authenticated AES-256-GCM encrypted replay checkpoint after each
accepted request. The browser stores the opaque checkpoint and sends it in the
JSON body of subsequent requests, including `POST /api/games/:id/state` to
resume. A new worker recreates the seeded game and replays its validated moves.
Private cards, the shuffle seed, and AI memory are never sent in plaintext.

`SWU_SESSION_SECRET` must be a stable cryptographically random secret of at
least 32 characters. A 32-byte random key encoded as 64 hexadecimal characters
is configured as a sensitive Vercel environment variable for production and
preview. It is not stored in Git. Rotating the key invalidates existing games.
Production fails closed if the secret is absent.

Checkpoints expire six hours after game creation. Sessions are designed for
solo play in one browser tab. Reusing an old valid checkpoint can branch a solo
game; distributed multiplayer concurrency and global revocation are outside
this application's scope. Deleting a game removes the local checkpoint and
current worker cache, rather than revoking old copies on every possible worker.

## Validation

`npm test` includes restoration of midgame and finished games for all 18 decks,
cross-process replay, token tampering, expiry, wrong-key rejection, and HTTP
continuation between separate worker instances. After deploying, verify
`/api/health`, `/api/decks`, a complete game and browser refresh/resume.

No external database or paid persistence service is required.
