/** Where the catalog's bytes come from.
 *
 * One interface, two implementations: the filesystem for the local server,
 * and fetch for the hosted connector (#33). The edition loader above this
 * knows which files it wants and what is in them; a source knows only how
 * to produce the bytes at a path.
 *
 * The split exists so there is ONE catalog implementation rather than two.
 * A second loader would be a second set of answers about what a Course
 * requires, and the two would drift the first time either was touched —
 * which is exactly the failure a hosted server answering differently from
 * the local one would be.
 *
 * Deliberately narrow. Reading a path and listing Editions is the whole
 * contract; everything else — which artifacts, in what order, loaded when —
 * lives above the seam where it is written once.
 */

export interface CatalogSource {
  /** Parsed JSON at a catalog-relative path, or `null` if it is absent or
   * unreadable.
   *
   * ABSENT IS NOT AN ERROR. Most subject files are never asked for, and a
   * Plan can name a subject an Edition does not publish. The caller decides
   * what a miss means — a missing subject file degrades a Course to what
   * the audit index knows, while a missing audit index is fatal. Throwing
   * here would push that judgement into a try/catch at every call site,
   * which is where one eventually gets forgotten. */
  read<T>(relPath: string): Promise<T | null>;

  /** Editions this source can serve, oldest first.
   *
   * Editions accumulate forward and are never backfilled — Penn State's
   * archive is robots-disallowed — so the ordering is meaningful: the last
   * entry is the newest published, and a Plan older than the range reads as
   * the oldest (ADR 0001). */
  editions(): Promise<string[]>;
}

/** A path that cannot escape the catalog.
 *
 * The hosted connector will turn a Course code supplied by a MODEL into a
 * subject-file path. Normalising and then checking containment is what
 * keeps that from becoming a way to read whatever else the process can
 * reach. Rejected loudly rather than returning null: a traversal attempt is
 * not a missing file, and conflating the two would hide it.
 */
export function assertInsideCatalog(relPath: string): string {
  const refuse = (): never => {
    throw new Error(`refusing to read ${relPath}: it points outside the catalog`);
  };

  // DECODE FIRST. This used to test for a literal `..` and nothing else, so
  // `%2e%2e` walked straight through. Harmless against a filesystem, which
  // does not decode — and not harmless at all against the fetch source this
  // interface exists for, because a URL parser resolves `%2e%2e` as a
  // double-dot segment. The caller that matters turns a Course code
  // supplied by a MODEL into a path, so the decoded form is the one that
  // has to be judged.
  let decoded = relPath;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      refuse(); // a malformed escape is not something to guess at
    }
    if (next! === decoded) break;
    decoded = next!;
  }

  const clean = decoded.replace(/\\/g, "/");
  if (clean.startsWith("/")) refuse();
  if (clean === ".." || clean.startsWith("../") || clean.endsWith("/..") || clean.includes("/../")) refuse();
  // A drive letter or a scheme is an absolute path wearing a disguise.
  if (/^[a-zA-Z]:/.test(clean)) refuse();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(clean)) refuse();
  // A NUL truncates the path for some syscalls, so the string that was
  // checked and the string that gets opened would not be the same one.
  if (clean.includes("\0")) refuse();

  const parts = clean.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (!parts.length) throw new Error(`refusing to read ${relPath}: it names no file`);
  return parts.join("/");
}

/** The catalog shipped inside the installed package.
 *
 * No network, no account, no key: running the local server costs the
 * project nothing and tells nobody what a student is studying.
 */
export class FsCatalogSource implements CatalogSource {
  constructor(private readonly root: string) {}

  async read<T>(relPath: string): Promise<T | null> {
    const safe = assertInsideCatalog(relPath);
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, safe), "utf-8")) as T;
    } catch {
      return null;
    }
  }

  async editions(): Promise<string[]> {
    const fromIndex = await this.read<{ editions?: string[] }>("editions.json");
    if (fromIndex?.editions?.length) return fromIndex.editions;
    // Only a filesystem can answer this, which is why it is not part of the
    // contract: a tree assembled by hand, or one predating `editions.json`,
    // still has to work.
    const { default: fs } = await import("node:fs");
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{4}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  }
}
