# AI assistant: cost, latency, and the zero-key default

Research report. Compiled 2026-09-21 against primary sources (provider pricing
pages, official API docs, model cards, and library source). Every load-bearing
claim carries its URL. Items that could not be confirmed are labelled
**unverified** rather than smoothed over.

Companion to `DECISIONS.md` §4 (AI-assistant decisions) and §5.3 (open-source
pivot). This report does not change any decision on its own; it is the evidence
a decision would rest on.

---

## 0. The measured baseline

Measured against this repo on 2026-09-21 rather than taken from any doc — the
internal notes were stale, still describing 15 tools.

| Quantity | Value | Source |
|---|---|---|
| Tools exposed to the model | **23** | `apps/api/src/tools.ts` |
| `SYSTEM_PROMPT` | **~1,745 tokens** | ~6,978 chars |
| `TOOL_DEFS` | **~3,073 tokens** | ~12,291 chars |
| **Fixed prefix resent every request** | **~4,818 tokens** | sum of the above |
| `MAX_TOOL_ROUNDS` | **10** → up to **11 upstream calls per user turn** | `apps/web/src/chat/useChat.ts:176` |
| Request timeout | **45 s, wall-clock, per request** | `useChat.ts:48,54-55` |
| Model / effort / budget | `gpt-5-mini`, `reasoning_effort: "minimal"`, `max_completion_tokens: 8000` | `apps/api/src/app.ts:237-245` |
| Daily cap | 50 requests per identity | `app.ts:204` |

Token counts are character-based estimates at 4 chars/token, not a tokenizer
run. They are accurate enough for the conclusions below and should be
re-measured with `tiktoken` before anyone optimises against a specific number.

The shape of the cost is therefore: **a ~4,800-token prefix multiplied by up to
11 round trips, plus a conversation history that is resent in full on every
round.** Input grows quadratically in rounds within a turn. Output is small by
comparison. This is a caching-and-round-count problem, not a model-choice
problem, and that ordering drives everything below.

---

## 1. The single highest-leverage finding

**You cannot currently see your own cache hit rate.** `app.ts:260` pipes
`upstream.body` straight through to the client. Nothing parses the final SSE
chunk, so `usage.prompt_tokens_details.cached_tokens` is never read, logged, or
surfaced. Every cost conclusion in this report is unfalsifiable against your
own traffic until that changes.

OpenAI reports cached tokens in the usage block; with `stream: true` you must
request usage explicitly via `stream_options: {"include_usage": true}` for the
final chunk to carry it.
<https://developers.openai.com/api/docs/guides/prompt-caching>

**Recommendation, before any other change:** add `stream_options.include_usage`,
tee the final chunk server-side, and log `prompt_tokens`, `cached_tokens`,
`completion_tokens`, `reasoning_tokens`, and `finish_reason` per request. That
is a small change to a stateless proxy that stores nothing, and it converts
every item below from speculation into measurement.

---

## 2. Prompt caching

This is where the money is, because the prefix is ~4,818 tokens and it repeats
up to 11 times per turn.

### Mechanics, by provider

| | OpenAI | Anthropic | Google |
|---|---|---|---|
| Mode | Automatic (implicit) | **Explicit only** (`cache_control` breakpoints, max 4) | Implicit, on by default for 2.5+ |
| Minimum prefix | 1,024 tokens (GPT-5.6+); varies on older models | **512–4,096, model-dependent** | **4,096** (Gemini 3.x), 2,048 (2.5) |
| TTL | ~30 min on GPT-5.6+ (`prompt_cache_options.ttl`); ~5–10 min idle on older | 5 min default, 1 h opt-in | **undocumented** |
| Discount | 0.1× input | 0.1× read; **1.25× write** (5 m) or 2× (1 h) | 0.1× (inferred from the pricing table) |
| Covers tool definitions? | Yes | Yes — `tools` is prefix position 0 | Yes, via `CachedContent.tools[]` |

Sources: <https://developers.openai.com/api/docs/guides/prompt-caching> ·
<https://platform.claude.com/docs/en/build-with-claude/prompt-caching> ·
<https://ai.google.dev/gemini-api/docs/caching>

### What invalidates a cache, and why it matters here

OpenAI: changing "tool names, descriptions, schemas, **ordering**, or
tool-specific instructions" invalidates. So does changing the model,
`parallel_tool_calls`, `reasoning.effort`, or response-format settings. "Cache
reuse requires the entire rendered prefix to match."

Anthropic's hierarchy is `tools → system → messages`; a change at one level
invalidates that level and everything after it. Changing **tool definitions**
invalidates the entire cache; changing `tool_choice` or
`disable_parallel_tool_use` invalidates messages; changing thinking/effort
config invalidates messages and, on some models, tools and system too.
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>

**Assessment of the current code:** `TOOL_DEFS` is a module-level constant in
fixed order and `app.ts:247` maps it identically every request, so tool ordering
is already stable. `reasoning_effort` and `model` come from env and do not vary
per request. There is no obvious cache-breaking bug. But see §1 — this is
inference from reading the code, not observation.

### Anthropic-specific trap

Claude Haiku 4.5's minimum cacheable prompt is **4,096 tokens**, the highest in
the lineup, and falling below it is a **silent no-op** with no error. Your
prefix is ~4,818 tokens, so it clears the bar today — but any tool
consolidation that trims the prefix (see §4) could drop it under 4,096 and
silently disable caching on that provider. If Haiku is ever offered, assert on
`cache_read_input_tokens` in a test.
<https://platform.claude.com/docs/en/about-claude/models/overview>

Also note Haiku 4.5's documented retirement date is **not sooner than
2026-10-15** — under a month out. Do not pin it.

---

## 3. Pricing

Read from live pricing pages on 2026-09-21. **These postdate this project's
last model decision and the lineup has moved substantially.** Re-check before
acting; prices below include at least one dated promotion.

### Cached input is the number that matters for a tool loop

| Model | Input | **Cached input** | Output | Notes |
|---|---|---|---|---|
| gpt-5-nano | $0.05 | **$0.005** | $0.40 | |
| gpt-5.6-luna | $0.20 | **$0.02** | $1.20 | **billed cache write at 1.25×** |
| **gpt-5-mini (current)** | $0.25 | **$0.025** | $2.00 | cache writes free |
| Gemini 3.1 Flash-Lite | $0.25 | $0.025 | $1.50 | |
| Gemini 3.5 Flash-Lite | $0.30 | $0.03 | $2.50 | |
| Gemini 3.8 Flash | $0.75 | $0.075 | $3.75 | **doubles 2027-01-01** |
| Claude Haiku 4.5 | $1.00 | $0.10 | $5.00 | 4,096-token cache floor |

USD per million tokens. <https://developers.openai.com/api/docs/pricing> ·
<https://ai.google.dev/gemini-api/docs/pricing> ·
<https://platform.claude.com/docs/en/about-claude/pricing>

**The GPT-5.6 generation introduces a billed cache write at 1.25× base input.**
On gpt-5-mini and every pre-5.6 model, cache writes are free. For a long tool
loop that keeps extending its cached prefix every round, that charge recurs, and
it can erase luna's headline advantage. **Staying on gpt-5-mini is defensible
on exactly this ground** and should be modelled against real turn counts rather
than assumed either way.

### Batch and Flex

All three providers offer ~50% off via 24-hour batch APIs. **All are irrelevant
to an interactive browser loop.** OpenAI's **Flex processing** gives batch
pricing synchronously but documents "slower response times," a 10-minute default
timeout, and possible 429s — wrong trade for a chat, potentially right for any
future offline catalog-normalisation pass.
<https://developers.openai.com/api/docs/guides/flex-processing>

### Free tiers

**Google is the only provider with a real free tier** covering Gemini Flash and
Flash-Lite, and it is the strongest argument for offering Gemini as a BYO-key
option. The catch is explicit and belongs in your UI, not a footnote: the
pricing table marks free-tier content as used to improve Google's products, and
the terms confirm "human reviewers may read, annotate, and process your API
input and output."
<https://ai.google.dev/gemini-api/terms>

For a planner handling course history, that is a consent question. Your privacy
page currently promises local-first with no chat storage; a free-tier Gemini
default would contradict it unless disclosed at the point of key entry.

**Unverified:** Google no longer publishes free-tier RPM/TPM/RPD figures
publicly; the rate-limits page defers to a login-gated AI Studio dashboard. You
cannot document free-tier throughput from public sources.

OpenAI and Anthropic have no free tier.

---

## 4. Reducing round trips

Round count multiplies everything. Going from 11 rounds to 3 is a larger saving
than any model swap in §3.

### Parallel tool calls

Default-on at OpenAI (`parallel_tool_calls`, default true) and Anthropic. Your
client already iterates multiple tool calls per assistant turn
(`useChat.ts:197`), and since your tools are local synchronous engine calls, the
sequential `for` loop costs nothing. **So the mechanism is in place; what is
missing is the model being told to use it.**

Anthropic publishes the exact prompt wording, and it generalises:

> For maximum efficiency, whenever you need to perform multiple independent
> operations, invoke all relevant tools simultaneously rather than sequentially.

<https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use#maximizing-parallel-tool-use>

Adding a line to that effect in `SYSTEM_PROMPT` is free, is documented by the
vendor, and directly attacks round count. **Highest value-per-effort change in
this report.**

### Tool count

You have 23 tools and ~3,073 tokens of definitions. OpenAI's guidance is to
"aim for fewer than 20 functions available at the start of a turn," and to fold
always-paired calls together: "If you always call function A after function B,
just move the marking logic into the query function call."
<https://developers.openai.com/api/docs/guides/function-calling>

Anthropic is more explicit: "Consolidate related operations into fewer tools.
Rather than creating a separate tool for every action (`create_pr`, `review_pr`,
`merge_pr`), group them into a single tool with an `action` parameter. Fewer,
more capable tools reduce selection ambiguity."
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>

23 is past OpenAI's threshold but below Anthropic's tool-search threshold
(which wants ≥10 tools *and* >10k tokens of definitions), so **consolidation is
the indicated fix, not dynamic tool loading.** Candidate merges from the current
list: the `set_schedule_constraint` / `clear_schedule_constraint` pair, and the
`attach_iug` / `detach_iug` / `list_iug_programs` trio, both collapse cleanly
into `action`-parameterised tools.

Watch the interaction with §2: trimming the prefix below 4,096 tokens disables
caching on Anthropic silently.

### Structural options, and why they probably do not fit

Both OpenAI and Anthropic now ship **programmatic tool calling**, where the
model writes code that calls your tools in a loop without being re-sampled
between calls. Anthropic reports "24% fewer input tokens" on their benchmarks.
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
·
<https://developers.openai.com/api/docs/guides/programmatic-tool-calling>

**This is the textbook fix for a round cap, and it does not fit your
architecture.** The code runs in the *provider's* sandbox, which has no network
access to the student's browser, and your tools execute client-side against
local plan state by deliberate design (`DECISIONS.md` §1, "Chat architecture").
Adopting it would mean moving plan state server-side, which reverses a decision
made for good reasons. Recorded here so the option is documented as considered
and rejected, not overlooked.

---

## 5. The 45-second timeout is mis-shaped

`useChat.ts:54-55` arms a single 45-second `AbortController` before the fetch
and never resets it. That is a **wall-clock cap on the whole response**, not an
idle timeout.

Anthropic documents that during tool-argument generation "there may be delays
between streaming events while the model is working," because current models
emit "one complete key and value property from `input` at a time."
<https://platform.claude.com/docs/en/build-with-claude/streaming>

So a healthy request that spends 46 seconds producing a large tool call is
indistinguishable from a hang, and gets aborted. **Reset the timer on every SSE
event** and keep a separate, larger wall-clock ceiling. This matters more as
plans get larger, which is exactly when `get_plan` results grow.

---

## 6. Token starvation: already fixed, with a residual gap

`DECISIONS.md` §4.2 diagnosed this correctly and the fix (`reasoning_effort:
"minimal"`, budget 2048 → 8000) matches vendor guidance. OpenAI documents the
exact failure mode:

> If the generated tokens reach the context window limit or the
> `max_output_tokens` value you've set, you'll receive a response with a status
> of `incomplete` [...] this can occur **before any visible output tokens are
> produced**.

<https://developers.openai.com/api/docs/guides/reasoning>

Two things remain:

1. **`reasoning_effort: "none"` now exists** on current OpenAI models and is
   strictly better than `"minimal"` for a tool-driven advising chat where the
   engine does the reasoning. (Not universal: GPT-6 Astra rejects `none` with a
   400.) It is part of the cache key, so set it once and hold it.
2. **The client still cannot distinguish "empty" from "truncated."** The
   `content || "(no response)"` fallback that fired during the §4.2 incident is
   still the only handling. Branch on `finish_reason === "length"` and retry with
   a higher budget, or at minimum tell the user what happened rather than
   showing a blank bubble.

Note also, for any future Anthropic path: thinking tokens share `max_tokens`
with the answer on every provider, so the control for cost is the effort
parameter, never a tight output cap.

---

## 7. The zero-key default

`README.md` roadmap promises "Provider-agnostic AI: local model by default,
bring-your-own-key as an upgrade." The research says the "local model by
default" half is harder than it looks.

### In-browser inference does not work for this

- **WebLLM gates tool calling to a 5-model allowlist**, all 7B+. Verified in
  source (`src/config.ts:344`, v0.2.85): the smallest model that accepts
  `tools` is **Hermes-2-Pro-Mistral-7B at a 4.08 GB download**. It also injects
  its own system prompt and throws `CustomSystemPromptError` if you supply one,
  which is fatal for a 23-tool advising persona.
  <https://github.com/mlc-ai/web-llm>
- **Chrome's Prompt API shipped for the web in Chrome 148, but function calling
  never shipped** — chromestatus feature `5085580563841024` is status
  `Proposed`. It also requires **22 GB free disk and >4 GB VRAM**, and is
  desktop-only: "Chrome for Android, iOS, and ChromeOS on non-Chromebook Plus
  devices are not yet supported." Mozilla's standards position is `negative`
  and WebKit's is `oppose`.
  <https://developer.chrome.com/docs/ai/get-started>
- **transformers.js v4.2+ does pass `tools` through** to the chat template but
  does not parse tool calls back out, and its structured-output package is
  self-described "Experimental."
- **wllama** (MIT, llama.cpp in WASM) is the best in-browser path and is the one
  most write-ups miss: arbitrary GGUF, OpenAI-compatible API, documented tool
  calling. Smallest credible artifact is **Granite 4.0 350M at 223 MB (Q4_K_M)**.
  <https://github.com/ngxson/wllama>

Even the best case is a 223 MB opt-in download. That is better than the 2–3 GB
WebLLM figure that got in-browser inference rejected in `DECISIONS.md` §1, but
it is not a default for phone users.

### The option your architecture already pays for

You deploy on Cloudflare Pages with a Worker. **Workers AI** gives a zero-key,
zero-download default billed to your account:

- **10,000 Neurons/day free**, on both the Free and Paid Workers plans, resetting
  daily at 00:00 UTC. <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- `@cf/ibm-granite/granite-4.0-h-micro` (3B, Apache 2.0, 131K context) is tagged
  **Function calling**, at 1,542 neurons/M input and 10,158 neurons/M output.
- At your measured ~4,800-token prefix plus tool results, that is very roughly
  **on the order of 1,000 turns/day account-wide** — a shared budget, not
  per-user, so it is a demo/free-tier allowance rather than a scaling answer.

**Unverified and blocking:** Cloudflare's OpenAI-compat docs do not explicitly
confirm `tools` passthrough on that endpoint. Smoke-test before committing.

### Local desktop runtimes, and a browser change that breaks the old advice

| Runtime | OpenAI path | Tools | `tool_choice` | CORS default |
|---|---|---|---|---|
| **llama.cpp** `llama-server` | `/v1/chat/completions` | yes | yes | **open (`*`)** |
| Ollama | `/v1/chat/completions` | yes | **no — silently dropped** | localhost only; needs `OLLAMA_ORIGINS` |
| LM Studio | `/v1/chat/completions` | yes | yes | **disabled**; needs `lms server start --cors` |

Ollama's missing `tool_choice` is source-confirmed: the `ChatCompletionRequest`
struct in `openai/openai.go` has no `ToolChoice` field. Do not depend on
`tool_choice: "required"` in a portable layer.

Also: **`--jinja` is now on by default in llama.cpp** ("default: enabled" in
`tools/server/README.md`); the older `docs/function-calling.md` saying you must
pass it is stale.

**The change that invalidates most published guidance:** Chrome 142 shipped
**Local Network Access**, and unlike the older Private Network Access spec it
**covers loopback**. chromestatus `5152728072060928`: "A local network request is
any request from a public website to a local IP address **or loopback**." A
permission prompt now gates `https://lionsdegree.com → http://localhost:11434`,
and denial fails the request. Chrome stable is at 153, so this is in force
today. Firefox is rolling out the same from 149–151; WebKit merged its LNA
implementation in September 2026 but has shipped no release note.

Mixed content is *not* the blocker (loopback is a potentially-trustworthy
origin), but the permission prompt is. Any "point at your local model" feature
needs explicit UI for it: feature-detect with
`navigator.permissions.query({name: "loopback-network"})`, and do not fire the
first request from a service worker or the prompt will not appear.

### Laya: ruled out

Confirmed against the model card and GitHub. Laya is a **non-autoregressive
typed-decision classifier** — ModernBERT-large backbone, a decision head, three
primitives (`choice`, `score`, `noul`). It never generates text. It cannot emit
a tool call with arguments (its output space is fixed enum labels, not
structured objects) and cannot explain a result in prose. Its own card says it
"is a fast base to specialise, not a zero-shot decision engine": base checkpoint
accuracy is **0.362**, near chance, and only the fine-tuned typed-decisions
checkpoint reaches 0.766. Weights are 843 MB.
<https://huggingface.co/convaiinnovations/laya>

It is architecturally incapable of being the assistant. A 223 MB Granite GGUF
that does the whole job dominates it on every axis. Its only plausible use in
this project is pipeline-side review-queue triage, which is a different problem
from this report's.

---

## 8. Provider-agnostic layer

There is no standard. The nearest thing is OpenAI's own OpenAPI document
(MIT-licensed, <https://github.com/openai/openai-openapi>), which describes
OpenAI's API rather than a neutral spec.

**Portable subset** — safe across OpenAI, Gemini, Anthropic's compat layer,
Ollama, llama.cpp, LM Studio, OpenRouter:

- `POST {base}/v1/chat/completions`; roles `system`/`user`/`assistant`/`tool`
- `stream: true` with SSE and `[DONE]`; `temperature`, `top_p`, `max_tokens`
- `tools: [{type:"function", function:{name, description, parameters}}]`
- `choices[0].message.tool_calls[] = {id, type, function:{name, arguments}}`,
  where `arguments` is a **JSON string**
- tool results as `{role:"tool", tool_call_id, content}`

**Keep out of the portable layer:**

- **Reasoning controls.** `reasoning_effort` is ignored by Anthropic's compat
  layer, supported by Ollama with non-standard extensions, and handled
  differently again by Gemini. This is the worst divergence.
- **`strict` / structured outputs.** Anthropic's compat layer states plainly
  that `strict` "is ignored, which means the tool use JSON is not guaranteed to
  follow the supplied schema." **Validate every tool call's arguments against
  your own schema client-side before dispatch, on every provider.** Your engine
  is deterministic and your iron rules demand conservative degradation; trusting
  a vendor flag for argument validity is inconsistent with both.
- **`tool_choice: "required"`** — silently dropped by Ollama.

Anthropic's own framing is worth quoting before anyone treats its compat layer
as a production target: it is "primarily intended to test and compare model
capabilities, and is not considered a long-term or production-ready solution for
most use cases," and "most unsupported fields are silently ignored rather than
producing errors."

---

## 9. What I would do, in order

1. **Instrument usage** (§1). Everything else is guesswork until cache hit rate
   and reasoning-token spend are visible. Smallest change here, largest
   epistemic gain.
2. **Add the parallel-tool-call instruction** to `SYSTEM_PROMPT` (§4). Free,
   vendor-documented, attacks the round-count multiplier.
3. **Make the 45 s timeout idle-based** (§5). Fixes a real failure on healthy
   requests.
4. **Handle `finish_reason === "length"`** instead of rendering "(no response)"
   (§6). Closes the last gap from the §4.2 incident.
5. **Switch `reasoning_effort` to `"none"`** and confirm via the new usage
   logging that `reasoning_tokens` drops to zero (§6).
6. **Consolidate 23 tools toward ~15** (§4), watching the 4,096-token Anthropic
   cache floor.
7. *Then* revisit the model choice (§3) with real per-turn token counts in hand.
   Not before — the round count and cache hit rate move cost more than the price
   list does.

The zero-key default (§7) is a separate project, and the honest summary is that
no shipped browser API does tool calling today. Workers AI is the pragmatic
free default given you already deploy on Cloudflare; in-browser inference is an
opt-in privacy tier at 223 MB, not a default.

---

## Unverified items

Carried forward verbatim so nobody treats them as settled:

- Cloudflare Workers AI `tools` passthrough on the OpenAI-compat endpoint.
- Google's implicit-cache TTL, invalidation rules, and whether the hourly
  storage fee applies to implicit caching.
- Google free-tier RPM/TPM/RPD (login-gated).
- Gemini: no documented parallel-tool-call disable switch; no confirmed
  incremental function-call-argument streaming events.
- Whether the OpenAI models listed as `gpt-5.4-*` on the pricing page are still
  supported; they do not appear on the models page.
- Safari's Local Network Access behaviour — WebKit merged the implementation in
  September 2026 with no shipping release note found. Test on real hardware.
- No vendor endorses *executing* a tool on partially-streamed arguments;
  Anthropic explicitly warns accumulated input may be invalid JSON.
- Token counts in §0 are 4-chars/token estimates, not tokenizer output.
