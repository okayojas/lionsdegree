/** The pages outside the planner: one surface, one header (#61).
 *
 * Connect your AI, Privacy and Terms used to pin themselves to the dark
 * theme and each carry a header of its own. They are documents a student
 * reads on the way to or from the planner, so they sit on the planner's own
 * cream and say where they are with the same wordmark.
 *
 * What these tests do NOT repeat: that the connect procedure is ordered and
 * code-free, that the legal documents read with JavaScript off, that a data
 * request has a private route. Those are in landing.spec.ts and still run
 * against these pages; nothing here loosens them.
 */
import type { Page } from "@playwright/test";
import { test, expect, expectNoA11yViolations } from "./fixtures";

const PAGES = ["/connect/", "/privacy/", "/terms/"] as const;

/** The light tokens, as the browser reports them. Literals on purpose: a test
 * that read `--bg` back out of the page would pass on any colour at all. */
const CREAM = "rgb(241, 235, 223)";
const PETROL = "rgb(29, 98, 127)";
const NAVY = "rgb(4, 31, 70)";

/** What the header offers, in order. */
async function headerLinks(page: Page): Promise<{ name: string; href: string }[]> {
  return page.getByRole("banner").getByRole("link").evaluateAll((links) =>
    links.map((a) => ({
      name: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href") ?? "",
    })),
  );
}

for (const path of PAGES) {
  test.describe(`${path} on the shared surface`, () => {
    test("sits on cream whatever the system asks for", async ({ page }) => {
      // The desktop-dark and mobile-dark projects run this with the system
      // set to dark. A page that merely stopped saying "dark" would follow
      // the system there; these pages have no dark version, so they say
      // light.
      await page.goto(path);
      const seen = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        page: getComputedStyle(document.body).backgroundColor,
        ink: getComputedStyle(document.body).color,
      }));
      expect(seen.theme, "the page still pins the dark theme").not.toBe("dark");
      expect(seen.page).toBe(CREAM);
      expect(seen.ink, "light paper with the dark theme's ink").toBe("rgb(43, 40, 34)");
    });

    test("carries the header, and every link in it goes somewhere", async ({ page, request }) => {
      await page.goto(path);
      const links = await headerLinks(page);
      expect(links).toEqual([
        { name: "LionsDegree", href: "/" },
        { name: "Planner", href: "/plan/" },
        { name: "Connect your AI", href: "/connect/" },
        { name: "Start my plan", href: "/plan/" },
      ]);
      for (const { name, href } of links) {
        const res = await request.get(href);
        expect(res.status(), `"${name}" points at ${href}, which did not serve`).toBe(200);
      }
    });

    test("the wordmark is the planner's: one word, two colours", async ({ page }) => {
      await page.goto(path);
      // ONE WORD. `exact` is the assertion: a wordmark built from two boxes
      // computes as "Lions Degree", and a screen reader says it that way.
      const home = page.getByRole("banner").getByRole("link", { name: "LionsDegree", exact: true });
      await expect(home).toBeVisible();
      const ink = await home.evaluate((a) => {
        const lions = a.querySelector("b")!;
        return {
          lions: getComputedStyle(lions).color,
          degree: getComputedStyle(lions.parentElement!).color,
          weight: getComputedStyle(lions).fontWeight,
          face: getComputedStyle(lions).fontFamily,
        };
      });
      expect(ink.lions).toBe(PETROL);
      expect(ink.degree).toBe(NAVY);
      expect(ink.weight).toBe("700");
      expect(ink.face).toMatch(/^"?Space Grotesk/);
    });

    test("the mark has no box round it", async ({ page }) => {
      await page.goto(path);
      const mark = page.getByRole("banner").locator("img");
      await expect(mark).toHaveCount(1);
      await expect.poll(() => mark.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      const seen = await mark.evaluate((img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const { data } = g.getImageData(0, 0, c.width, c.height);
        const alpha = (x: number, y: number) => data[(y * c.width + x) * 4 + 3];
        let opaque = 0, clear = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] === 255) opaque++;
          if (data[i] === 0) clear++;
        }
        const n = c.width * c.height;
        return {
          // WHERE THE PAPER IS. Not "the four corners": the mark is cropped
          // tight and the L's ink runs into both left-hand ones. The D is
          // round, so the right-hand corners are paper, and so is the gap
          // between the two letters where it meets the top edge.
          paper: {
            topRight: alpha(c.width - 1, 0),
            bottomRight: alpha(c.width - 1, c.height - 1),
            betweenTheLetters: alpha(Math.round(c.width * 0.26), 2),
          },
          // ...and where the ink is: the middle of the L's stem.
          ink: alpha(Math.round(c.width * 0.1), Math.round(c.height * 0.5)),
          clearShare: clear / n,
          opaqueShare: opaque / n,
          chip: getComputedStyle(img).backgroundColor,
          padding: getComputedStyle(img).padding,
        };
      });
      // The paper is gone...
      expect(seen.paper, "the mark still carries its paper").toEqual({ topRight: 0, bottomRight: 0, betweenTheLetters: 0 });
      expect(seen.clearShare, "almost nothing was cut out").toBeGreaterThan(0.2);
      // ...the ink is not: most of the picture is solid.
      expect(seen.ink, "the ink went with the paper").toBe(255);
      expect(seen.opaqueShare, "the ink went with the paper").toBeGreaterThan(0.5);
      // And nothing in the stylesheet paints the box back in behind it.
      expect(seen.chip).toBe("rgba(0, 0, 0, 0)");
      expect(seen.padding).toBe("0px");
    });

    test("sets its headings in Raleway, served from here", async ({ page, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      const elsewhere: string[] = [];
      page.on("request", (r) => {
        const url = r.url();
        if (!url.startsWith(origin) && !url.startsWith("data:")) elsewhere.push(url);
      });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      const h1 = page.getByRole("heading", { level: 1 });
      expect(await h1.evaluate((h) => getComputedStyle(h).fontFamily)).toMatch(/^"?Raleway/);
      // Named AND delivered: a family that is asked for and never arrives
      // falls back silently, and the page would look almost right.
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((f) => /Raleway/.test(f.family) && f.status === "loaded").length,
      );
      expect(loaded, "the heading names Raleway but no Raleway face loaded").toBeGreaterThan(0);
      expect(elsewhere, "the page asked another host for something").toEqual([]);
    });

    test("has no accessibility violations", async ({ page }) => {
      await page.goto(path);
      await expectNoA11yViolations(page, path);
    });

    test("the header is reachable by keyboard, in reading order", async ({ page }) => {
      await page.goto(path);
      const reached: string[] = [];
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
        reached.push(
          await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return "";
            // A focus nobody can see is a focus nobody has.
            const ring = getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) > 0;
            return `${(el.textContent ?? "").replace(/\s+/g, " ").trim()}${ring ? "" : " (no focus ring)"}`;
          }),
        );
      }
      expect(reached.slice(1)).toEqual(["LionsDegree", "Planner", "Connect your AI", "Start my plan"]);
      expect(reached[0], "the first stop is not a way past the header").toMatch(/^Skip to /);
    });

    for (const width of [320, 360, 412]) {
      test(`is no wider than a ${width}px phone`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        const m = await page.evaluate((screen) => ({
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          widest: [...document.querySelectorAll("*")]
            .map((e) => ({ e, w: e.getBoundingClientRect().width }))
            .filter((x) => x.w > screen + 1)
            .map((x) => `<${x.e.tagName.toLowerCase()} class="${x.e.getAttribute("class") ?? ""}"> ${Math.round(x.w)}px`)
            .slice(0, 3),
        }), width);
        // Against the SCREEN: once a touch browser has widened the layout
        // viewport to fit an offender, nothing is wider than innerWidth any
        // more (see no-horizontal-overflow.spec.ts).
        expect(m.innerWidth, `the page was zoomed out to fit: ${m.widest.join("; ")}`).toBe(width);
        expect(m.scrollWidth, `something is wider than the screen: ${m.widest.join("; ")}`).toBeLessThanOrEqual(width);
        // Nothing in the header has been pushed off the edge or dropped.
        for (const link of await page.getByRole("banner").getByRole("link").all()) {
          await expect(link).toBeVisible();
          const box = (await link.boundingBox())!;
          expect(box.x, "a header link starts off the left edge").toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, "a header link runs off the right edge").toBeLessThanOrEqual(width);
        }
      });
    }

    test("header links are big enough for a thumb", async ({ page, isMobile }) => {
      test.skip(!isMobile, "a property of touch, measured on the phone projects");
      await page.goto(path);
      for (const link of await page.getByRole("banner").getByRole("link").all()) {
        const box = (await link.boundingBox())!;
        expect(box.height, `"${await link.innerText()}" is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      }
    });
  });
}

test.describe("the header, with JavaScript off", () => {
  test.use({ javaScriptEnabled: false });

  for (const path of PAGES) {
    test(`${path} still has all of it`, async ({ page }) => {
      await page.goto(path);
      const banner = page.getByRole("banner");
      for (const name of ["LionsDegree", "Planner", "Connect your AI", "Start my plan"]) {
        await expect(banner.getByRole("link", { name, exact: true })).toBeVisible();
      }
    });
  }
});

test("the header says which page this is, and only on that page", async ({ page }) => {
  await page.goto("/connect/");
  await expect(page.getByRole("banner").getByRole("link", { name: "Connect your AI" })).toHaveAttribute("aria-current", "page");
  await page.goto("/privacy/");
  await expect(page.getByRole("banner").locator("[aria-current]")).toHaveCount(0);
});
