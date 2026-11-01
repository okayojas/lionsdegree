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
| `audit_requirements` | What each of your programs still needs |
| `discover_programs` | Programs that fit what you have already taken |
| `simulate_change` | What a change *would* do — see below |

**`simulate_change` is the one worth knowing about.** "What would my plan
look like if I studied abroad next fall?" runs the change against a copy and
hands back the candidate plan, what moved, and any prerequisite it breaks.
Your stored plan is not touched. It is the real optimiser, not a preview of
one, so what you are shown is what you would get.

And seven that change your plan:

| Tool | Does |
|---|---|
| `add_course` | Puts a course in a term |
| `remove_course` | Takes one out — see below |
| `set_schedule_constraint` | "Not that term", "no earlier than", "exactly there" |
| `optimize_schedule` | Repacks the whole plan in one call |
| `fill_slot` | Chooses a course for an open requirement |
| `add_term` | Appends an empty term |
| `skip_term` | Marks a term as a gap year, co-op or leave |

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

7. **Cloudflare → Workers → lionsdegree-mcp → Settings → Alerts** — turn on the
   error-rate notification. The self-check runs every fifteen minutes and
   *throws* when the connector cannot answer, which is what makes the
   invocation visible to that alert. Without the alert switched on, a failing
   cron is a log nobody reads.

## Licence

Apache-2.0. Course data is Penn State's; see NOTICE in the repository.
