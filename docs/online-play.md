# Private 1v1 rooms

Choose **Play a friend** in the command lobby. Each player picks their own starter
or imported deck. The host creates a room and shares its invitation link; the
second player opens the link and joins. An account is not required.

Each browser keeps its own random player key. The invitation contains a separate
one-use seat invitation, never either player's private key. Keep the original
browser to resume your seat. Closing the tab does not concede. Leaving an active
room requires confirmation and concedes the match; the host can close an empty
room. Rooms expire after six hours.

The engine enforces both players' actions. State lives on the server: browser
checkpoints cannot roll a shared match back. Only the viewer's legal prompt and
private hand are returned. The board is normalized so each viewer sits at the
bottom. No bot acts in these matches.

## Production setup

1. Run [rooms.sql](../supabase/rooms.sql) in your Supabase SQL Editor. It creates
   a private `swu_rooms` table and atomic compare-and-swap RPC. Ordinary browser
   users cannot access either directly. Existing tables are not changed.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel for the environments
   you want to use (production, and a separate test project for previews if
   desired). Enter the private credential in Vercel, never in Git or chat.
3. Keep the existing `SWU_SESSION_SECRET` unchanged. It protects the server's
   stored native replay. Redeploy after changing environment configuration.
4. Verify an invitation in two separate browser profiles and play both sides.

The public API exposes only whether room storage is configured, never Supabase
credentials or native replay envelopes. When storage is absent or unavailable,
online requests fail visibly; production never falls back to an in-memory map.
Supabase Auth and Google OAuth are optional and not required for private rooms.

Room updates use an atomic revision check in PostgreSQL. Simultaneous requests
cannot fork a match, and duplicate action IDs are idempotent. After a lost response,
the UI reads the authoritative room before allowing another action. Polls use a
revision query and receive a body-free 204 when nothing changed. Visible rooms
poll every two seconds, background tabs less frequently, and failures back off.
This release is private unranked play, without matchmaking or rating.

Schedule `delete from public.swu_rooms where expires_at < now()` in Supabase for
expired-room cleanup. The API already rejects expired rooms independently of
that maintenance task. The encrypted replay is bounded by the solo engine's
action and checkpoint limits; each committed room document is at most 1 MiB.

## Local verification

Use `SWU_LOCAL_ROOMS=true npm start` after building. This explicitly enables a
development-only memory adapter and lets two browsers on that server play. It
does not survive a server restart. Tests inject a shared atomic adapter across
independent app instances to verify worker replacement, privacy, stale actions,
duplicate joins, and concurrent writes. Production uses the Supabase RPC.
