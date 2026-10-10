/** Deploy WITH the bundled advisor proxy. Not the default path.
 *
 * `wrangler pages deploy` compiles a `functions/` directory sitting in the
 * working directory — there is no flag to point it elsewhere. So the proxy
 * lives at `self-host/functions/`, where wrangler cannot find it, and the
 * default deploy ships static assets and nothing billable.
 *
 * This script puts it in place for one deploy and takes it away again, so a
 * self-hoster gets the proxy without the repository carrying a directory that
 * silently turns every future deploy into a billable one.
 *
 *   npm run deploy            -> no proxy, costs nothing to run
 *   npm run deploy:self-host  -> proxy included (needs the bindings below)
 *
 * The deployed function needs, set once in the Pages project:
 *   secret  OPENAI_API_KEY
 *   KV      RATE_LIMIT
 *   vars    OPENAI_MODEL, FREE_DAILY_LIMIT (optional)
 *
 * And the client needs VITE_CHAT_ENDPOINT=/v1/chat at BUILD time, or the
 * advisor stays hidden and the deployed function is never called.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "self-host", "functions");
const dst = path.join(web, "functions");

if (!fs.existsSync(src)) {
  console.error(`no proxy at ${src} — nothing to self-host.`);
  process.exit(1);
}
if (fs.existsSync(dst)) {
  // Left behind by an interrupted run. Refuse rather than clobber it, because
  // removing it in the cleanup below would delete whatever is actually there.
  console.error(`${dst} already exists. Remove it and re-run; it is generated, not source.`);
  process.exit(1);
}

if (!process.env.VITE_CHAT_ENDPOINT) {
  // FAIL, do not warn. This script runs after the build in the npm chain, so
  // a warning here arrives too late to act on and the deploy proceeds anyway:
  // a proxy is shipped, billable, and never called, because the build it
  // accompanies has no endpoint compiled into it.
  console.error(
    "VITE_CHAT_ENDPOINT is not set, so the build would HIDE the advisor and the proxy " +
      "you are about to ship would never be called. " +
      "Set VITE_CHAT_ENDPOINT=/v1/chat (in .env.local or the environment) and re-run.",
  );
  process.exit(1);
}

fs.cpSync(src, dst, { recursive: true });
try {
  const args = ["pages", "deploy", "dist", "--project-name", "lionsdegree", ...process.argv.slice(2)];
  const r = spawnSync("wrangler", args, { cwd: web, stdio: "inherit", shell: true });
  process.exitCode = r.status ?? 1;
} finally {
  // Always, including on failure: a leftover functions/ makes the NEXT plain
  // `npm run deploy` quietly billable again, which is the whole thing this
  // ticket exists to prevent.
  fs.rmSync(dst, { recursive: true, force: true });
}
