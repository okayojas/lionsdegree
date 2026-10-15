-- Feedback from the Contact section of the landing page.
--
-- WRITE-ONLY BY DESIGN. The browser already carries the anon key (it is
-- public by design and the app ships it for auth and plan sync), so the form
-- can insert straight from the page with no server in between. That is only
-- safe because the policies below grant INSERT and nothing else: there is no
-- select policy, so one visitor cannot read another's message, and with RLS
-- on, "no policy" means "denied" rather than "allowed".
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  -- What they wrote. Required, and bounded: an unbounded text column on an
  -- open insert endpoint is a free blob store for anyone who finds it.
  body text not null,
  -- Optional. Someone reporting a bug usually wants an answer; someone
  -- complaining usually does not, and should not have to identify themselves.
  email text,
  -- Which page they were on. Plain context for triage, set by the client.
  page text,
  -- Set from the session when they happen to be signed in. Never required:
  -- feedback that only signed-in students can leave is feedback from the
  -- students who already got far enough to sign in.
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint feedback_body_len check (char_length(body) between 4 and 4000),
  constraint feedback_email_len check (email is null or char_length(email) <= 320),
  constraint feedback_page_len check (page is null or char_length(page) <= 200)
);

alter table public.feedback enable row level security;

-- Anyone may leave feedback, signed in or not.
create policy "anyone may leave feedback" on public.feedback
  for insert with check (true);

-- Deliberately NO select, update or delete policy. Reading is done from the
-- Supabase dashboard with the service role, which bypasses RLS. If a reading
-- UI is ever built, it needs its own policy and an explicit decision about
-- who counts as staff -- not a blanket `using (true)` bolted on here.

-- Triage order is almost always newest-first.
create index if not exists feedback_created_at_idx on public.feedback (created_at desc);
