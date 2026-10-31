/** The front door (#14).
 *
 * This page's job is to survive being shared. A student sends the link to a
 * group chat, and what arrives is a preview card rendered by something that
 * does not run JavaScript, followed — if they tap it — by a page that has to
 * load fast on a phone on campus wifi. Everything here is about that path.
 */

/** Scroll until the scene containing `selector` is the active one.
 *
 * The scenes do not scroll past the viewport — the stage is pinned and they
 * cross-fade in place — so `scrollIntoViewIfNeeded` has nothing to move and
 * reports success while the element is still at `opacity: 0`. Progress
 * through the scroller is the thing that selects a scene, so that is what
 * this drives. With the 3D inactive the scenes simply stack and this is a
 * harmless no-op. */
async function showScene(page: Page, selector: string): Promise<void> {
  // Wait for the journey to pin itself first. It arrives on a dynamic
  // import behind an IntersectionObserver, so a scroll computed before that
  // reads a scroller with no height yet, skips, and leaves scene 0 showing
  // — which looks exactly like the scene never activating.
  await page
    .waitForFunction(() => document.querySelector(".journey-stage.is-pinned") !== null, undefined, {
      timeout: 4000,
    })
    .catch(() => {
      /* no 3D here (no WebGL, reduced motion, save-data): scenes stack and
         are all visible, so there is nothing to drive. */
    });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)?.closest(".scene");
    const scenes = [...document.querySelectorAll("#scenes .scene")];
    const scroller = document.getElementById("journey-scroll");
    if (!el || !scroller || !scenes.length) return;
    const i = scenes.indexOf(el as HTMLElement);
    const span = scroller.getBoundingClientRect().height - window.innerHeight;
    if (span <= 0) return;
    window.scrollTo(0, scroller.offsetTop + span * ((i + 0.5) / scenes.length));
  }, selector);
  await page.waitForTimeout(800);
}

test.describe("with JavaScript turned off", () => {
  // The one script on this page sheds a stale service worker and nothing
  // else; the page must read completely without it. A previewer, a crawler
  // and a student on a locked-down machine all land here.
  test.use({ javaScriptEnabled: false });

  test("the page still explains what this is", async ({ page }) => {
    await page.goto("/");
    // The h1 is the wordmark now, so the EXPLAINING moved to the line under
    // it. Both are checked: a logotype alone tells a first-time reader
    // nothing, and a description with no name attached is not a landing
    // page either.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/LionsDegree/);
    await expect(page.getByText(/degree planner/i).first()).toBeVisible();
    await expect(page.getByText(/prerequisite/i).first()).toBeVisible();
  });

  test("every scene is there", async ({ page }) => {
    // The page is now one journey with a scene per feature. With no script
    // the scenes do not cross-fade -- they simply stack -- so every one of
    // them has to be readable in the markup.
    await page.goto("/");
    for (const heading of [
      /straight from the Bulletin/i,
      /Fewest terms, nothing out of sequence/i,
      /catches what you would not/i,
      /Bring your own AI/i,
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    // The "what this isn't" section was removed by request — the page is
    // about the product. What it carried that MATTERS is still asserted:
    // the unaffiliated disclaimer below, and the coverage breakdown that
    // `build-output.test.ts` scopes to `#coverage`. Its replacement heading
    // is checked here so the section cannot quietly disappear with it.
  });

  test("the way into the planner works", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: /Open the planner/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/plan/");
  });

  test("connecting an assistant is a link, not a code block", async ({ page }) => {
    // The page is for students, not developers. There was an npx command and a
    // JSON config block here; a student who has never opened a terminal has no
    // way to act on either, and seeing them says "this is not for you".
    await page.goto("/");
    await expect(page.locator("pre, code"), "the landing page is showing code").toHaveCount(0);
    const cta = page.getByRole("link", { name: /how to connect it/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/connect/");
  });

  test("the disclaimer is there and is not hidden in small print", async ({ page }) => {
    await page.goto("/");
    const disclaim = page.getByText(/not affiliated with/i).first();
    await expect(disclaim).toBeVisible();
    // "Prominent" is not a feeling: it has to be at least the body size the
    // rest of the page uses, not shrunk into a footnote.
    const size = await disclaim.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `the disclaimer renders at ${size}px`).toBeGreaterThanOrEqual(13);
  });

  test("the disclaimer is on the page and readable", async ({ page }) => {
    // THIS USED TO REQUIRE THE DISCLAIMER ABOVE THE FOLD, and the reason it
    // gave was that the page wore Penn State's own colours, so the denial
    // had to arrive before the association did. That premise no longer
    // holds: `--primary` was deliberately moved 20 degrees off Beaver Blue
    // for exactly this reason (styles.css), so the page no longer trades on
    // the University's colour at all.
    //
    // What replaced it: the statement appears ONCE, in the footer, where a
    // reader looks for it -- it had grown to three separate claims on one
    // page, which reads as a product nervous about itself rather than a
    // candid one. The planner carries the same line in its own footer on
    // every screen, so nobody reaches a plan without passing it.
    //
    // Still asserted here, because an unofficial tool that stops saying so
    // is a different and much worse problem than one that says it quietly.
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto("/");
    const claim = page.getByText(/not affiliated with/i).first();
    await expect(claim, "the landing page no longer says it is unofficial").toBeVisible();
    const size = await claim.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `the disclaimer renders at ${size}px`).toBeGreaterThanOrEqual(13);
  });
});

test.describe("discovery", () => {
  // It is not an unbuilt feature and must not read as one. The engine ships
  // in the MCP package today; what it needs is a model to interpret "machine
  // learning and clean energy", and the model is the student's own. So the
  // page hands over the sentence that starts it rather than a search box it
  // has no business rendering.
  test("hands over a prompt rather than calling itself unfinished", async ({ page }) => {
    // With the journey live the scenes cross-fade and only the current one
    // is on screen, so this scrolls to the AI scene the way a reader does.
    await page.goto("/");
    await showScene(page, "#discovery");
    const mod = page.locator("#discovery");
    await expect(mod).toBeVisible();
    await expect(mod.locator(".wip"), "discovery is still labelled in development").toHaveCount(0);
    await expect(mod.locator("#discovery-prompt")).toBeVisible();
    // The walkthrough link lives in the same scene, beside the prompt.
    await expect(page.locator("#ai").getByRole("link", { name: /how to connect it/i })).toHaveAttribute(
      "href",
      "/connect/",
    );
  });

  test("the prompt is plain text a student can read and edit", async ({ page }) => {
    await page.goto("/");
    await showScene(page, "#discovery");
    const text = (await page.locator("#discovery-prompt").innerText()).trim();
    // Long enough to be a real instruction, and English rather than an
    // incantation: this page is for people who have never opened a terminal.
    expect(text.length).toBeGreaterThan(80);
    expect(text).toMatch(/LionsDegree/);
    expect(text, "the prompt reads like code").not.toMatch(/[{}<>]|\bjson\b|^\s*\//i);
  });

  test("still reads with JavaScript off, minus the button", async ({ page, context }) => {
    await context.route("**/*.js", (r) => r.abort());
    await page.goto("/");
    // The prompt is markup, not something the script writes in. A student on
    // a locked-down machine can still select it by hand.
    await expect(page.locator("#discovery-prompt")).toContainText(/Penn State student/);
  });

  test("the copy button copies the prompt", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await showScene(page, "#discovery");
    await page.locator("[data-copy='discovery-prompt']").click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe((await page.locator("#discovery-prompt").innerText()).trim());
  });
});

test.describe("the prerequisite journey", () => {
  // docs/landing-3d-journey.md §7. The 3D is an enhancement over a module
  // that must already be complete, so these test the page WITHOUT it: the
  // guards, and what is left when they say no.
  test("the static chain is the whole story on its own, with no JavaScript", async ({ page, context }) => {
    await context.route("**/*.js", (r) => r.abort());
    await page.goto("/");
    const journey = page.locator("#journey");
    await expect(journey).toBeVisible();
    // Real course codes in the markup, not drawn by a script.
    await expect(journey).toContainText("EE 456");
    await expect(journey).toContainText("AI 410");
    // And the conflict is stated, not just coloured — colour alone carries
    // nothing to a reader who cannot see it.
    await expect(journey).toContainText(/enforced prerequisite/i);
    await expect(journey.locator("canvas"), "a canvas with scripting off").toHaveCount(0);
  });

  test("the chain keeps an accessible description even when the 3D takes over", async ({ page }) => {
    // The scene replaces the DIAGRAM, not the description. When WebGL is
    // available the SVG is hidden from sight but stays in the accessibility
    // tree, and the written verdict stays visible to everyone — an earlier
    // `display: none` removed both and nothing failed.
    await page.goto("/");
    await expect(page.getByRole("img", { name: /prerequisite chain/i })).toHaveCount(1);
    await expect(page.locator(".journey-verdict")).toBeVisible();
    await expect(page.locator(".journey-verdict")).toContainText(/EE 456/);
  });

  test.describe("under reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("never loads the 3D at all", async ({ page }) => {
      // Not "loads it and holds it still" — the guard returns before the
      // dynamic import, so Three.js is never fetched.
      const requested: string[] = [];
      page.on("request", (r) => requested.push(r.url()));
      await page.goto("/");
      await page.locator("#journey").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200);
      expect(requested.filter((u) => /journey-.*\.js/.test(u)), "the 3D chunk was fetched anyway").toEqual([]);
      await expect(page.locator("#journey canvas")).toHaveCount(0);
      // And what remains still looks finished.
      await expect(page.locator("#journey .journey-static")).toBeVisible();
    });
  });
});

test.describe("the static chain", () => {
  // The small decorative route diagram that used to sit mid-page is gone --
  // the journey's own chain is the page's diagram now, and two drawings of
  // the same idea was one too many.
  test("is drawn, not left half-finished", async ({ page }) => {
    await page.goto("/");
    const stops = page.locator(".journey-static .route-stop");
    await expect(stops).toHaveCount(8);
    for (let i = 0; i < 8; i++) {
      await expect(stops.nth(i)).toHaveCSS("opacity", "1", { timeout: 5000 });
    }
  });

  test("names each station with a course code", async ({ page }) => {
    await page.goto("/");
    const names = await page.locator(".journey-static .lp-stn").allTextContents();
    expect(names.length).toBeGreaterThan(4);
    for (const n of names) expect(n.trim()).toMatch(/^[A-Z]{2,8} \d/);
  });
});

/** The front door (#14).
 *
 * This page's job is to survive being shared. A student sends the link to a
 * group chat, and what arrives is a preview card rendered by something that
 * does not run JavaScript, followed — if they tap it — by a page that has to
 * load fast on a phone on campus wifi. Everything here is about that path.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures.js";

/** Scroll the whole page and let it settle before an accessibility scan.
 *
 * Scroll reveals start at `opacity: 0`, and axe computes contrast against
 * whatever is actually painted -- so an element mid-reveal measures as a
 * washed-out blend and the scan reports a contrast failure that no reader
 * ever sees. Worse, whether it fires depends on timing, so the result was
 * nondeterministic. Scanning the settled page is also simply more honest:
 * it is the page a student ends up looking at. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

test.describe("under reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero route is complete and still, not animating", async ({ page }) => {
    await page.goto("/");
    // Complete: a student who asked for less motion still gets the whole
    // diagram, rather than a line frozen at the first frame of its draw.
    const state = await page.evaluate(() => {
      const line = document.querySelector<SVGPathElement>(".journey-static .route-line")!;
      const stop = document.querySelector<SVGCircleElement>(".journey-static .route-stop")!;
      return {
        offset: getComputedStyle(line).strokeDashoffset,
        stopOpacity: getComputedStyle(stop).opacity,
        lineAnim: getComputedStyle(line).animationName,
      };
    });
    expect(state.stopOpacity, "a station is invisible under reduced motion").toBe("1");
    expect(parseFloat(state.offset), "the route is still part-drawn under reduced motion").toBe(0);
    expect(state.lineAnim, "the draw animation still runs under reduced motion").toBe("none");
  });

  test("nothing on the page transitions", async ({ page }) => {
    await page.goto("/");
    const moving = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const s = getComputedStyle(el);
        // `<source>` inside the hero video generates no box, so its computed
        // style resolves to empty strings rather than "0s". Named rather than
        // skipping everything that resolves empty, which would quietly exempt
        // any element the browser decided not to render.
        if (el.tagName === "SOURCE") continue;
        if (s.transitionDuration !== "0s" && s.transitionProperty !== "none") {
          bad.push(`${el.tagName.toLowerCase()}.${el.className}: ${s.transitionDuration}`);
        }
      }
      return bad.slice(0, 5);
    });
    expect(moving, `still transitioning:\n  ${moving.join("\n  ")}`).toEqual([]);
  });
});

test.describe("the landing page is usable", () => {
  test("has no mechanically detectable accessibility violations", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expectNoA11yViolations(page, "the landing page");
  });

  test("the chain is described for a screen reader", async ({ page }) => {
    // It carries the page's thesis. An unlabelled svg conveys none of it.
    await page.goto("/");
    await expect(page.getByRole("img", { name: /prerequisite chain/i })).toHaveCount(1);
  });

  test("reaches the planner by keyboard, without hunting", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    // First stop is the skip link, and it has to say so.
    const skip = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim());
    expect(skip).toMatch(/skip/i);

    // Then the planner, within a couple of stops. It used to be asserted as
    // the literal second stop, which stopped being true the moment the page
    // grew a header -- a brand link before the nav is ordinary, and reordering
    // the header to satisfy a test would be the tail wagging the dog. What
    // matters is that it is right there, not that it is at index 2.
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement)?.getAttribute("href"));
      if (href) seen.push(href);
      if (href === "/plan/") return;
    }
    throw new Error(`the planner is not among the first stops: ${JSON.stringify(seen)}`);
  });
});

test.describe("the coverage figure", () => {
  test("states the number with its qualifier, and reads with JavaScript off", async ({ page, context }) => {
    // The breakdown section is gone; the qualifier moved into the sentence
    // so the number never appears bare. With no script the scenes stack and
    // every one of them is readable.
    await context.route("**/*.js", (r) => r.abort());
    await page.goto("/");
    const claim = page.getByText(/resolve to real, named courses/i);
    await expect(claim).toBeVisible();
    await expect(claim).toContainText(/flagged for you, never guessed at/i);
  });

  test("the figure meets AA against what is behind it", async ({ page }) => {
    await page.goto("/");
    await showScene(page, "#journey-scroll");
    const ratio = await page.locator(".scene strong").first().evaluate((el) => {
      const lum = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const L = (css: string) => {
        const [r, g, b] = css.match(/\d+/g)!.map(Number);
        return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
      };
      let bg: Element | null = el;
      let bgColor = "";
      while (bg) {
        const c = getComputedStyle(bg).backgroundColor;
        if (c && !/rgba?\([^)]*,\s*0\)/.test(c) && c !== "transparent") { bgColor = c; break; }
        bg = bg.parentElement;
      }
      const a = L(getComputedStyle(el).color);
      const b = L(bgColor || getComputedStyle(document.body).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio, `the coverage figure measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("the legal documents", () => {
  // These are the pages an OAuth reviewer at Google or Microsoft opens to
  // verify the app, and neither reviewer's crawler runs React. They are also
  // the only place a visitor who never opens the planner can read a policy at
  // all, which is why they are documents and not a modal.
  test.use({ javaScriptEnabled: false });

  for (const [path, heading] of [
    ["/privacy/", /privacy policy/i],
    ["/terms/", /terms of use/i],
  ] as const) {
    test(`${path} is a real document with JavaScript off`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not serve`).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      // Substance, not just a title: the body has to actually render.
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(600);
      // Reachable in both directions — a reviewer landing on one needs the other.
      await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
    });

  }

  test("the landing page links to both", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
  });

  test("a data request has a private route, not a public tracker", async ({ page }) => {
    // Filing a deletion request as a GitHub issue means publishing it.
    await page.goto("/privacy/");
    await expect(page.getByRole("link", { name: /ovk5113@psu\.edu/i })).toBeVisible();
  });
});

test.describe("the legal documents, with scripting on", () => {
  // axe injects and runs IN the page, so these cannot live in the block above
  // that turns JavaScript off -- there, the injection simply times out and the
  // failure reads like a violation.
  for (const path of ["/privacy/", "/terms/"] as const) {
    test(`${path} has no accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoA11yViolations(page);
    });
  }
});

test.describe("connecting an assistant", () => {
  // The page exists because "paste a link into your settings" has to be
  // followable by a student who has never opened a terminal. Everything here
  // is a property of THAT, not of styling.
  test.use({ javaScriptEnabled: false });

  test("reads with JavaScript off", async ({ page }) => {
    const res = await page.goto("/connect/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/connect your ai/i);
    // The link itself must be plain selectable text, not injected by script:
    // someone setting up a connector is often on a locked-down machine.
    await expect(page.locator("#connector-url")).toContainText(/^https:\/\//);
  });

  test("shows no code anywhere", async ({ page }) => {
    await page.goto("/connect/");
    await expect(page.locator("pre, code"), "the connect page is showing code").toHaveCount(0);
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const jargon of ["npx", "npm install", "json", "terminal", "command line", "stdio"]) {
      expect(body, `"${jargon}" appears on a page written for non-programmers`).not.toContain(jargon);
    }
  });

  test("is an ordered procedure, because the steps depend on each other", async ({ page }) => {
    await page.goto("/connect/");
    // Sign in BEFORE copying the link: the link is only meaningful once the
    // account exists. An unordered list would lose that.
    const steps = page.locator(".steps > li");
    await expect(steps).toHaveCount(4);
    await expect(steps.first()).toContainText(/sign in/i);
    await expect(steps.nth(1)).toContainText(/copy/i);
  });

  test("says plainly that the connector is not live yet", async ({ page }) => {
    // Shipping a dead link with no warning sends students to paste something
    // that silently fails, and they blame their assistant.
    await page.goto("/connect/");
    await expect(page.getByText(/not live yet/i)).toBeVisible();
  });

  test("is reachable from the landing page and the footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /connect your ai/i }).first()).toBeVisible();
  });
});

test.describe("connecting an assistant, with scripting on", () => {
  test("has no accessibility violations", async ({ page }) => {
    await page.goto("/connect/");
    await expectNoA11yViolations(page);
  });

  test("the copy button copies the link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/connect/");
    await page.getByRole("button", { name: /^copy$/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(await page.locator("#connector-url").innerText());
  });
});

test.describe("the page's own controls", () => {
  test("every button is readable against its own fill", async ({ page }) => {
    // A bare `.band-deep a` is two classes and beat `.btn-go`, so the hero's
    // primary button rendered in link blue on its own cream fill. axe did not
    // flag it -- it reads the computed pair and both were "light" rather than
    // identical -- and it is the one control the page most needs read.
    await page.goto("/");
    const bad = await page.evaluate(() => {
      const lum = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const L = (css: string) => {
        const [r, g, b] = css.match(/[\d.]+/g)!.map(Number);
        return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
      };
      /** Walk up for the first ancestor that actually paints a background. */
      const behind = (el: Element): string => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !/rgba?\([^)]*,\s*0\s*\)/.test(bg) && bg !== "transparent") return bg;
        }
        return "rgb(255,255,255)";
      };
      const out: string[] = [];
      for (const el of document.querySelectorAll(".btn")) {
        const fg = L(getComputedStyle(el).color);
        const bg = L(behind(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio < 4.5) out.push(`${el.textContent?.trim()}: ${ratio.toFixed(2)}:1`);
      }
      return out;
    });
    expect(bad, "a button's label does not meet AA against its own fill").toEqual([]);
  });
});

test.describe("about and contact", () => {
  test("both sections exist and are linked from somewhere visible", async ({ page }) => {
    // Reachable, not "in the nav": below 34rem the bar keeps only the brand
    // and the primary action, which is ordinary on a phone. The footer links
    // both at every width, so that is where the guarantee lives.
    await page.goto("/");
    for (const id of ["about", "contact"]) {
      await expect(page.locator(`#${id}`), `no #${id} section`).toBeVisible();
      const links = page.locator(`a[href="#${id}"], a[href="/#${id}"]`);
      const visible = await links.evaluateAll((els) =>
        els.filter((e) => (e as HTMLElement).offsetParent !== null).length,
      );
      expect(visible, `nothing visible links to #${id} at this width`).toBeGreaterThan(0);
    }
  });

  test("about says who made it without inventing a company", async ({ page }) => {
    await page.goto("/");
    const about = page.locator("#about");
    await expect(about.getByRole("heading")).toBeVisible();
    // One student, named. Copy implying a team or a company would be the
    // kind of small lie that makes the honest parts read as marketing too --
    // and the opposite failure is just as bad: the section used to open
    // "one person's side project" and never say WHO, which is the one thing
    // an About section owes a reader. So the test asks for a name.
    const text = (await about.innerText()).toLowerCase();
    expect(text, "about does not say who built this").toMatch(/ojas/);
    expect(text, "about does not say they are a student").toMatch(/student/);
    expect(text, "about claims a team that does not exist").not.toMatch(/\bour team\b|\bwe are a company\b/);
    // The claim a reader can check for themselves.
    await expect(about.getByRole("link", { name: /github|open source/i })).toBeVisible();
  });

  test("contact reaches a human with JavaScript off", async ({ page, context }) => {
    // The form is script-driven. If it were the ONLY route, a student on a
    // locked-down machine would have a bug to report and nowhere to put it.
    await context.route("**/*.js", (r) => r.abort());
    await page.goto("/");
    const contact = page.locator("#contact");
    await expect(contact.locator("a[href^='mailto:']")).toBeVisible();
    await expect(contact.locator("#feedback-form"), "the form shows before it can work").toBeHidden();
  });

  test("the form appears once the script can drive it", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#feedback-form");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("data-enhanced", "true");
    await expect(form.locator("#fb-body")).toBeVisible();
    // Email is optional: feedback that requires identifying yourself is
    // feedback you do not get.
    await expect(form.locator("#fb-email")).not.toHaveAttribute("required", /.*/);
  });

  test("refuses an empty message instead of sending nothing", async ({ page }) => {
    await page.goto("/");
    await page.locator("#feedback-form button[type=submit]").click();
    await expect(page.locator("#feedback-form [data-status]")).toBeVisible();
    await expect(page.locator("#feedback-form")).toHaveAttribute("data-state", "error");
  });

  test("the honeypot is reachable by no one who can see", async ({ page }) => {
    await page.goto("/");
    const trap = page.locator("#fb-website");
    await expect(trap).toHaveCount(1);
    // Off-screen, not display:none — and out of the tab order, so a keyboard
    // user never lands in a field they cannot see.
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(page.locator(".fb-trap")).toHaveAttribute("aria-hidden", "true");
  });

  test("has no accessibility violations", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expectNoA11yViolations(page, "the landing page with about and contact");
  });
});

test.describe("entering and re-entering the page", () => {
  /** The journey's scroller has its NATURAL height until the 3D chunk lands,
   * at which point journey.ts sets it to one screen per scene. Anything that
   * restores a scroll offset across that growth lands in the wrong place --
   * measured before the fix: a reload from deep in the page came back at
   * scrollY 2334 of a document that was still only 3234px tall, i.e. near
   * the bottom, and scrolling back up ran the camera through every scene in
   * reverse. That is what "it starts me at the bottom and breaks the
   * animation" was. */
  const settle = async (page: import("@playwright/test").Page) => {
    await page.waitForTimeout(1800);
  };

  test("opens at the top, even after a reload from deep in the journey", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - 1200));
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.scrollY), "setup: never got down the page").toBeGreaterThan(500);

    await page.reload();
    await settle(page);
    expect(
      await page.evaluate(() => window.scrollY),
      "the page restored a scroll offset taken against a shorter document",
    ).toBe(0);
  });

  test("comes back from a sibling page with the journey still alive", async ({ page }) => {
    // The scene used to be disposed on `pagehide`, which fires on a bfcache
    // suspend too. Nothing remounted it: the observer had disconnected and
    // its `started` flag was still set, so the reader returned to a dead
    // canvas inside a stage that was still pinned.
    await page.goto("/");
    await settle(page);
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    test.skip(tall < 3000, "the 3D never mounted in this profile, so there is nothing to restore");

    await page.goto("/connect/");
    await page.goBack();
    await settle(page);

    expect(await page.evaluate(() => document.documentElement.scrollHeight), "the page came back short")
      .toBeGreaterThan(3000);
    expect(
      await page.evaluate(() => !!document.querySelector("#journey.is-live")),
      "the journey did not survive the back navigation",
    ).toBe(true);
  });

  test("still honours a deep link to a section", async ({ page }) => {
    // Forcing the top on entry must not break `/#about`. It is scrolled to
    // AFTER the journey mounts, because doing it while the scroller is
    // still short lands hundreds of pixels off.
    await page.goto("/#about");
    await settle(page);
    const top = await page.evaluate(() => document.getElementById("about")?.getBoundingClientRect().top ?? 9999);
    expect(Math.abs(top), `#about sits ${Math.round(top)}px from the top of the viewport`).toBeLessThan(200);
  });
});

test.describe("the first second of the page", () => {
  /** THE GRAPHIC GLITCH ON LOAD. The static SVG chain is the no-JavaScript
   * fallback, so it is in the markup and paints immediately, carrying its
   * own 1.6s line-draw. The 3D chunk lands around 700ms later and clips it
   * away -- so the reader watched a flat transit diagram start drawing
   * itself and then vanish mid-stroke.
   *
   * It is now held back from the moment the guards say the scene is
   * coming, and released again by every path that gives up on it. The
   * release half is the one that matters: holding it forever would mean a
   * reader with no WebGL sees an empty page where the illustration is. */
  test("never shows the static chain when the 3D is coming", async ({ page }) => {
    await page.goto("/");
    // Sampled across the window the flash used to live in.
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      // OPACITY, not `visibility`: the chain has to stay in the
      // accessibility tree the whole time (see "keeps an accessible
      // description" above), so invisibility here can only ever mean
      // opacity 0. Asserting on `visibility` would pass for an
      // implementation that broke the screen-reader description.
      seen.push(
        await page.evaluate(() => {
          const el = document.querySelector(".journey-static");
          return el ? getComputedStyle(el).opacity : "absent";
        }),
      );
      await page.waitForTimeout(120);
    }
    const mounted = await page.evaluate(() => !!document.querySelector(".journey-canvas"));
    test.skip(!mounted, "the 3D never mounted in this profile, so there was nothing to hide for");
    expect(seen.filter((v) => v !== "0"), "the static chain was visible before the scene arrived").toEqual([]);
    // And it is still announced, invisible or not.
    await expect(page.getByRole("img", { name: /prerequisite chain/i })).toHaveCount(1);
  });

  test("shows the static chain when the 3D chunk cannot be fetched", async ({ page }) => {
    // Offline, blocked by an extension, or a chunk that never shipped. The
    // page is complete without the scene and has to look it.
    await page.route("**/*journey*.js", (r) => r.abort());
    await page.goto("/");
    await page.waitForTimeout(2200);
    const el = page.locator(".journey-static");
    await expect(el, "the fallback illustration stayed hidden after the 3D failed").toBeVisible();
    expect(await page.evaluate(() => !!document.querySelector(".journey-canvas"))).toBe(false);
  });

  test("shows the static chain for a reader who asked for no motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForTimeout(1500);
    await expect(page.locator(".journey-static")).toBeVisible();
    expect(
      await page.evaluate(() => !!document.querySelector(".journey-canvas")),
      "the 3D mounted for a reader who asked for reduced motion",
    ).toBe(false);
  });
});
