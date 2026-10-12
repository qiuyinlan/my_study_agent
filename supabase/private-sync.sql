create table if not exists public.user_private_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('profile', 'session', 'message')),
  record_id text not null,
  content jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, record_type, record_id)
);

alter table public.user_private_records enable row level security;

drop policy if exists "users_manage_own_private_records"
  on public.user_private_records;
create policy "users_manage_own_private_records"
  on public.user_private_records
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.user_private_records to authenticated;

create or replace function public.get_my_sync_storage_usage()
returns table (total_bytes bigint, total_rows bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(row_bytes), 0)::bigint, count(*)::bigint
  from (
    select pg_column_size(t)::bigint as row_bytes from public.user_tasks t where t.user_id = auth.uid()
    union all
    select pg_column_size(r)::bigint from public.user_donelist_entries r where r.user_id = auth.uid()
    union all
    select pg_column_size(h)::bigint from public.user_micro_habit_states h where h.user_id = auth.uid()
    union all
    select pg_column_size(p)::bigint from public.user_private_records p where p.user_id = auth.uid()
  ) as user_rows;
$$;

grant execute on function public.get_my_sync_storage_usage() to authenticated;
