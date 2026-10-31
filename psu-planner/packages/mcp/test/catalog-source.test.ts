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
import { FsCatalogSource, type CatalogSource } from "../src/source.js";

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

export function describeCatalogSource(name: string, make: (root: string) => CatalogSource): void {
  describe(name, () => {
    it("reads a JSON file at a catalog-relative path", async () => {
      const src = make(scratchCatalog());
      const index = await src.read<{ courses: { code: string }[] }>("2026-2027/audit-index.json");
      expect(index?.courses[0].code).toBe("MATH 140");
    });

    it("reads a nested path the same way", async () => {
      // Subject files live a directory down and are fetched one at a time.
      // A source that only handled flat paths would work right up until a
      // Course detail was asked for.
      const src = make(scratchCatalog());
      const subject = await src.read<unknown[]>("2026-2027/courses/MATH.json");
      expect(Array.isArray(subject)).toBe(true);
    });

    it("returns null for a file that is not there", async () => {
      // ABSENT IS NOT AN ERROR. Most subject files are never asked for, and
      // a Plan can legitimately name a subject this Edition does not
      // publish. The caller decides what a miss means; the source only
      // reports it. Throwing here would turn every optional read into a
      // try/catch at the call site, which is where one gets forgotten.
      const src = make(scratchCatalog());
      expect(await src.read("2026-2027/courses/NOPE.json")).toBeNull();
    });

    it("returns null for a file that is not JSON, rather than throwing", async () => {
      // Same reasoning, and it keeps the two sources alike: a fetch source
      // gets an HTML error page where it expected JSON far more often than
      // a filesystem gets a corrupt file.
      const src = make(scratchCatalog());
      expect(await src.read("2026-2027/broken.json")).toBeNull();
    });

    it("lists the Editions it can serve, newest last", async () => {
      const src = make(scratchCatalog());
      expect(await src.editions()).toEqual(["2025-2026", "2026-2027"]);
    });

    it("refuses to read outside the catalog root", async () => {
      // The hosted source will take a Course code from a model and turn it
      // into a path. A traversal that escapes the catalog is the difference
      // between serving a subject file and serving whatever else the
      // process can reach.
      const src = make(scratchCatalog());
      for (const bad of ["../secrets.json", "2026-2027/../../etc/passwd", "/etc/passwd"]) {
        await expect(src.read(bad), `${bad} was not refused`).rejects.toThrow(/outside the catalog/i);
      }
    });
  });
}

describeCatalogSource("the filesystem catalog source", (root) => new FsCatalogSource(root));

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
