create table if not exists public.user_micro_habit_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"habits": [], "completions": {}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_micro_habit_states enable row level security;

drop policy if exists "users_manage_own_micro_habit_states"
  on public.user_micro_habit_states;
create policy "users_manage_own_micro_habit_states"
  on public.user_micro_habit_states
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.user_micro_habit_states to authenticated;
