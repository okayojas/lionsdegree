-- An anonymous count of Plans (#70).
--
-- One row each time the planner builds a Plan, and one the first time it
-- opens a Plan that existed before this shipped. A row says which of the
-- two it was, which Edition the Plan is for, and the day. Nothing in it
-- says whose Plan, which Plan, or which device: there is no user id, no
-- plan id and no time of day, on purpose. The privacy policy describes
-- exactly these columns.
--
-- INSERT-ONLY THROUGH THE API. Anyone holding the public key may add a row;
-- nobody may read, change or delete one with it. The owner reads the table
-- with SQL in the dashboard. Because anyone may insert, the number can be
-- inflated by someone who wants to: it is a rough count for the owner, not
-- a figure to publish.
create table if not exists public.plan_events (
  id bigint generated always as identity primary key,
  -- Set here, not by the client: a browser cannot backdate a count, and no
  -- time of day is kept.
  day date not null default current_date,
  kind text not null check (kind in ('created', 'existing')),
  -- "2026-2027", or null where the planner did not know.
  edition text check (edition is null or edition ~ '^\d{4}-\d{4}$')
);

alter table public.plan_events enable row level security;

-- The one thing the API may do. No select, update or delete policy exists,
-- so row level security refuses all three.
create policy "anyone may add a count" on public.plan_events
  for insert to anon, authenticated
  with check (true);

-- The client sends only `kind` and `edition`. `id` and `day` are the
-- database's.
revoke all on public.plan_events from anon, authenticated;
grant insert (kind, edition) on public.plan_events to anon, authenticated;

-- What the owner runs:
--   select day, kind, count(*) from plan_events group by 1, 2 order by 1;
--   select kind, count(*) from plan_events group by 1;
