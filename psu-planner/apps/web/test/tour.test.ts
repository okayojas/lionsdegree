/** The first-run tour (#71): which steps there are, and that it shows once.
 *
 * The component cannot be rendered here (no DOM), which is why its rules
 * live in a module of their own and are held here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const local = new Map<string, string>();
const storage = {
  getItem: (k: string) => local.get(k) ?? null,
  setItem: (k: string, v: string) => void local.set(k, String(v)),
  removeItem: (k: string) => void local.delete(k),
  clear: () => local.clear(),
  key: () => null,
  get length() { return local.size; },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const { markTourSeen, tourSeen, tourSteps } = await import("../src/data/tour");

beforeEach(() => local.clear());

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(web, rel), "utf-8");

describe("the tour's steps", () => {
  it("covers the chart, the requirements, what-ifs, the Menu, signing in and connecting an AI, in that order", () => {
    expect(tourSteps({ accounts: true, signedIn: false }).map((s) => s.id)).toEqual([
      "chart", "requirements", "whatifs", "menu", "signin", "connect", "done",
    ]);
  });

  it("says nothing about signing in to a student who is signed in", () => {
    expect(tourSteps({ accounts: true, signedIn: true }).map((s) => s.id)).not.toContain("signin");
  });

  it("says nothing about accounts or an AI where there is no account service", () => {
    const ids = tourSteps({ accounts: false, signedIn: false }).map((s) => s.id);
    expect(ids).not.toContain("signin");
    expect(ids).not.toContain("connect");
    expect(ids).toEqual(["chart", "requirements", "whatifs", "menu", "done"]);
  });

  it("names the things the owner asked it to teach", () => {
    const words = tourSteps({ accounts: true, signedIn: false }).map((s) => `${s.title} ${s.body}`).join(" ");
    for (const thing of [/Sign in/, /Connect Claude or ChatGPT/, /What-if/, /Change program/, /master's degree \(IUG\)/, /AP credit/, /minor/]) {
      expect(words).toMatch(thing);
    }
    // The planner's word for a scheduled period is Term (vocabulary.test.ts).
    expect(words).not.toMatch(/semester/i);
  });

  it("points every step at a control that carries its anchor, or at nothing", () => {
    const sources = [
      "src/App.tsx", "src/components/PlanCanvas.tsx", "src/components/PlanListView.tsx", "src/components/SidePanel.tsx",
      "src/components/CandidateRail.tsx", "src/components/AccountMenu.tsx", "src/components/ViewControls.tsx",
    ].map(read).join("\n");
    for (const step of tourSteps({ accounts: true, signedIn: false })) {
      if (step.anchor === null) continue;
      expect(sources, `nothing on screen carries data-tour="${step.anchor}"`).toContain(`data-tour="${step.anchor}"`);
    }
  });
});

describe("shown once", () => {
  it("has not been seen in a new browser, and has after it is finished or skipped", () => {
    expect(tourSeen()).toBe(false);
    markTourSeen();
    expect(tourSeen()).toBe(true);
  });

  it("counts as seen where the browser cannot remember, so it never comes back on every visit", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); } },
      configurable: true,
    });
    try {
      expect(tourSeen()).toBe(true);
      expect(() => markTourSeen()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is offered after a plan is loaded, marked seen whichever way it ends, and can be taken again from the Menu", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/if \(!plan \|\| loading \|\| loadError \|\| tourOffered\.current\) return;/);
    expect(app).toMatch(/if \(tourSeen\(\)\) return;/);
    expect(app).toMatch(/markTourSeen\(\);\s*setTour\(null\);/);
    expect(app).toMatch(/>Take the tour</);
  });
});
