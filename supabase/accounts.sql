-- Run once in the existing project's SQL editor. Only the application's server
-- service-role credential can read/write account saves. Never expose that key
-- through VITE_ variables or browser requests.
create table if not exists public.swu_account_saves (
  owner_id text primary key,
  revision bigint not null default 1 check (revision > 0),
  document jsonb not null,
  updated_at timestamptz not null default now(),
  constraint swu_account_owner_format check (
    owner_id ~ '^(google_[a-f0-9]{64}|supabase_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$'
  ),
  constraint swu_account_document_object check (jsonb_typeof(document) = 'object'),
  constraint swu_account_document_size check (octet_length(document::text) <= 5242880)
);

alter table public.swu_account_saves enable row level security;
revoke all on table public.swu_account_saves from anon, authenticated;
grant select, insert, update, delete on table public.swu_account_saves to service_role;

-- Optimistic concurrency is checked in the same database transaction as the
-- write. Returning false means another device won; it never replaces its save.
create or replace function public.swu_compare_account_save(
  p_owner_id text,
  p_expected_revision bigint,
  p_document jsonb
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected integer;
begin
  if p_expected_revision is null then
    insert into public.swu_account_saves (owner_id, revision, document)
      values (p_owner_id, 1, p_document)
      on conflict (owner_id) do nothing;
  else
    update public.swu_account_saves
      set document = p_document, revision = revision + 1, updated_at = now()
      where owner_id = p_owner_id and revision = p_expected_revision;
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.swu_compare_account_save(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.swu_compare_account_save(text, bigint, jsonb) to service_role;
