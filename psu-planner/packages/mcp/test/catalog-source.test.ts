/** The contract every catalog source must satisfy.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS. There will be two sources: the
 * filesystem, for the local server, and fetch, for the hosted connector.
 * They must answer identically, because a second way of reaching the bytes
 * must not become a second set of answers about what a Course requires.
 *
 * So the assertions live in `describeCatalogSource`, which takes a factory
 * and runs the whole suite against whatever it produces. The fetch source
 * (#33) adds one call to this file and inherits every assertion below —
 * and if it diverges, it fails here rather than in production.
 *
 * The contract is deliberately small: read JSON at a path, say which
 * Editions exist. Everything about WHICH files and WHAT is in them belongs
 * above the seam, in the edition loader, where it is written once.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FetchCatalogSource, FsCatalogSource, type CatalogSource } from "../src/source.js";

/** Materialise the contract's files on disk and hand back the root. */
function writeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ld-catalog-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  // Editions are discovered from the directory when there is no index, so
  // the older one needs to exist as a directory even though it has no
  // files of its own in the contract set.
  fs.mkdirSync(path.join(root, "2025-2026"), { recursive: true });
  return root;
}

/** Build a throwaway catalog tree on disk and hand back its root. */
function scratchCatalog(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ld-catalog-"));
  fs.mkdirSync(path.join(root, "2025-2026", "courses"), { recursive: true });
  fs.mkdirSync(path.join(root, "2026-2027", "courses"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "editions.json"),
    JSON.stringify({ editions: ["2025-2026", "2026-2027"], latest: "2026-2027" }),
  );
  fs.writeFileSync(
    path.join(root, "2026-2027", "audit-index.json"),
    JSON.stringify({ courses: [{ code: "MATH 140", title: "Calculus I" }] }),
  );
  fs.writeFileSync(
    path.join(root, "2026-2027", "courses", "MATH.json"),
    JSON.stringify([{ code: "MATH 140", title: "Calculus I", subject: "MATH", number: "140" }]),
  );
  fs.writeFileSync(path.join(root, "2026-2027", "broken.json"), "{ not json");
  return root;
}

/** The files every implementation is tested against, as data rather than
 * as a directory. The first version handed the factory a disk path, which
 * is exactly what a fetch source cannot be built from — so the harness
 * could not have been reused by the implementation it was written for. A
 * fetch source's factory serves these from a stub; the filesystem's writes
 * them to a temp tree. */
export const CONTRACT_FILES: Record<string, string> = {
  "editions.json": JSON.stringify({ editions: ["2025-2026", "2026-2027"], latest: "2026-2027" }),
  "2026-2027/audit-index.json": JSON.stringify({ courses: [{ code: "MATH 140", title: "Calculus I" }] }),
  "2026-2027/courses/MATH.json": JSON.stringify([
    { code: "MATH 140", title: "Calculus I", subject: "MATH", number: "140" },
  ]),
  "2026-2027/broken.json": "{ not json",
};

export function describeCatalogSource(name: string, make: (files: Record<string, string>) => CatalogSource): void {
  describe(name, () => {
    it("reads a JSON file at a catalog-relative path", async () => {
      const src = make(CONTRACT_FILES);
      const index = await src.read<{ courses: { code: string }[] }>("2026-2027/audit-index.json");
      expect(index?.courses[0].code).toBe("MATH 140");
    });

    it("reads a nested path the same way", async () => {
      // Subject files live a directory down and are fetched one at a time.
      // A source that only handled flat paths would work right up until a
      // Course detail was asked for.
      const src = make(CONTRACT_FILES);
      const subject = await src.read<unknown[]>("2026-2027/courses/MATH.json");
      expect(Array.isArray(subject)).toBe(true);
    });

    it("returns null for a file that is not there", async () => {
      // ABSENT IS NOT AN ERROR. Most subject files are never asked for, and
      // a Plan can legitimately name a subject this Edition does not
      // publish. The caller decides what a miss means; the source only
      // reports it. Throwing here would turn every optional read into a
      // try/catch at the call site, which is where one gets forgotten.
      const src = make(CONTRACT_FILES);
      expect(await src.read("2026-2027/courses/NOPE.json")).toBeNull();
    });

    it("returns null for a file that is not JSON, rather than throwing", async () => {
      // Same reasoning, and it keeps the two sources alike: a fetch source
      // gets an HTML error page where it expected JSON far more often than
      // a filesystem gets a corrupt file.
      const src = make(CONTRACT_FILES);
      expect(await src.read("2026-2027/broken.json")).toBeNull();
    });

    it("lists the Editions it can serve, newest last", async () => {
      const src = make(CONTRACT_FILES);
      expect(await src.editions()).toEqual(["2025-2026", "2026-2027"]);
    });

    it("refuses to read outside the catalog root", async () => {
      // The hosted source will take a Course code from a model and turn it
      // into a path. A traversal that escapes the catalog is the difference
      // between serving a subject file and serving whatever else the
      // process can reach.
      //
      // THE ENCODED CASES ARE THE POINT. The first version tested for a
      // literal `..`, so `%2e%2e` passed cleanly — invisible against a
      // filesystem, which does not decode, and a real escape against the
      // fetch source this interface exists for, whose URL parser does.
      const src = make(CONTRACT_FILES);
      const bad = [
        "../secrets.json",
        "2026-2027/../../etc/passwd",
        "/etc/passwd",
        "%2e%2e/secrets.json",
        "2026-2027/%2e%2e/%2e%2e/secrets.json",
        "%252e%252e/secrets.json",
        String.raw`..\secrets.json`,
        "C:/Windows/win.ini",
        "file:///etc/passwd",
        "https://example.com/evil.json",
      ];
      for (const p of bad) {
        await expect(src.read(p), `${p} was not refused`).rejects.toThrow(/outside the catalog/i);
      }
    });

    it("still reads an ordinary path that merely contains a dot", async () => {
      // The guard must reject traversal, not punctuation. A subject file
      // named `a-i.json` is the normal case, and over-refusing would take
      // out 41 real subjects.
      const src = make(CONTRACT_FILES);
      expect(await src.read("2026-2027/courses/MATH.json")).not.toBeNull();
    });
  });
}

describeCatalogSource("the filesystem catalog source", (files) => new FsCatalogSource(writeTree(files)));

/** The hosted source, against a stub standing in for Cloudflare's asset
 * binding. ONE LINE, and it inherits every assertion above — which is the
 * reason the contract was written over a factory rather than a directory.
 * If the two ever answer differently, they fail here rather than when a
 * student asks their assistant about a Course. */
describeCatalogSource(
  "the fetch catalog source",
  (files) =>
    new FetchCatalogSource({
      async fetch(req: Request): Promise<Response> {
        const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
        const body = files[rel];
        return body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
);

describe("the fetch catalog source, specifically", () => {
  const serving = (files: Record<string, string>) =>
    new FetchCatalogSource({
      async fetch(req: Request): Promise<Response> {
        const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
        const body = files[rel];
        return body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body, { status: 200 });
      },
    });

  it("treats a 404 as absent rather than as an error", async () => {
    expect(await serving({}).read("2026-2027/courses/NOPE.json")).toBeNull();
  });

  it("treats a server error as absent too, rather than throwing mid-answer", async () => {
    // A 500 from the asset host is not something a student can act on,
    // and a Course that cannot be read degrades to what the audit index
    // knows -- the same as a missing file. Throwing here would take out
    // the whole tool call instead of one Course.
    const broken = new FetchCatalogSource({
      async fetch(): Promise<Response> {
        return new Response("upstream is sad", { status: 500 });
      },
    });
    expect(await broken.read("2026-2027/audit-index.json")).toBeNull();
  });

  it("survives the fetch itself rejecting", async () => {
    const offline = new FetchCatalogSource({
      async fetch(): Promise<Response> {
        throw new Error("network");
      },
    });
    expect(await offline.read("2026-2027/audit-index.json")).toBeNull();
  });
});

describe("the filesystem catalog source, specifically", () => {
  it("falls back to reading the directory when there is no editions index", async () => {
    // `editions.json` is written by sync-catalog. A tree assembled by hand,
    // or one from before that file existed, still has to work -- and only
    // a filesystem can answer this, which is why it is not in the contract.
    const root = scratchCatalog();
    fs.rmSync(path.join(root, "editions.json"));
    expect(await new FsCatalogSource(root).editions()).toEqual(["2025-2026", "2026-2027"]);
  });

  it("reports no Editions for a root that does not exist", async () => {
    expect(await new FsCatalogSource(path.join(os.tmpdir(), "ld-not-here")).editions()).toEqual([]);
  });
});
