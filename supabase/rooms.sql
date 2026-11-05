-- Private online matches. Run once in the Supabase SQL Editor.
-- Browsers use our authenticated seat API, never this table or RPC directly.
create table if not exists public.swu_rooms (
  id uuid primary key,
  revision bigint not null check (revision >= 0),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  expires_at timestamptz not null
);
create index if not exists swu_rooms_expiry on public.swu_rooms(expires_at);
alter table public.swu_rooms enable row level security;
revoke all on public.swu_rooms from anon, authenticated;
grant select, insert, update, delete on public.swu_rooms to service_role;

create or replace function public.swu_compare_room(
  p_id uuid, p_expected_revision bigint, p_document jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if jsonb_typeof(p_document) is distinct from 'object'
     or octet_length(p_document::text) > 1048576
     or (p_document->>'revision')::bigint is distinct from coalesce(p_expected_revision + 1, 0)
     or (p_document->>'id')::uuid is distinct from p_id then
    raise exception 'Invalid room document';
  end if;
  if p_expected_revision is null then
    insert into public.swu_rooms(id, revision, document, expires_at)
      values (p_id, 0, p_document, to_timestamp((p_document->>'expiresAt')::double precision / 1000))
      on conflict do nothing;
  else
    update public.swu_rooms set revision = p_expected_revision + 1, document = p_document,
      expires_at = to_timestamp((p_document->>'expiresAt')::double precision / 1000)
      where id = p_id and revision = p_expected_revision and expires_at > now();
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke all on function public.swu_compare_room(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.swu_compare_room(uuid, bigint, jsonb) to service_role;

-- Expired invitations and games are unreadable through the app. For storage
-- maintenance, schedule: delete from public.swu_rooms where expires_at < now();
