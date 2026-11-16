/** Things that have to be true of the landing page whether or not its scene
 * is running: once as the document (landing.spec.ts), once with the spheres
 * behind it and the layout that goes with them (scene.spec.ts). Each expects
 * the page to be open already; how it was opened is the caller's point.
 */
import type { Page } from "@playwright/test";
import { expect, contrast } from "./fixtures";

/** The three ways into the planner can be read, at rest and under the
 * pointer. axe reads the computed pair and has passed a button whose label
 * was the wrong blue on its own fill; these are the controls the page most
 * needs read, so each is measured. */
export async function expectWaysInReadable(page: Page): Promise<void> {
  for (const way of [
    page.getByRole("banner").getByRole("link", { name: "Start my plan" }),
    page.getByRole("main").getByRole("link", { name: "Start my plan" }),
    page.getByRole("contentinfo").getByRole("link", { name: "Open the planner" }),
  ]) {
    // The header steps aside over the footer when the scene is running, so
    // each is looked at from the top of the page unless it is further down.
    await page.evaluate(() => scrollTo(0, 0));
    await way.scrollIntoViewIfNeeded();
    const name = (await way.innerText()).trim();
    expect(await contrast(way), `"${name}" at rest`).toBeGreaterThanOrEqual(4.5);
    await way.hover();
    expect(await contrast(way), `"${name}" under the pointer`).toBeGreaterThanOrEqual(4.5);
  }
}

/** The hero's button does not sit on the headline. It once did: the page's
 * paragraph rule outranked the hero's own spacing and took it to nothing. */
export async function expectHeroWayInClear(page: Page): Promise<void> {
  const headline = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
  const way = (await page.getByRole("main").getByRole("link", { name: "Start my plan" }).boundingBox())!;
  expect(way.y - (headline.y + headline.height), "the button is hard up against the headline").toBeGreaterThanOrEqual(24);
}

/** Every link in the page and its footer can be reached with Tab, and shows
 * a focus ring when it is. */
export async function expectEveryLinkReachable(page: Page): Promise<void> {
  const links = await page.locator("main a, footer a").count();
  expect(links, "found no links to reach").toBeGreaterThan(10);
  const reached = new Set<string>();
  const unringed: string[] = [];
  // The skip link and the header's five come first; then every link on the
  // page, in order.
  for (let i = 0; i < links + 8; i++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        name: `${(el.textContent ?? "").replace(/\s+/g, " ").trim()} -> ${el.getAttribute("href")}`,
        inPage: Boolean(el.closest("main, footer")),
        ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    });
    if (!at?.inPage) continue;
    reached.add(at.name);
    if (!at.ring) unringed.push(at.name);
  }
  expect(reached.size, "some links cannot be reached with Tab").toBe(links);
  expect(unringed, "focused, with nothing to show it").toEqual([]);
}
