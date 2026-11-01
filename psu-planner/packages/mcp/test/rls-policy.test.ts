/** The policy that stands between two students' degrees, tested against
 * Postgres rather than through our code.
 *
 * This matters because of a deliberate choice in `SupabasePlanStore`:
 * the hosted connector does NOT filter by user id. It sends the
 * student's own token and asks for "the plans", and the database decides
 * which rows that means. Every application-level test of that behaviour
 * is therefore circular — it can only show that we asked, never that
 * anyone refused.
 *
 * So this runs the real migrations, unmodified, in a real Postgres
 * (PGlite — Postgres compiled to WASM, so there is no container to
 * start), and does the asking in SQL. If someone drops a policy or turns
 * row-level security off, nothing in the Worker would notice and this is
 * the test that fails.
 *
 * Two details are load-bearing and easy to get wrong:
 *   - queries run as a NON-SUPERUSER role, because superusers bypass
 *     RLS entirely and a test run as `postgres` would pass against a
 *     table with no policies at all;
 *   - `auth.uid()` is Supabase's own definition, copied, not a
 *     simplification — a shim more permissive than the real function
 *     certifies a policy the real database would refuse.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "supabase", "migrations",
);

const ANA = "11111111-1111-1111-1111-111111111111";
const BEN = "22222222-2222-2222-2222-222222222222";

let db: PGlite;

/** Run as one student, the way PostgREST does it: assume the
 * `authenticated` role and set the JWT claims the request arrived with.
 * Nothing else about the query changes between students. */
async function asStudent<T>(sub: string | null, sql: string): Promise<{ rows: T[]; affected: number }> {
  await db.exec("reset role;");
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    sub ? JSON.stringify({ sub, role: "authenticated" }) : "",
  ]);
  await db.exec(sub ? "set role authenticated;" : "set role anon;");
  try {
    const res = await db.query<T>(sql);
    return { rows: res.rows, affected: res.affectedRows ?? 0 };
  } finally {
    await db.exec("reset role;");
  }
}

beforeAll(async () => {
  db = new PGlite();

  // What Supabase provides and a bare Postgres does not. `auth.uid()` is
  // Supabase's own definition.
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable
      as $$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $$;
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
  `);

  // THE REAL MIGRATIONS, verbatim and ALL of them, read from the
  // directory in the order they are applied. A test that restated the
  // policies would pass against a database that never received them —
  // and a hardcoded file list would quietly skip a migration added or
  // renamed later while this header still claimed otherwise.
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length, "no migrations were found — the path is wrong, not the schema").toBeGreaterThan(2);
  for (const file of files) await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf-8"));

  // PostgREST's roles hold table privileges; RLS then narrows them to
  // rows. Granting everything here is deliberate — it means every
  // refusal below comes from a POLICY and not from a missing grant.
  await db.exec(`
    grant select, insert, update, delete on public.plans to authenticated;
    grant select, insert, update, delete on public.plans to anon;
    insert into auth.users (id) values ('${ANA}'), ('${BEN}');
  `);

  // Each student stores a plan, as themselves.
  for (const [who, id] of [[ANA, "ana-plan"], [BEN, "ben-plan"]] as const) {
    await asStudent(who, `
      insert into public.plans (id, user_id, doc, rev)
      values ('${id}', '${who}', '{"programs":["${id}"]}'::jsonb, 1)
    `);
  }
});

afterAll(async () => { await db?.close(); });

describe("row-level security on plans", () => {
  it("is on", async () => {
    const { rows } = await asStudent<{ relrowsecurity: boolean }>(
      ANA, `select relrowsecurity from pg_class where relname = 'plans'`,
    );
    expect(rows[0]?.relrowsecurity, "row-level security is disabled on plans").toBe(true);
  });

  it("is not being bypassed by the role these tests run as", async () => {
    // THE TEST'S OWN FOOTING. A superuser sees every row whatever the
    // policies say, so a suite run as `postgres` would pass against a
    // table with no protection at all.
    const { rows } = await asStudent<{ super: boolean; bypass: boolean }>(
      ANA, `select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    expect(rows[0]?.super, "these tests run as a superuser, so they prove nothing").toBe(false);
    expect(rows[0]?.bypass, "the test role bypasses RLS, so it proves nothing").toBe(false);
  });
});

describe("one student asking for another's plan", () => {
  it("sees their own plan", async () => {
    // The control. Without this, every assertion below would also pass
    // against a policy that refuses everyone.
    const { rows } = await asStudent<{ id: string }>(ANA, `select id from public.plans`);
    expect(rows.map((r) => r.id)).toEqual(["ana-plan"]);
  });

  it("cannot read it", async () => {
    // THE QUERY THE CONNECTOR SENDS — no user_id filter, exactly as
    // SupabasePlanStore asks it. Ben gets Ben's plan and nothing else.
    const { rows } = await asStudent<{ id: string; user_id: string }>(
      BEN, `select id, user_id from public.plans order by updated_at desc`,
    );
    expect(rows.map((r) => r.id), "a student read another student's plan").toEqual(["ben-plan"]);
  });

  it("cannot read it by asking for it by name", async () => {
    const { rows } = await asStudent(BEN, `select id from public.plans where id = 'ana-plan'`);
    expect(rows, "naming the row was enough to read it").toHaveLength(0);
  });

  it("cannot overwrite it", async () => {
    const { affected } = await asStudent(
      BEN, `update public.plans set doc = '{"programs":["hijacked"]}'::jsonb where id = 'ana-plan'`,
    );
    expect(affected, "a student overwrote another student's plan").toBe(0);

    const { rows } = await asStudent<{ doc: { programs: string[] } }>(
      ANA, `select doc from public.plans where id = 'ana-plan'`,
    );
    expect(rows[0]?.doc.programs).toEqual(["ana-plan"]);
  });

  it("cannot delete it", async () => {
    const { affected } = await asStudent(BEN, `delete from public.plans where id = 'ana-plan'`);
    expect(affected, "a student deleted another student's plan").toBe(0);
  });

  it("cannot store a plan under their name", async () => {
    // The insert policy, separately: a row written with somebody else's
    // user_id would be a plan they see appear and did not make.
    await expect(
      asStudent(BEN, `
        insert into public.plans (id, user_id, doc)
        values ('planted', '${ANA}', '{"programs":["planted"]}'::jsonb)
      `),
      "a student stored a plan under another student's name",
    ).rejects.toThrow(/policy/i);
  });

  it("cannot move their own plan onto another student", async () => {
    // The `with check` half of the update policy. Without it, a student
    // could reassign a row they legitimately own.
    //
    // `rev` advances because the revision guard from 0003 runs first and
    // would otherwise be what refuses this — which would leave the
    // policy untested behind a trigger that happened to fire.
    await expect(
      asStudent(BEN, `update public.plans set user_id = '${ANA}', rev = rev + 1 where id = 'ben-plan'`),
      "a student reassigned their own plan to someone else",
    ).rejects.toThrow(/policy/i);
  });
});

describe("a request carrying no identity", () => {
  it("sees nothing", async () => {
    // Anonymous is the state every request starts in. Deny by default
    // means the absence of a claim is not the absence of a restriction.
    const { rows } = await asStudent(null, `select id from public.plans`);
    expect(rows, "an unauthenticated request could read plans").toHaveLength(0);
  });

  it("cannot write either", async () => {
    await expect(
      asStudent(null, `
        insert into public.plans (id, user_id, doc)
        values ('anon', '${ANA}', '{}'::jsonb)
      `),
      "an unauthenticated request wrote a plan",
    ).rejects.toThrow(/policy/i);
  });
});
