/** Who is asking, and how often.
 *
 * ONE IMPLEMENTATION, TWO WORKERS. The chat API and the hosted MCP
 * connector both have to answer the same two questions, and a second
 * copy of a security boundary drifts from the first — the project says
 * this out loud about prose fencing (DECISIONS.md 5.0 S4) and it is no
 * less true of a signature check. This started as the API's `verifyJwtSub`
 * and `rateLimit`; it is here so the connector uses the same code rather
 * than a lookalike.
 *
 * Web Crypto and KV only: both callers are Workers, so there is no Node
 * API in this file and none may be added.
 */
export * from "./jwt.js";
export * from "./rateLimit.js";
