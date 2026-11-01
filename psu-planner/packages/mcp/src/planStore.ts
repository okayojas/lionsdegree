/** Where a student's Plan comes from.
 *
 * One interface, two implementations: the file the local server already
 * reads, and Supabase for the hosted connector. Same shape as
 * `CatalogSource`, for the same reason — the tools above must not be
 * able to tell which one they have, or a student's assistant could give
 * a different answer about their degree depending on how they connected.
 *
 * THE SECURITY PROPERTY LIVES IN THE SUPABASE IMPLEMENTATION, and it is
 * one line: the query carries the STUDENT's access token. Postgres then
 * refuses a cross-user read under the policies that already exist,
 * whatever this code does with the result. The alternative — querying
 * with a privileged key and filtering by user id here — would make the
 * application the thing standing between two students, and reduce the
 * policy to a backstop nobody exercises.
 */
import { PLAN_FILE_FORMAT, PLAN_FILE_VERSION, parsePlanFile, type PlanDoc } from "@psu-planner/engine";

export interface StoredPlan {
  plan: PlanDoc;
  /** The revision the store held when this was read.
   *
   * Reported rather than assumed: a model that cannot say how current
   * its view is will imply it is live, and a student acting on an
   * hour-old Plan does not know to doubt it. */
  rev: number;
  updatedAt: string;
}

export interface PlanStore {
  /** The student's Plan, or null if they have none.
   *
   * NULL IS NOT AN EMPTY PLAN. An audit of an empty Plan reads as
   * "nothing is required", which is the confident wrong answer this
   * project refuses (iron rule 2). The caller says "you have no plan
   * here yet" instead.
   *
   * `editions` is what this catalog can actually serve, and it is a
   * parameter rather than something the store knows because ADR 0001
   * lives here: a Plan pinned to a bulletin we do not have must be
   * REFUSED, not opened against a different one. Opening it elsewhere
   * would change which requirements apply to a student without telling
   * them. The engine's own reader makes that judgement; this is just
   * where it is handed the facts. */
  read(editions: string[]): Promise<StoredPlan | null>;
}

/** Wrap a stored Plan document in the file envelope the engine's reader
 * expects.
 *
 * There is ONE parser for a Plan and this is how the database row
 * reaches it. A second validator here would be a second opinion about
 * what a Plan is, and the two would disagree the first time either
 * changed. */
function asPlanFile(doc: unknown): string {
  return JSON.stringify({ format: PLAN_FILE_FORMAT, formatVersion: PLAN_FILE_VERSION, plan: doc });
}

/** The plan file the student exported from the planner. */
export class FilePlanStore implements PlanStore {
  constructor(private readonly path: string) {}

  async read(editions: string[]): Promise<StoredPlan | null> {
    const { default: fs } = await import("node:fs");
    if (!fs.existsSync(this.path)) return null;
    const parsed = parsePlanFile(fs.readFileSync(this.path, "utf-8"), editions);
    if (!parsed.ok) throw new Error(parsed.reason);
    return { plan: parsed.plan, rev: parsed.plan.rev ?? 0, updatedAt: parsed.plan.updatedAt ?? "" };
  }
}

export interface SupabasePlanStoreOptions {
  url: string;
  /** Public by design; it identifies the project, not the student. */
  anonKey: string;
  /** THE STUDENT'S token, verified by the gate before we got here. This
   * is what makes row-level security the thing refusing a cross-user
   * read rather than a filter in this file. */
  accessToken: string;
  /** Injected so the contract test can watch what is sent. */
  fetch?: typeof fetch;
}

export class SupabasePlanStore implements PlanStore {
  constructor(private readonly opts: SupabasePlanStoreOptions) {}

  async read(editions: string[]): Promise<StoredPlan | null> {
    const base = this.opts.url.replace(/\/+$/, "");
    // NO `user_id` FILTER, deliberately. The token says who is asking
    // and the policy decides what they may see; adding a filter here
    // would hide a policy failure behind an application that happened
    // to be correct.
    const url =
      `${base}/rest/v1/plans?select=doc,rev,updated_at&order=updated_at.desc&limit=1`;

    const go = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await go(url, {
        headers: {
          apikey: this.opts.anonKey,
          authorization: `Bearer ${this.opts.accessToken}`,
          accept: "application/json",
        },
      });
    } catch (e) {
      // A read that did not happen is not a student with no Plan.
      throw new Error(`Your plan could not be read right now (${(e as Error).message}).`);
    }

    if (!res.ok) {
      // Including 401/403: the session may have been revoked between
      // the gate and here. Refusing is the only honest answer — an
      // empty audit would say nothing is required.
      throw new Error(`Your plan could not be read right now (the plan service is unavailable).`);
    }

    const rows = (await res.json().catch(() => null)) as
      | { doc?: unknown; rev?: number; updated_at?: string }[]
      | null;
    if (!Array.isArray(rows)) {
      throw new Error("Your plan could not be read right now (the plan service answered unexpectedly).");
    }
    if (!rows.length) return null;

    const row = rows[0];
    // The row's `doc` is a Plan as the planner wrote it. Parsed through
    // the engine's own reader so a malformed one is refused here rather
    // than reasoned about downstream.
    const parsed = parsePlanFile(asPlanFile(row.doc), editions);
    if (!parsed.ok) throw new Error(parsed.reason);

    return {
      plan: parsed.plan,
      // The stored column wins over the document's own copy: the column
      // is what the compare-and-swap in #32 is written against, so it is
      // the number that decides whether a later write lands.
      rev: typeof row.rev === "number" ? row.rev : (parsed.plan.rev ?? 0),
      updatedAt: row.updated_at ?? parsed.plan.updatedAt ?? "",
    };
  }
}
