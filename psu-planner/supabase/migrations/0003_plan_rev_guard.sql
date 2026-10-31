-- A Plan's `rev` must advance, or the write is refused.
--
-- THE BUG. Two tabs, or two devices, or (soon) a tab and an assistant.
-- Both read rev 5, both write. `pushPlan` compared `updated_at` in the
-- CLIENT and then upserted unconditionally, so whichever write landed
-- second won and the other student's edit was gone with nothing said. The
-- comparison was also a read followed by a write with no atomicity, so even
-- a correct client-side check loses the race it was written to win.
--
-- A BACKSTOP, NOT THE MECHANISM. The compare-and-swap is a conditional
-- update issued by the client: the row is matched on the revision the
-- writer last agreed with, so the compare and the swap are one statement
-- nobody can land inside. See ADR 0003.
--
-- This trigger only refuses a write that would move `rev` BACKWARDS, which
-- no correct client sends and which would quietly undo work if one did.
--
-- It is deliberately not the whole rule, because it cannot be: "rev must
-- increase" is monotonicity, not agreement. `rev` advances on every local
-- edit, including edits no server has seen — the push is debounced and two
-- quick edits coalesce — so a device at revision 7 writing over a server
-- at 6 may be perfectly in sync or may be about to destroy somebody's
-- work, and this trigger cannot tell which. The first version of this
-- migration tried, and got it wrong: two tabs at 5, one edits once and
-- pushes 6, the other edits twice and pushes 7, and 7 wins. The compare
-- has to name the base, which only the client knows.

create or replace function public.plans_rev_must_advance()
returns trigger
language plpgsql
-- Pinned so the function cannot be made to resolve a different `raise`
-- or operator through a caller's search_path (Supabase's linter asks for
-- this on every SECURITY-adjacent function, and it costs nothing here).
set search_path = ''
as $$
begin
  if new.rev is null or new.rev <= old.rev then
    -- The message carries both numbers because the client shows them to a
    -- student: "your copy is behind" is only actionable with the gap.
    raise exception
      'plan revision went backwards: tried to write rev %, but the stored plan is already at rev %',
      new.rev, old.rev
      using errcode = 'LD001',
            hint = 'Re-read the plan and apply the change to the current revision.';
    -- The message no longer fabricates a "based on" number. It used to
    -- print `new.rev - 1`, which is only the base when no edits coalesced
    -- -- so it told a confident story that was wrong exactly when the
    -- conflict was real.
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
