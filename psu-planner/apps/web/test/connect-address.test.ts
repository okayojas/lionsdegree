/** The address on /connect/ against the one the Worker actually serves.
 *
 * THE TEST THAT DID NOT EXIST, and its absence had a cost. The page
 * published `https://mcp.lionsdegree.com/sse` for months: a hostname
 * that did not resolve, on a transport the server never spoke. Nothing
 * compared the two, so nothing noticed. Publishing an address is the
 * one step that cannot be taken back quietly — every student who saves
 * it has it — and this is the check that makes a wrong one fail here
 * rather than in somebody's assistant.
 *
 * It reads the page, the Worker's route and the deploy config as TEXT,
 * deliberately. Importing the Worker would assert that a constant
 * equals itself; the point is that three files written at different
 * times by different hands still agree.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const mcp = path.resolve(web, "..", "..", "packages", "mcp");

const page = fs.readFileSync(path.join(web, "connect", "index.html"), "utf-8");
const worker = fs.readFileSync(path.join(mcp, "src", "worker.ts"), "utf-8");
const wrangler = fs.readFileSync(path.join(mcp, "wrangler.toml"), "utf-8");

/** Every absolute URL the page offers as the thing to paste. */
function publishedAddresses(): string[] {
  return [...page.matchAll(/https:\/\/mcp\.lionsdegree\.com[^\s"'<]*/g)].map((m) => m[0]);
}

describe("the address students are told to paste", () => {
  it("is published exactly once, so there is nothing to choose between", () => {
    const all = new Set(publishedAddresses());
    expect([...all], "the page offers more than one address").toHaveLength(1);
  });

  it("is the path the Worker serves", () => {
    // `worker.ts` refuses anything that is not this pathname, in so many
    // words. If the handler's route moves, this fails.
    const [published] = publishedAddresses();
    const route = new URL(published).pathname;
    expect(
      worker.includes(`url.pathname !== "${route}"`),
      `the page publishes ${route}, which the Worker does not serve`,
    ).toBe(true);
  });

  it("is not the transport that was never implemented", () => {
    // `/sse` is the older transport. It was on this page for months.
    expect(page, "the page is advertising /sse again").not.toMatch(/mcp\.lionsdegree\.com\/sse/);
  });

  it("is on the hostname the Worker is actually routed to", () => {
    // A correct path on a hostname nothing answers is the same failure
    // wearing different clothes — which is what shipped last time.
    const host = new URL(publishedAddresses()[0]).host;
    expect(
      wrangler.includes(host),
      `${host} appears nowhere in wrangler.toml, so nothing routes it to the Worker`,
    ).toBe(true);
  });

  it("is routed with a pattern that covers the sign-in endpoints too", () => {
    // /mcp IS NOT THE WHOLE CONNECTOR. Discovery, registration,
    // /authorize, /callback and /token all live on the same host, and a
    // route bound to the endpoint alone would drop a student at a 404
    // in the middle of signing in — with the address they were given
    // working perfectly.
    expect(
      /\[\[routes\]\]|routes\s*=/.test(wrangler),
      "no route is configured at all, so the hostname reaches nothing",
    ).toBe(true);

    const host = new URL(publishedAddresses()[0]).host;
    const escaped = host.replace(/\./g, "\\.");
    // Either spelling covers the whole host: a custom domain (Cloudflare
    // owns the DNS record and the certificate) or an explicit wildcard.
    const wholeHost =
      new RegExp(`pattern\\s*=\\s*"${escaped}"[\\s\\S]{0,120}custom_domain\\s*=\\s*true`).test(wrangler) ||
      new RegExp(`${escaped}/\\*`).test(wrangler);
    expect(wholeHost, "the route does not cover the whole host, so the sign-in endpoints are unreachable").toBe(
      true,
    );
    expect(
      new RegExp(`${escaped}/mcp(?!\\w)"`).test(wrangler),
      "the route is bound to /mcp alone, which leaves sign-in unreachable",
    ).toBe(false);
  });
});

describe("what happens to the website if the connector is down", () => {
  /** Every source file the site is built from. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) sources(f, out);
      else if (/\.(ts|tsx|html|css)$/.test(e.name)) out.push(f);
    }
    return out;
  }

  it("nothing, because the website never calls it", () => {
    // THE PROPERTY, AND IT IS STRUCTURAL. The planner is a separate
    // deploy that talks to Supabase directly; the connector is a thing
    // a student's assistant talks to. If the Worker is down, a student
    // who has never heard of it notices nothing — and a student who
    // has can still open their plan and edit it in the browser.
    //
    // Asserted by the absence of the hostname anywhere the browser
    // would reach it, rather than by a comment promising independence.
    const reaching = sources(path.join(web, "src"))
      .filter((f) => /mcp\.lionsdegree\.com/.test(fs.readFileSync(f, "utf-8")))
      .map((f) => path.relative(web, f));
    expect(reaching, "the website makes a request to the connector").toEqual([]);
  });

  it("and the connector's address appears only as text for a student to copy", () => {
    const pages = sources(path.join(web, "connect")).concat(
      fs.existsSync(path.join(web, "index.html")) ? [path.join(web, "index.html")] : [],
    );
    for (const f of pages) {
      const src = fs.readFileSync(f, "utf-8");
      if (!/mcp\.lionsdegree\.com/.test(src)) continue;
      // No `<a href>`, no `fetch`, no `<img src>` — the address is
      // something to read and copy, not something the page loads.
      expect(
        src,
        `${path.relative(web, f)} links to the connector, so a dead Worker would show a broken page`,
      ).not.toMatch(/(?:href|src|action)\s*=\s*"https:\/\/mcp\.lionsdegree\.com/);
    }
  });
});

describe("the page now that the connector is live", () => {
  it("no longer says it is not live", () => {
    // The callout was honest while it was true. Left up afterwards it
    // sends away the students the work was for.
    expect(page, "the page still says the connector is not live").not.toMatch(/not live yet/i);
    expect(page, "the page still says it is being built").not.toMatch(/being built now/i);
  });

  it("offers a copy button beside the address", () => {
    // The affordance was deliberately withheld while the address did
    // not work, because inviting the copy and explaining underneath
    // that it will not work is worse than not offering it.
    expect(page, "there is no copy button").toMatch(/copyfield-btn/);
    expect(page, "the copy button is not wired to the address").toMatch(/data-copy="connector-url"/);
    expect(page, "the address is still styled as pending").not.toMatch(/copyfield is-pending/);
  });

  it("does not send students to an issue tracker to find out whether it works", () => {
    expect(page, "the page still points at the issue for progress").not.toMatch(/issues\/30/);
  });

  it("still has no code and no jargon in it", () => {
    // The page is for students. An npx command and a JSON block used to
    // be here; a student who has never opened a terminal cannot act on
    // either, and seeing them says "this is not for you".
    expect(page, "there is a code block on the page").not.toMatch(/<pre|<code/);
    for (const jargon of ["JSON", "npx", "stdio", "localhost", "OAuth", "endpoint"]) {
      expect(page, `the page says "${jargon}"`).not.toMatch(new RegExp(`\\b${jargon}\\b`));
    }
  });

  it("still works with no JavaScript, because the address is in the markup", () => {
    // Someone setting up a connector is often on a locked-down machine.
    // The copy button is an enhancement; the text has to be there
    // without it.
    const withoutScripts = page.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts, "the address only exists once a script runs").toMatch(
      /https:\/\/mcp\.lionsdegree\.com\/mcp/,
    );
  });
});
