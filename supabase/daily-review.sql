create table if not exists public.user_donelist_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_date)
);

alter table public.user_donelist_entries enable row level security;

drop policy if exists "users_manage_own_donelist_entries"
  on public.user_donelist_entries;
create policy "users_manage_own_donelist_entries"
  on public.user_donelist_entries
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.user_donelist_entries to authenticated;
