/** The legal documents, checked where they are easiest to get wrong.
 *
 * Privacy and Terms exist twice over: a modal in the planner and a static
 * document at /privacy and /terms. Both render `src/legal/content.ts`, and
 * these tests exist to keep that true -- the previous version hand-maintained
 * the modal's text, which is how a policy ends up describing a data flow the
 * product stopped having.
 *
 * The static ones are load-bearing beyond tidiness: Google and Microsoft both
 * require a publicly reachable privacy-policy URL to verify an OAuth app, and
 * neither a reviewer's crawler nor a link previewer will run React to find
 * one. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACT, SECTIONS, type Block, type Inline } from "../src/legal/content.js";
import { escapeHtml, pageHtml } from "../src/legal/render.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const published = SECTIONS.filter((s) => s.path);

/** Every word of a section, in order, with no markup. */
function plainText(body: Block[]): string {
  const run = (r: Inline): string => (typeof r === "string" ? r : "b" in r ? r.b : "i" in r ? r.i : r.a);
  return body
    .map((b) => ("p" in b ? b.p.map(run).join("") : b.ul.map((li) => li.map(run).join("")).join(" ")))
    .join(" ");
}

describe("the static legal documents", () => {
  it("publishes privacy and terms at their own URLs", () => {
    expect(published.map((s) => s.path)).toEqual(["/privacy/", "/terms/"]);
  });

  it.each(published.map((s) => [s.id, s] as const))("%s is on disk and matches the content module", (_id, section) => {
    // The generator runs in `prepage`, before build and before dev. If this
    // fails, the committed file is stale: run `npm run legal`.
    const file = path.join(web, section.path!.replace(/^\/|\/$/g, ""), "index.html");
    expect(fs.existsSync(file), `${file} missing — run npm run legal`).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(pageHtml(section));
  });

  it.each(published.map((s) => [s.id, s] as const))("%s reads without JavaScript", (_id, section) => {
    const html = fs.readFileSync(path.join(web, section.path!.replace(/^\/|\/$/g, ""), "index.html"), "utf-8");
    // The entire justification for these being documents rather than routes.
    expect(html, "a legal page must not depend on a script").not.toMatch(/<script/i);
    expect(html).toContain(`<h1>${section.heading}</h1>`);
    // Spot-check real prose, not just the heading: a page that renders its
    // title and drops its body would otherwise pass. Checked per RUN rather
    // than per sentence, because a sentence crossing a <strong> boundary is
    // contiguous in the source and not in the markup.
    const runs: string[] = [];
    for (const b of section.body) {
      const lists = "p" in b ? [b.p] : b.ul;
      for (const list of lists) for (const r of list) if (typeof r === "string" && r.length > 60) runs.push(r);
    }
    expect(runs.length, "no prose long enough to spot-check").toBeGreaterThan(2);
    for (const r of runs) expect(html).toContain(escapeHtml(r));
  });

  it("links back to both documents from every document", () => {
    // A reviewer lands on /privacy and has to be able to reach /terms.
    for (const s of published) {
      const html = fs.readFileSync(path.join(web, s.path!.replace(/^\/|\/$/g, ""), "index.html"), "utf-8");
      for (const other of published) expect(html).toContain(`href="${other.path}"`);
    }
  });

  it("is reachable from the landing page", () => {
    // Before this, the policies lived only inside /plan/: a visitor who never
    // opened the planner could not read either one.
    const landing = fs.readFileSync(path.join(web, "index.html"), "utf-8");
    for (const s of published) expect(landing, `landing footer missing ${s.path}`).toContain(`href="${s.path}"`);
  });
});

describe("what the policy promises", () => {
  it("gives a private contact route, not a public tracker", () => {
    // Asking someone to file a data-deletion request as a public GitHub issue
    // makes them publish the request, and their identity, to do it.
    const privacy = SECTIONS.find((s) => s.id === "privacy")!;
    const text = plainText(privacy.body);
    expect(text).toContain(CONTACT);
    const near = text.slice(Math.max(0, text.indexOf("deletion") - 50), text.indexOf("deletion") + 200);
    expect(near, "deletion route should not be a GitHub issue").not.toMatch(/issue/i);
  });

  it("does not promise an AI service we do not run", () => {
    // The hosted advisor is not deployed; the MCP server runs on the student's
    // own machine. A policy describing a server-side AI path would be describing
    // a data flow that does not happen.
    const privacy = plainText(SECTIONS.find((s) => s.id === "privacy")!.body);
    expect(privacy).toMatch(/MCP server that runs on your machine/i);
    expect(privacy).toMatch(/We operate no AI service/i);
  });

  it("states the no-cookie, no-tracking claim the headers actually enforce", () => {
    const privacy = plainText(SECTIONS.find((s) => s.id === "privacy")!.body);
    expect(privacy).toMatch(/no analytics/i);
    expect(privacy).toMatch(/local storage rather than cookies/i);
    // The claim is only safe to make while the CSP forbids other hosts.
    const headers = fs.readFileSync(path.join(web, "public", "_headers"), "utf-8");
    expect(headers).toMatch(/default-src 'self'/);
    expect(headers).toMatch(/script-src 'self'/);
  });

  it("escapes anything interpolated into the page", () => {
    expect(escapeHtml(`<script>&"`)).toBe("&lt;script&gt;&amp;&quot;");
  });
});

describe("robots and sitemap", () => {
  const robots = fs.readFileSync(path.join(web, "public", "robots.txt"), "utf-8");
  const sitemap = fs.readFileSync(path.join(web, "public", "sitemap.xml"), "utf-8");

  it("lists every published page and nothing that 404s", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    expect(locs).toContain("/");
    expect(locs).toContain("/plan/");
    for (const s of published) expect(locs, `sitemap missing ${s.path}`).toContain(s.path);
    // Every listed path must correspond to a real document on disk.
    for (const p of locs) {
      const file = path.join(web, p === "/" ? "index.html" : path.join(p.replace(/^\/|\/$/g, ""), "index.html"));
      expect(fs.existsSync(file), `sitemap lists ${p} but ${file} does not exist`).toBe(true);
    }
  });

  it("keeps crawlers out of the catalog copy", () => {
    // Tens of megabytes of derived data, and the course information in it is
    // Penn State's. Their bulletin should be what ranks for it, not our mirror.
    expect(robots).toMatch(/Disallow: \/catalog\//);
    expect(robots).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
  });
});
