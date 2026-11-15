# lionsdegree-mcp

Ask your own AI about your Penn State degree.

This is an [MCP](https://modelcontextprotocol.io) server. It runs on your
machine, reads a plan file you control, and answers questions about it. No
account, no API key, no network — your coursework never leaves your computer,
and running it costs the project nothing.

**Unofficial.** Not affiliated with, endorsed by, or an official product of The
Pennsylvania State University. Course data may be out of date or wrong. Verify
everything with your academic adviser and LionPATH.

## Setup

First, export your plan from the planner: **Menu → Save plan to a file**.

Then add this to your assistant's MCP configuration:

```json
{
  "mcpServers": {
    "lionsdegree": {
      "command": "npx",
      "args": ["-y", "lionsdegree-mcp", "--plan", "/path/to/your-plan.json"]
    }
  }
}
```

In Claude Desktop that file is `claude_desktop_config.json`; in Claude Code,
`.mcp.json`. Restart the assistant and ask it something about your degree.

`LIONSDEGREE_PLAN` works instead of `--plan` if you prefer an environment
variable.

## What it can do

| Tool | Answers |
|---|---|
| `get_plan` | Your terms, courses, open requirement slots, credits |
| `search_catalog` | Courses by topic or by code |
| `get_course_details` | One course: description, prerequisites, Gen Ed tags |
| `check_prerequisites` | Whether your plan satisfies a course by a given term |
| `get_prereq_chain` | The whole prerequisite tree, in one call |
| `search_programs` | Majors, minors and certificates |
| `get_program_requirements` | What any program requires, including ones you have not declared |
| `audit_requirements` | What each of your programs still needs |
| `discover_programs` | Programs that fit what you have already taken |
| `list_iug_programs` | Integrated bachelor's-and-master's degrees that pair with your major |
| `simulate_change` | What a change *would* do — see below |
| `simulate_changes` | What several changes would do *together* — see below |

**The two simulations are the ones worth knowing about.** "What would my plan
look like if I studied abroad next fall?" runs the change against a copy and
hands back the candidate plan, what moved, and any prerequisite it breaks.
Your stored plan is not touched. It is the real optimiser, not a preview of
one, so what you are shown is what you would get.

And nine that change your plan:
And the ones that change your plan:
`simulate_changes` takes a list and previews the lot as one candidate, which
is the honest answer to "out in seven terms, I've got AP calc, and abroad
junior spring". Previewing those one at a time does not answer it: the
optimiser re-flows the whole plan on every change, so separate previews are
separate futures. If one change in the list cannot be made, the whole preview
stops and says which — you never get a plan with some of them in it.

And seven that change your plan:

| Tool | Does |
|---|---|
| `add_course` | Puts a course in a term |
| `remove_course` | Takes one out — see below |
| `move_course` | Moves one to another term, keeping what the program attached to it |
| `swap_alternative` | Takes the alternative your program already offers ("CAS 100A or CAS 100B") |
| `restore_course` | Puts a removed course back where your program had it |
| `set_schedule_constraint` | "Not that term", "no earlier than", "exactly there" |
| `clear_schedule_constraint` | Lifts one again, and re-flows the schedule |
| `optimize_schedule` | Repacks the whole plan in one call |
| `fill_slot` | Chooses a course for an open requirement |
| `add_term` | Appends an empty term |
| `skip_term` | Marks a term as a gap year, co-op or leave |
| `attach_iug` | Folds an integrated master's on after your bachelor's |
| `detach_iug` | Takes it back off |

**An IUG is a bachelor's and a master's taken as one programme**, with some
coursework counting toward both under the Graduate Bulletin's GCAC-210. The
double-count cap and the eligible courses come from the programme's own
published figures, and its admission requirements are quoted word for word
with a link to the page they came from — so you can check the citation.
Attaching one here plans it; it does not apply for it.
| `restore_term` | Un-skips one, and lets coursework flow back into it |
| `delete_term` | Removes an empty term — refused if anything is in it |

**Everything it can do, it can undo.** Setting a constraint has a tool that
lifts it, removing a course has one that restores it, skipping a term has one
that un-skips it. An assistant whose every action is one-way is not one to let
near your degree.

**Moving is not remove-then-add.** A course carries where your program put it
(which is what lets a double major's shared requirement count once) and the
alternatives your program offered for it. `move_course` keeps both; removing
and re-adding keeps neither.

**Every change says which revision it was computed from.** Each of these takes
`based_on_revision` — the `revision` you last read. If you have edited your
plan in the planner since then, the change is refused rather than allowed to
overwrite you, and your assistant is told to re-read and try again. Nothing is
ever merged on a guess.

**Removing a required course needs your words, not your assistant's.** A course
your degree requires is refused unless the call carries the sentence you used
when you asked for it, and that sentence comes back in the answer so you can
see what was claimed on your behalf. This cannot prove you said it — nothing at
that layer can — but a quiet boolean nobody sees is no longer enough.

## Two things it deliberately will not tell you

**Which semesters a course runs.** That lives in LionPATH, which does not
permit automated access, so nothing here implies a course is offered in a term.
Check LionPATH before you commit to a schedule.

**That a requirement is met when it cannot tell.** A prerequisite written as
free text — "senior standing", "permission of the program" — is reported as
*cannot determine*, never as satisfied. An answer that sounds confident and is
wrong is worse than one that admits a gap.

## Bulletin editions

Your requirements come from the bulletin in force when you entered your major,
not the newest one. The server reads the edition recorded in your plan file and
loads only that one. If your plan names an edition this package does not carry,
it says so and stops rather than answering against a different bulletin.

## Running the hosted connector (maintainers)

`mcp.lionsdegree.com` is a Cloudflare Worker. `wrangler.toml` holds everything
that can live in version control. The two secrets below cannot, and the
connector fails closed without them — a deploy missing either refuses every
request rather than quietly serving an open one.

**The order matters.** The website tells students the connector works, so the
site must not deploy until the connector does.

```
# 1. Secrets, from packages/mcp
npx wrangler secret put SUPABASE_JWT_SECRET   # Supabase → Settings → API → JWT Secret
npx wrangler secret put SUPABASE_ANON_KEY     # public by design, but it is config, not code

# 2. Deploy the connector. NOT `wrangler deploy` on its own: the catalog is
#    generated, not committed, so a clean clone would ship a Worker with no
#    assets and throw "missing its assets" on every request.
npm run worker:deploy
```

3. **Supabase → Authentication → URL Configuration** — add
   `https://mcp.lionsdegree.com/callback` to the allowed redirect URLs. Without
   it the sign-in hop comes back rejected, and the failure looks like the
   student's assistant misbehaving.
4. **Apply the migrations** in `supabase/migrations`. `0003` is the one that
   refuses a plan write whose revision went backwards; without it the
   compare-and-swap loses its backstop.
5. **Check the connector before publishing the address:**

   ```
   curl https://mcp.lionsdegree.com/health
   ```

   It answers with the edition, the course count, and what the last scheduled
   self-check found. `"last_self_check": {"recorded": false}` means no report
   is stored — the cron may not be firing, the write may be failing, or the
   last one may have aged out. It does not distinguish them, and neither
   should you without looking.

   `/health` does not exercise sign-in. The only way to know the whole flow
   works is to do it: paste the address into a real assistant, sign in,
   approve, and ask it something about your own plan.

6. **Only then deploy the website**, from `psu-planner`:

   ```
   pnpm --filter web run deploy
   ```

7. **Turn on Actions notifications**, so the monitor below can reach you. See
   "Watching the connector".

## Watching the connector

There is no Workers error alert in Cloudflare's notification catalogue — on
any plan — and Standalone Health Checks needs Pro. An earlier version of this
file said to switch on a Worker alert under the Worker's own Settings; no such
thing exists, which is worth stating rather than quietly deleting.

So `/health` is built to be watched by something external, and the thing
watching it is **a scheduled GitHub Action in this repository** (#58). No
third-party account, nothing to pay for, and the alert arrives where the
repository already sends notifications.

### Where it lives

| What | Where |
| --- | --- |
| The schedule and the caller | `.github/workflows/connector-health.yml` |
| The decision — what counts as broken | `psu-planner/packages/mcp/scripts/check-connector-health.mjs` |
| The tests for that decision | `psu-planner/packages/mcp/test/connector-health-monitor.test.ts` |

The decision is a script and not a `curl` line in the YAML because it has to
be testable: the failures this connector has actually had were silent by
construction, and a check nothing verifies is the same class of thing. Run it
yourself with `node scripts/check-connector-health.mjs` from
`psu-planner/packages/mcp`; it prints one line and exits non-zero when the
connector is not answering. Pass a URL as the first argument to point it
somewhere else.

### What it fails on, and why each one matters

- **A non-200.** `/health` answers 503 when the connector is not serving
  students, not merely when the process is down — including the case where
  the gate is refusing everyone because a secret is missing, which is what
  this connector was doing in production with `/health` answering 200.
- **`ok: false` on a 200.** The status code tracks the *live* probe only, so a
  self-check that has failed on every run for the last hour arrives as a 200.
  A monitor that reads the status code and stops cannot see it.
- **A `last_self_check.at` older than 45 minutes.** Three cron periods. The
  self-check runs every fifteen minutes and Cloudflare does not promise every
  tick, so one missed run must not page; three is not weather. The threshold
  has to stay under an hour because `HEALTH_TTL` drops the report from KV at
  3600 seconds, after which `/health` says `recorded: false` instead — which
  also fails, but says less.
- **Anything it cannot read**: a body that is not JSON, a missing
  `last_self_check`, a timestamp that will not parse or is dated in the
  future. Iron rule 2 (`DECISIONS.md`): unparseable degrades to "cannot be
  checked", never to "fine".

It names which of those happened — `unreachable`, `unreadable`, `unhealthy`,
`stale` — because they send you to different places: the first is the network
between GitHub and Cloudflare, the second is something answering that is not
the Worker, the last two are the Worker.

### How the alert reaches you, and how to prove it does

GitHub emails the account whose credentials run a scheduled workflow — the
last person to modify the cron — when a scheduled run fails, **if that account
has Actions notifications enabled**. Check it at
<https://github.com/settings/notifications> under "Actions", and set it to
notify on failed workflows only.

That setting is the one part of this that cannot be committed to the
repository, so it is the one part that needs proving rather than trusting.
Prove it: **Actions → Connector health → Run workflow**, and put a URL that
cannot be healthy in the `url` box — `https://mcp.lionsdegree.com/healthz`
is a 404 and will do. The run goes red. If no mail arrives, the monitor is
not a monitor.

Note that a manual dispatch is not a *scheduled* run, and GitHub's
notification rules differ between the two: a dispatch you started notifies
you because you started it. To prove the scheduled path specifically, change
the URL default in the workflow on a branch, let one scheduled run fire, and
change it back.

### Changing it

- **Cadence**: the `cron:` line in the workflow. Fifteen minutes matches the
  Worker's self-check; polling faster reads the same report more often and
  detects nothing sooner.
- **Staleness threshold**: `MAX_REPORT_AGE_MS` in the script. If you move it,
  move the tests at 44 and 46 minutes with it, and keep it under the hour
  that `HEALTH_TTL` allows.
- **GitHub disables scheduled workflows in repositories with no activity for
  60 days.** A quiet repository switches its own monitor off. If this project
  goes quiet, check that the workflow is still enabled.

The scheduled self-check inside the Worker still earns its place: it runs the
same check from inside, records what it found so an outage that started
unobserved is discoverable afterwards, and throws so the failure appears in
**Workers → lionsdegree-mcp → Observability**. What it cannot do is tell
anybody. That is the monitor's job.

## Licence

Apache-2.0. Course data is Penn State's; see NOTICE in the repository.
