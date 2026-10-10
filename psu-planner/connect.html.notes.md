# Connect page — scratch notes (not shipped)

Why a hand-authored page and not the legal generator: the legal generator
renders prose blocks. This page is a numbered procedure with a copyable field,
which is a different shape, and forcing it through `Block`/`Inline` would mean
inventing a "step" and a "copy field" node type for one consumer.

Non-negotiables from the brief:
- No code anywhere. No `npx`, no JSON, no file paths.
- The whole thing is: sign in, copy a link, paste it, approve.
- Must read with JavaScript off (the copy button is an enhancement, the link
  text is always selectable).

Open dependency: the connector URL does not exist yet. The hosted MCP server
(Worker + OAuth + Supabase) is a separate build. The page ships with the URL
visible but a clear "not live yet" state, so nobody pastes a dead link.
