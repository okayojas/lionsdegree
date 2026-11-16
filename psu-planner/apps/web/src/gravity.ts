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
 *     three frames a second is worse than the page. The browser is asked
 *     twice: to refuse a slow context, and then what it is drawing with,
 *     because the first question is not always answered truthfully.
 * In each case this does nothing at all, and the page is the static one.
 *
 * TWO CLASSES ON <html>, and the stylesheet does the rest (landing.css):
 *   - `has-scene` from the moment this script runs: the sections are a
 *     screen each, so the page does not change height under the reader when
 *     the scene arrives;
 *   - `scene-live` once the scene has drawn: the plan section pins, and the
 *     sample Plan's list goes out of sight, because the spheres now draw it.
 * Until then the list is on the page, so there is never a moment with
 * neither.
 *
 * AND IF IT GOES WRONG, before the scene starts or after (the chunk does not
 * arrive, the renderer will not start, the browser takes the context away),
 * both classes come off, the canvas goes, the listeners go, and the page is
 * the static one again.
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

/** How long the page waits for the scene before it is the static page for
 * good. In that time the page is whole and usable; this only bounds how late
 * the plan section may still change under a reader. */
const GIVE_UP_AFTER_MS = 6_000;

/** A renderer that draws on the processor, by the names they go by. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function canRunScene(): boolean {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    const probe = document.createElement("canvas");
    // The browser is asked to refuse a context it could only give slowly.
    const fast: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl = probe.getContext("webgl2", fast) ?? probe.getContext("webgl", fast);
    if (!gl) return false;
    // ...and then asked what it is drawing with. Measured: a headless
    // Chromium with no GPU hands over a SwiftShader context even to a page
    // that has just asked it not to.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    // Browsers cap how many contexts a page may hold. Give this one back.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !SOFTWARE_RENDERER.test(renderer);
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
  // Asked, not tried: observing a type the browser does not know is not an
  // error, it is silence.
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("paint")) {
    const paints = new PerformanceObserver((list) => {
      if (!list.getEntriesByName("first-contentful-paint").length) return;
      paints.disconnect();
      run();
    });
    paints.observe({ type: "paint", buffered: true });
    // A paint that is never reported (a tab opened in the background) must
    // not leave the page waiting for its scene.
    window.setTimeout(run, 2000);
  } else {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
}

function start(): void {
  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>(".site-head");
  const footer = document.querySelector<HTMLElement>(".land-foot");
  const catalog = document.querySelector<HTMLElement>("#catalog");
  const plan = document.querySelector<HTMLElement>("#plan");
  const release = document.querySelector<HTMLElement>("#go");
  const pin = document.querySelector<HTMLElement>("#plan > .land-wrap");
  const planTop = document.querySelector<HTMLElement>(".plan-top");
  const caption = document.querySelector<HTMLElement>(".plan-figure figcaption");
  if (!header || !footer || !catalog || !plan || !release || !pin || !planTop || !caption) {
    // The page is not the one this was written for. Say so: a scene that
    // silently stops appearing is a bug nobody is told about.
    console.warn("The landing page's scene was not started: the page is missing a part it is laid out against.");
    return;
  }

  // The canvas. Made here, not written into the document: a page that never
  // gets a scene should not carry an empty box for one.
  const field = document.createElement("div");
  field.className = "field";
  field.setAttribute("aria-hidden", "true");
  field.append(document.createElement("canvas"));
  document.body.prepend(field);
  root.classList.add("has-scene");

  // ── How far down the page ──
  let progress = 0;
  let queued = false;
  const anchors = (): PageAnchors => ({
    catalog: catalog.offsetTop,
    plan: plan.offsetTop,
    release: release.offsetTop,
    viewport: window.innerHeight || 1,
  });
  const readScroll = (): void => {
    queued = false;
    progress = progressAt(window.scrollY, anchors());
    // Navy type on a navy footer is no header at all, so it steps aside as
    // the footer slides under it; and a header nobody can see must not be
    // somewhere the keyboard can land.
    const away = footer.getBoundingClientRect().top < header.offsetHeight * 0.8;
    // How tall the header is, for the stylesheet: it rides over the page
    // here, its links wrap to a second and third row on a narrow screen,
    // and the plan section's heading has to start below it.
    // On the body, where the stylesheet declares its default: a value set
    // higher up would lose to that declaration.
    document.body.style.setProperty("--head-height", `${header.offsetHeight}px`);
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
  // ONLY THE WHEEL, AND ONLY UP AND DOWN. The page is eased towards where
  // the wheel has asked for. Anything else that scrolls it (the keyboard,
  // the scrollbar, a link to an anchor, a finger) is the reader saying where
  // they want to be, and the glide gets out of the way at once.
  /** The share of the remaining distance covered in a sixtieth of a second. */
  const EASE = 0.09;
  let target = window.scrollY;
  let current = window.scrollY;
  let gliding = false;
  let glidedAt = 0;
  const glide = (at: number): void => {
    if (!gliding) return;
    // By the clock, not by the frame: the same glide on a 120 Hz screen.
    const sixtieths = Math.min(4, Math.max(0, at - glidedAt) / (1000 / 60));
    glidedAt = at;
    current += (target - current) * (1 - (1 - EASE) ** sixtieths);
    if (Math.abs(target - current) < 0.4) {
      current = target;
      gliding = false;
    }
    window.scrollTo(0, current);
    if (gliding) requestAnimationFrame(glide);
  };
  const onWheel = (e: WheelEvent): void => {
    // Pinch-zoom, a sideways wheel, shift-wheel: not ours.
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    if (!gliding) target = current = window.scrollY;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    target = Math.min(max, Math.max(0, target + e.deltaY * unit));
    if (!gliding) {
      gliding = true;
      glidedAt = performance.now();
      requestAnimationFrame(glide);
    }
  };
  const onScroll = (): void => {
    // Not where the glide put it: the reader scrolled some other way.
    if (gliding && Math.abs(window.scrollY - current) > 2) gliding = false;
    if (!gliding) target = current = window.scrollY;
    queueScroll();
  };
  /** A key or a pointer going down is the reader about to move the page
   * themselves, so the glide stops NOW and not when the page is seen to
   * have moved. It matters: the browser animates a keyboard scroll, and
   * folds any scroll a script makes meanwhile into that animation. One
   * last frame of glide after End was pressed left the page short of the
   * end by however far that frame had moved it (measured: 20 to 60px). */
  const stopGliding = (): void => {
    gliding = false;
  };

  let scene: SceneHandle | null = null;
  let abandoned = false;
  /** The page's text moving (a web font arriving, the window changing) moves
   * the band the rectangle sits in. */
  const textMoved = new ResizeObserver(() => scene?.relayout());

  /** Back to the static page, exactly, from wherever this has got to. */
  const abandon = (): void => {
    if (abandoned) return;
    abandoned = true;
    window.clearTimeout(giveUp);
    gliding = false;
    textMoved.disconnect();
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", stopGliding, true);
    window.removeEventListener("pointerdown", stopGliding, true);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", queueScroll);
    window.removeEventListener("pagehide", onPageHide);
    scene?.dispose();
    scene = null;
    delete window.__lionsdegreeScene;
    header.classList.remove("is-away");
    header.inert = false;
    field.remove();
    root.classList.remove("has-scene", "scene-live");
    document.body.style.removeProperty("--head-height");
  };
  const giveUp = window.setTimeout(abandon, GIVE_UP_AFTER_MS);
  // A real unload, not a suspend into the back/forward cache: the page
  // comes back out of that intact, scene and all.
  const onPageHide = (e: PageTransitionEvent): void => {
    if (!e.persisted) scene?.dispose();
  };

  afterFirstPaint(() => {
    import("./landing/scene.js")
      .then(({ mount }) => {
        if (abandoned) return;
        window.clearTimeout(giveUp);
        readScroll();
        const handle = mount(field, { progress: () => progress, band, lost: abandon });
        scene = handle;
        // Drawn. The plan section can pin and the list can step back; then
        // the band is measured again, because pinning has just moved it.
        root.classList.add("scene-live");
        readScroll();
        handle.relayout();
        textMoved.observe(planTop);
        textMoved.observe(caption);
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", queueScroll);
        window.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("keydown", stopGliding, true);
        window.addEventListener("pointerdown", stopGliding, true);
        window.addEventListener("pagehide", onPageHide);
        window.__lionsdegreeScene = {
          report: () => handle.report(),
          advance: (steps) => {
            readScroll();
            handle.advance(steps);
          },
        };
      })
      .catch((error: unknown) => {
        // Offline, blocked, a chunk that never shipped, or a renderer that
        // would not start. The page is still the page.
        console.warn("The landing page's scene could not start; showing the page without it.", error);
        abandon();
      });
  });
}

if (canRunScene()) start();
