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

**Read-only.** It cannot change your plan. Editing is done in the planner.

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

## Licence

Apache-2.0. Course data is Penn State's; see NOTICE in the repository.
