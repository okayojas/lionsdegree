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
import {
  PLAN_FILE_FORMAT,
  PLAN_FILE_VERSION,
  exportPlanFile,
  parsePlanFile,
  STALE_REV_SQLSTATE,
  type PlanDoc,
} from "@psu-planner/engine";

/** The Plan was reached and cannot be opened.
 *
 * SEPARATE FROM A FAILED READ, because the two deserve opposite advice.
 * A database that did not answer is worth retrying; a Plan pinned to a
 * bulletin we do not carry is not — Editions are forward-only and never
 * backfilled (ADR 0001), so that year is not coming. Telling a student
 * to try again in a moment is advice that cannot come true, and it hides
 * a problem only a human can resolve.
 *
 * The message is the engine's own refusal, which is already a sentence
 * written for a student to read, so it travels verbatim. */
export class PlanUnopenable extends Error {}

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

/** What happened to a write.
 *
 * Two outcomes, and no third: a write either landed or was refused.
 * There is deliberately no "merged" — ADR 0003 — because merging two
 * degree plans on a guess produces a schedule neither person asked for,
 * and nobody can tell afterwards which parts were theirs. */
export type WriteOutcome = "written" | "stale";

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

  /** Store `plan`, but only if the store is still at `baseRev`.
   *
   * COMPARE-AND-SWAP, not a write with a check in front of it (ADR
   * 0003). The condition and the write are one operation, because a read
   * then a write is two — and in the gap between them the student saves
   * from the planner and their edit is gone.
   *
   * "stale" is not an error. It is the correct answer to "apply this
   * change to the plan as it was a minute ago" when the plan has moved
   * on, and the caller's job is to re-read and recompute rather than to
   * retry the same bytes harder. */
  write(plan: PlanDoc, baseRev: number): Promise<WriteOutcome>;
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
    if (!parsed.ok) throw new PlanUnopenable(parsed.reason);
    return { plan: parsed.plan, rev: parsed.plan.rev ?? 0, updatedAt: parsed.plan.updatedAt ?? "" };
  }

  async write(plan: PlanDoc, baseRev: number): Promise<WriteOutcome> {
    const { default: fs } = await import("node:fs");

    // A READ THEN A WRITE, which the interface above says a swap must
    // not be — so the exception is stated rather than left to be
    // noticed. A plain file offers no conditional write; the atomic
    // version needs locking that POSIX and Windows disagree about, for
    // a case with one writing process and a human at the keyboard.
    //
    // What it does buy is the case the rule exists for: the student
    // edited in the planner while this server was running, so the
    // revision ON DISK is not the one this process loaded at startup.
    // Reading it back catches that; the surviving window is between
    // these two lines, and the hosted store — where there really are
    // two writers — swaps in the database instead.
    if (fs.existsSync(this.path)) {
      const held = JSON.parse(fs.readFileSync(this.path, "utf-8")) as { plan?: { rev?: number } };
      if ((held.plan?.rev ?? 0) !== baseRev) return "stale";
    } else if (baseRev !== 0) {
      // The file this write was computed from is gone. Recreating it
      // would resurrect a Plan the student may have deleted.
      return "stale";
    }

    fs.writeFileSync(this.path, exportPlanFile(plan), "utf-8");
    return "written";
  }
}

/** A store that holds a Plan and keeps it to itself.
 *
 * What `simulate_change` writes to. The mutation it runs is the real
 * one — same code, same optimiser — so it expects somewhere to persist;
 * this is somewhere that goes nowhere. The alternative was a flag
 * threaded through `commit` saying "do not actually write", which is a
 * branch inside the write path that only one caller takes, and the
 * first time it is wrong a preview becomes a change. */
export class MemoryPlanStore implements PlanStore {
  /** `rev` is passed in rather than read off the document because the
   * two disagree, and the disagreement is not cosmetic. Hosted, the
   * REVISION IS A COLUMN and the document's own copy can lag it — so a
   * sandbox that believed the document refused a change the real store
   * would have accepted, and the student was shown "that is not
   * possible" about something that is. Caught by the first hosted test
   * written for #37. */
  constructor(private held: PlanDoc | null = null, private rev = held?.rev ?? 0) {}

  async read(): Promise<StoredPlan | null> {
    return this.held
      ? { plan: this.held, rev: this.rev, updatedAt: this.held.updatedAt ?? "" }
      : null;
  }

  async write(plan: PlanDoc, baseRev: number): Promise<WriteOutcome> {
    // The swap is honoured even here. A sandbox more permissive than
    // the real store would let a simulation succeed where the change it
    // previews would be refused — which is the same class of mistake as
    // a stub that accepts what the database rejects, pointed the other
    // way.
    if (this.rev !== baseRev) return "stale";
    this.held = plan;
    this.rev = plan.rev ?? baseRev + 1;
    return "written";
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
    //
    // ONE ROW, the most recently updated. A student can hold more than
    // one (the table is keyed by user and plan id), and the one they
    // touched last is the one they mean — the planner writes on every
    // edit, so "most recently updated" is "the one they are working
    // on". Reporting `as_of` is what keeps this honest: a student
    // looking at a different plan in another window can see that the
    // answer is about a copy saved at some other time.
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
      //
      // The upstream message is LOGGED, not interpolated. A fetch
      // failure carries a hostname and sometimes a URL with query
      // parameters, and the student can act on neither (DECISIONS.md
      // 5.0 S5/S8/S13). The local server prints this message verbatim,
      // so "the Worker strips it later" would not be enough.
      console.error("[plan] read failed", e);
      throw new Error("Your plan could not be read right now.");
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
    if (!parsed.ok) throw new PlanUnopenable(parsed.reason);

    return {
      plan: parsed.plan,
      // The stored column wins over the document's own copy: the column
      // is what the compare-and-swap in #32 is written against, so it is
      // the number that decides whether a later write lands.
      rev: typeof row.rev === "number" ? row.rev : (parsed.plan.rev ?? 0),
      updatedAt: row.updated_at ?? parsed.plan.updatedAt ?? "",
    };
  }

  async write(plan: PlanDoc, baseRev: number): Promise<WriteOutcome> {
    const base = this.opts.url.replace(/\/+$/, "");

    // THE SWAP IS THE `rev=eq.` FILTER, and it is the whole mechanism:
    // Postgres evaluates it while holding the row, so a planner save
    // that lands first simply makes this match nothing. A SELECT here
    // followed by an UPDATE would leave a window, and the window is
    // precisely where a student's work disappears.
    //
    // Still no `user_id` filter — same reason as the read. `id` plus
    // row-level security is exactly one row, and the policy is what
    // makes it theirs.
    const url =
      `${base}/rest/v1/plans?id=eq.${encodeURIComponent(plan.id)}&rev=eq.${encodeURIComponent(String(baseRev))}`;

    const go = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await go(url, {
        method: "PATCH",
        headers: {
          apikey: this.opts.anonKey,
          authorization: `Bearer ${this.opts.accessToken}`,
          "content-type": "application/json",
          // Without this PostgREST answers 204 with no body on both a
          // match and a no-op, and the two are indistinguishable — which
          // would make every refused write look like a successful one.
          prefer: "return=representation",
        },
        body: JSON.stringify({
          doc: plan,
          rev: plan.rev,
          updated_at: plan.updatedAt,
        }),
      });
    } catch (e) {
      console.error("[plan] write failed", e);
      throw new Error("Your plan could not be saved right now.");
    }

    if (!res.ok) {
      // Including the stale-write SQLSTATE raised by migration 0003's
      // guard: a revision that went backwards is the same refusal
      // wearing a trigger's clothes.
      if (await isStaleWrite(res)) return "stale";
      console.error("[plan] write rejected", res.status);
      throw new Error("Your plan could not be saved right now.");
    }

    const rows = (await res.json().catch(() => null)) as unknown[] | null;
    // ZERO ROWS IS THE REFUSAL. The filter matched nothing, which means
    // the stored revision is not the one this change was computed from.
    return Array.isArray(rows) && rows.length > 0 ? "written" : "stale";
  }
}

/** Migration 0003 raises its own SQLSTATE when a revision goes
 * backwards. Read here so a write refused by the trigger is reported as
 * what it is rather than as "the database is down" — the remedy is to
 * re-read and recompute, not to wait.
 *
 * THE ERRCODE AND NOTHING ELSE. A bare 409 used to count, which folded
 * `unique_violation` in with it — and `sync.ts` keeps those apart
 * deliberately, because one means "re-read and recompute" and the other
 * does not. Telling a model to retry something that will never succeed
 * is how it loops. */
async function isStaleWrite(res: Response): Promise<boolean> {
  const body = await res.text().catch(() => "");
  return body.includes(STALE_REV_SQLSTATE);
}


