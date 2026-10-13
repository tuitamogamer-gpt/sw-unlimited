# Google sign-in

This page describes the retained Auth.js Google setup. With a configured
Supabase public key, the app uses Supabase email/Google accounts and the provider
callback instead. See [account saves and Supabase](account-cloud.md) for that
setup, the private database migration and cross-device saves.

The header offers **Sign in → Continue with Google**. First-time and returning
players use the same Google flow. Guest play remains available without a Google
account. The profile shows the verified Google name, email, and avatar, with a
Sign out action. English is the default; Serbian is available in the language
selector.

Google sign-in requires a Google OAuth web client. Until its credentials are
configured, the account panel explains that sign-in is unavailable and offers
guest play. There is no demo identity or production authentication bypass.

## Activate production

1. Open [Google Cloud Console](https://console.cloud.google.com/auth/overview)
   and select or create the project that will own the login application.
2. Configure Google Auth Platform branding, audience, and contact information.
   Use **External** if players are outside a single Google Workspace
   organization. In Testing mode, add the Google accounts allowed to test it.
3. Under **Clients**, create an OAuth client of type **Web application**.
4. Add the exact authorized redirect URI:

   ```text
   https://sw-unlimited-mu.vercel.app/api/auth/callback/google
   ```

5. In Vercel → **sw-unlimited** → **Settings → Environment Variables**, add
   `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` to **Production**. Keep the secret
   server-only; do not paste it into an issue, chat, frontend variable, or Git.
6. The app also requires a random `AUTH_SECRET` of at least 32 characters and
   `AUTH_URL=https://sw-unlimited-mu.vercel.app`. Use a separate auth secret;
   do not replace the existing `SWU_SESSION_SECRET` used by game checkpoints.
7. Redeploy after adding or changing environment variables. Test an actual
   Google login, logout, and login again on the canonical production URL.

Only `openid email profile` are requested. The app does not request Gmail,
Drive, or other Google account access. Google audience/testing restrictions
are controlled in Google Cloud Console.

Preview deployments do not inherit Production credentials. To enable a preview,
configure its exact stable origin and callback in both Google and Vercel.
Unconfigured previews continue to support guest play.

## Local development

Copy `.env.example` to `.env`, generate a distinct random auth secret, and add
the local callback to the Google OAuth web client:

```text
http://localhost:5173/api/auth/callback/google
```

`npm run dev` loads `.env` and serves the UI at `http://localhost:5173`; the API
uses the existing Vite proxy. Use that exact hostname, matching `AUTH_URL`.
To test a production build on a different local port, set `AUTH_URL` to its
exact origin and register that callback in Google. `.env` files are ignored
by Git.

## Saves and account changes

Local decks, preferences and the latest game are separated by the
server-verified account ID. When the Supabase cloud store is configured, account
saves also sync across devices; local-only installations keep browser storage.
Guest saves retain their original keys.
Signing in does not automatically copy guest decks into an account; export and
import a deck to copy it explicitly. Signing out returns to the guest collection
without deleting either collection. Google email/name changes do not change the
account's storage ID.

Guest games expire six hours after creation. Saved account games can be renewed
within the cloud retention period; see [recovery details](account-cloud.md).
Local copies are convenience profiles on a shared browser, not an
encrypted local vault: someone with access to browser storage can access its
saved data. Use separate browser profiles on shared devices.

Each game client captures its storage scope. An action response that arrives
after an account change still belongs to the originating scope. Account changes
reset the visible board; return to its account and choose Resume to continue.
Sign-in/out controls are disabled while a game action or presentation is active.

## Authentication implementation

Auth.js (`@auth/express`, locked in `package-lock.json`) performs Google's OAuth
authorization-code flow with PKCE, state, nonce, and ID-token validation.
Only a verified Google email and subject are accepted. Identity uses a stable
hash of Google's subject, never a user-submitted ID or email address.

The app session is an Auth.js encrypted HttpOnly cookie, Secure in production
and SameSite=Lax. Sign-in and sign-out require Auth.js's CSRF token. OAuth return
URLs are fixed to the configured origin; request bodies and forwarded headers
cannot select another callback host. Google access/refresh tokens are not
stored in the app session or browser storage. `/api/account` returns only
public profile fields and expiration with private/no-store caching.

Auth endpoints are independent of engine initialization. Configuration or
provider failures do not prevent guest gameplay. Existing encrypted game
checkpoints remain bearer capabilities, independent of Google authentication.

## Validation

`npm test` includes authentication, browser-client, and account-storage
regressions. `npm run test:account-ui` exercises the rendered app through the
real Auth.js flow with a local Google test transport and signed OIDC responses.
The transport is injected by the test process; HTTP requests and production
environment variables cannot enable it. This validates the application's flow,
not the real Google project's credentials or consent configuration. A live
Google login remains the final deployment configuration check.
