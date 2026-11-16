/** Decides whether the landing page gets its scene, and wires it to the page.
 *
 * THE PAGE DOES NOT NEED THIS. It is complete as a document (index.html). The
 * scene (landing/scene.ts) is a field of spheres laid over it, and this file
 * is the only thing that knows both exist. It is small and loads with the
 * page; the scene and three.js are a separate chunk it asks for afterwards,
 * so they are never in the way of the first paint.
 *
 * FOUR GUARDS, and none of them is about bytes:
 *   - reduced motion: a reader has asked for things not to move;
 *   - save-data: a reader has asked us not to spend their connection;
 *   - no WebGL: there is nothing to draw with;
 *   - WebGL in software only: there is, and it is no good. Measured, the
 *     scene draws at three frames a second without a GPU, and a scene at
 *     three frames a second is worse than the page.
 * In each case this does nothing at all, and the page is the static one.
 *
 * AND IF IT GOES WRONG LATER (the chunk does not arrive, the renderer will
 * not start), everything this file did is undone and the page is exactly the
 * static one again. That is why the decision is one class on <html>:
 * `has-scene` switches the layout (landing.css), and taking it away switches
 * it back.
 */
import { progressAt, type Band, type PageAnchors } from "./landing/field-math.js";
import type { SceneHandle, SceneReport } from "./landing/scene.js";

declare global {
  interface Window {
    /** The scene, for looking at from outside: a test, a console. Absent
     * when there is no scene. `advance` moves the simulation on without
     * waiting for the screen, so a test does not depend on how fast the
     * machine under it draws. */
    __lionsdegreeScene?: { report(): SceneReport; advance(steps: number): void };
  }
}

/** How long the page waits for the scene before it gives up and is the
 * static page for good. A layout that has waited this long should stop
 * waiting. */
const GIVE_UP_AFTER_MS = 10_000;

function canRunScene(): boolean {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    const probe = document.createElement("canvas");
    // The browser is asked to refuse a context it could only give slowly.
    const fast: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl = probe.getContext("webgl2", fast) ?? probe.getContext("webgl", fast);
    if (!gl) return false;
    // Browsers cap how many contexts a page may hold. Give this one back.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Runs `then` once the page has actually been painted, so the scene's
 * chunk competes with nothing the reader is waiting for.
 *
 * ASKED OF THE BROWSER, not guessed with a frame callback: a callback
 * scheduled for the first frame runs BEFORE that frame reaches the screen
 * (measured: the request went out 8 ms ahead of the paint). Where the
 * browser does not report paints, two frames on is the nearest thing. */
function afterFirstPaint(then: () => void): void {
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    then();
  };
  try {
    const paints = new PerformanceObserver((list) => {
      if (!list.getEntriesByName("first-contentful-paint").length) return;
      paints.disconnect();
      run();
    });
    paints.observe({ type: "paint", buffered: true });
  } catch {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
  // A paint the observer never reports (a tab opened in the background)
  // must not leave the page waiting for its scene.
  window.setTimeout(run, 2000);
}

function start(): void {
  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>(".site-head");
  const footer = document.querySelector<HTMLElement>(".land-foot");
  const sections = {
    catalog: document.querySelector<HTMLElement>("#catalog"),
    plan: document.querySelector<HTMLElement>("#plan"),
    release: document.querySelector<HTMLElement>("#go"),
  };
  const pin = document.querySelector<HTMLElement>("#plan > .land-wrap");
  const planTop = document.querySelector<HTMLElement>(".plan-top");
  const caption = document.querySelector<HTMLElement>(".plan-figure figcaption");
  if (!header || !footer || !sections.catalog || !sections.plan || !sections.release || !pin || !planTop || !caption) return;

  // The canvas. Made here, not written into the document: a page that never
  // gets a scene should not carry an empty box for one.
  const field = document.createElement("div");
  field.className = "field";
  field.setAttribute("aria-hidden", "true");
  field.append(document.createElement("canvas"));
  document.body.prepend(field);
  // The layout the scene is drawn against, from the first frame the page is
  // painted with this script running: no jump when the scene arrives.
  root.classList.add("has-scene");

  // ── How far down the page ──
  let progress = 0;
  let queued = false;
  const anchors = (): PageAnchors => ({
    catalog: sections.catalog!.offsetTop,
    plan: sections.plan!.offsetTop,
    release: sections.release!.offsetTop,
    viewport: window.innerHeight || 1,
  });
  const readScroll = (): void => {
    queued = false;
    progress = progressAt(window.scrollY, anchors());
    // Navy type on a navy footer is no header at all, so it steps aside as
    // the footer slides under it; and a header nobody can see must not be
    // somewhere the keyboard can land.
    const away = footer.getBoundingClientRect().top < header.offsetHeight * 0.8;
    header.classList.toggle("is-away", away);
    header.inert = away;
  };
  const queueScroll = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(readScroll);
  };

  const band = (): Band => {
    const box = pin.getBoundingClientRect();
    return {
      top: planTop.getBoundingClientRect().bottom - box.top,
      bottom: caption.getBoundingClientRect().top - box.top,
      height: box.height || window.innerHeight,
    };
  };

  // ── The wheel: a slow, weighty glide ──
  // Only the wheel. Keyboard, scrollbar and touch scroll as they always do.
  const LERP = 0.09;
  let target = window.scrollY;
  let current = window.scrollY;
  let gliding = false;
  const glide = (): void => {
    current += (target - current) * LERP;
    if (Math.abs(target - current) < 0.4) {
      current = target;
      gliding = false;
    }
    window.scrollTo(0, current);
    if (gliding) requestAnimationFrame(glide);
  };
  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) return; // pinch-zoom
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    if (!gliding) target = window.scrollY;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    target = Math.min(max, Math.max(0, target + e.deltaY * unit));
    if (!gliding) {
      gliding = true;
      current = window.scrollY;
      requestAnimationFrame(glide);
    }
  };
  const onScroll = (): void => {
    if (!gliding) target = current = window.scrollY;
    queueScroll();
  };

  let scene: SceneHandle | null = null;
  let abandoned = false;

  /** Back to the static page, exactly. */
  const abandon = (): void => {
    if (abandoned) return;
    abandoned = true;
    scene?.dispose();
    scene = null;
    delete window.__lionsdegreeScene;
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", queueScroll);
    header.classList.remove("is-away");
    header.inert = false;
    field.remove();
    root.classList.remove("has-scene");
  };
  const giveUp = window.setTimeout(abandon, GIVE_UP_AFTER_MS);

  const begin = (): void => {
    import("./landing/scene.js")
      .then(({ mount }) => {
        if (abandoned) return;
        window.clearTimeout(giveUp);
        readScroll();
        const handle = mount(field, { progress: () => progress, band });
        scene = handle;
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", queueScroll);
        window.addEventListener("wheel", onWheel, { passive: false });
        window.__lionsdegreeScene = {
          report: () => handle.report(),
          advance: (steps) => {
            readScroll();
            handle.advance(steps);
          },
        };
        // A real unload, not a suspend into the back/forward cache: the page
        // comes back out of that intact, scene and all.
        window.addEventListener("pagehide", (e) => {
          if (!e.persisted) handle.dispose();
        });
      })
      .catch((error: unknown) => {
        // Offline, blocked, a chunk that never shipped, or a renderer that
        // would not start. The page is still the page.
        console.warn("The landing page's scene could not start; showing the page without it.", error);
        window.clearTimeout(giveUp);
        abandon();
      });
  };
  afterFirstPaint(begin);
}

if (canRunScene()) start();
