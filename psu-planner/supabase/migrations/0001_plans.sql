-- LionsDegree plan sync. One row per (user, plan). Deny-by-default RLS:
-- users can only ever touch their own rows (OWASP A01 Broken Access Control).
create table if not exists public.plans (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  doc jsonb not null,
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.plans enable row level security;

create policy "own plans select" on public.plans
  for select using (auth.uid() = user_id);
create policy "own plans insert" on public.plans
  for insert with check (auth.uid() = user_id);
create policy "own plans update" on public.plans
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own plans delete" on public.plans
  for delete using (auth.uid() = user_id);

-- Guardrail against oversized docs (a plan is ~10-50 KB).
alter table public.plans add constraint doc_size check (pg_column_size(doc) < 1048576);
