-- A Plan's `rev` must advance, or the write is refused.
--
-- THE BUG. Two tabs, or two devices, or (soon) a tab and an assistant.
-- Both read rev 5, both write. `pushPlan` compared `updated_at` in the
-- CLIENT and then upserted unconditionally, so whichever write landed
-- second won and the other student's edit was gone with nothing said. The
-- comparison was also a read followed by a write with no atomicity, so even
-- a correct client-side check loses the race it was written to win.
--
-- WHY IN THE DATABASE. A conflict rule honoured by one writer is not a
-- conflict rule. The planner is about to stop being the only writer — the
-- hosted connector's mutating tools write to this same row (#36) — and the
-- rule has to bind whoever shows up, including a client we have not written
-- yet and a model we do not control. Here it is one statement that cannot
-- be skipped, not a convention each caller has to remember.
--
-- WHY `rev` AND NOT A TIMESTAMP. Clocks on two devices disagree, and the
-- disagreement is silent. `rev` is a counter the writer increments from
-- what it read, so stating it IS stating what the write was based on:
-- "I computed this from rev 5". If the stored row is already at 6, that
-- claim is false and the write is refused rather than merged on a guess.
-- This is iron rule 2 applied to concurrency.

create or replace function public.plans_rev_must_advance()
returns trigger
language plpgsql
as $$
begin
  if new.rev is null or new.rev <= old.rev then
    -- The message carries both numbers because the client shows them to a
    -- student: "your copy is behind" is only actionable with the gap.
    raise exception
      'stale plan write: this update is based on rev %, but the stored plan is already at rev %',
      coalesce(new.rev, 0) - 1, old.rev
      using errcode = 'LD001',
            hint = 'Re-read the plan and apply the change to the current revision.';
  end if;
  return new;
end;
$$;

drop trigger if exists plans_rev_guard on public.plans;

create trigger plans_rev_guard
  before update on public.plans
  for each row
  execute function public.plans_rev_must_advance();

-- A first write is an INSERT and has nothing to be stale against, so the
-- trigger does not cover it; the primary key already stops two inserts of
-- the same (user, plan) from both landing.
