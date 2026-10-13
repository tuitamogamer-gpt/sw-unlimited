# Account saves and Supabase

The first account release adds email sign-in, optional Google sign-in, cloud
decks and settings, one current game, completed battle reviews, and verified
training progress. Guest play, training and reviews work without Supabase.
Every account also keeps a local copy in its own browser scope.

## Connect the existing Supabase project

1. Run [accounts.sql](../supabase/accounts.sql) in the project's SQL Editor.
   It creates a private application table and an atomic compare-and-swap RPC.
   It does not alter existing tables. Anonymous and ordinary authenticated
   clients cannot read or write these records directly.
2. In Vercel project `sw-unlimited`, add these server environment variables:
   - `SUPABASE_URL`: the project's HTTPS URL.
   - `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`): its public API key.
   - `SUPABASE_SERVICE_ROLE_KEY`: the private server API credential.
   - `AUTH_URL`: `https://sw-unlimited-mu.vercel.app`.
3. Keep the existing `SWU_SESSION_SECRET`. Changing it invalidates encrypted
   game checkpoints. Never put the service-role credential, auth secrets or game
   encryption key in Git, chat, frontend variables or public configuration.
4. In Supabase Authentication → URL Configuration, use the production URL as
   Site URL and add it to allowed redirect URLs. Enable the Email provider.
   If email confirmation is enabled, signup tells the player to confirm before
   returning to sign in. Configure the project's email delivery before a public
   rollout; application tests do not verify its SMTP delivery or provider quotas.
5. Redeploy and verify an actual account on two separate browser profiles.

The public API returns only the project URL and publishable key. Account identity
comes from Supabase's verified `/auth/v1/user` response, with a stable UUID-based
scope. Browser-supplied owner names or emails never authorize a save.

## Optional Google login through Supabase

1. In Google Cloud Console, configure branding and audience, then create an
   OAuth client of type **Web application**.
2. Open Supabase Authentication → Providers → Google. Copy its callback URL
   (normally `https://<project-ref>.supabase.co/auth/v1/callback`) into Google's
   authorized redirect URIs.
3. Put the Google Client ID and Client Secret in the Supabase provider settings.
   Keep the secret in those settings, not the frontend or chat.
4. Set `SUPABASE_GOOGLE_ENABLED=true` in Vercel after the provider is enabled,
   redeploy, and verify the live Google flow.

The older Auth.js Google setup remains supported when no Supabase public key is
configured. Its separate callback and environment instructions are in
[google-sign-in.md](google-sign-in.md).

## Saving and recovery

Decks, settings, the current game, finished reviews and training progress have
separate versions. Independent changes merge; a conflicting change to the same
item asks the player which version to keep. An older turn of the same game cannot
replace a newer account turn. Deleted records retain tombstones so an old device
cannot silently restore them.

Updates first write the local copy and a persistent pending journal. Network
failure retains that journal for retry. Requests include an expected account
precondition in addition to native authentication, so a request from a previous
account cannot modify the next account after a login change.

Games remain encrypted native replays. Guest checkpoints expire after six hours.
Verified account-owned checkpoints can be renewed within 30 days of their last
six-hour session window, including delayed offline uploads; authentication,
signed owner, retention and every replayed engine action are still checked.
Cloud games and completion proofs are never stored or served as public files.

The initial limits are 50 active custom decks, 50 active battle reviews and a
5 MiB account document. A single atomic account document suits this bounded
release. Large-scale matchmaking and independent match workers will require a
separate normalized match store; this feature is not a million-player capacity
claim.

## Verification

Unit and native HTTP tests cover authentication, per-account isolation, versions,
offline queues, deleted records, verified lesson completion, finished reviews,
expired account renewal and exact restored boards. The browser check uses the
real Supabase SDK against a local HTTP auth fixture and the actual app API; it
does not replace or validate the existing project's credentials or SQL setup.
Live configuration is verified separately after connecting the actual project.
