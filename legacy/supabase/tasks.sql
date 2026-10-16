create table if not exists public.user_tasks (
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null,
  content jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);

alter table public.user_tasks enable row level security;

drop policy if exists "users_manage_own_tasks"
  on public.user_tasks;
create policy "users_manage_own_tasks"
  on public.user_tasks
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.user_tasks to authenticated;
