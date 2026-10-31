/** Landing page behaviour: scroll reveals, the overlay menu, and the count-up.
 *
 * All three are progressive enhancements, and the reveal one is deliberately
 * inverted: the class that HIDES an element is added here, at runtime, and
 * only on browsers that lack native scroll-driven animation. If this script
 * never loads, never parses, or throws, every element is simply visible —
 * which is the only acceptable failure mode for a page whose whole premise is
 * that it reads without JavaScript.
 */

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Scroll restoration ───────────────────────────────────────────────────
   THE PAGE OPENED AT THE BOTTOM. The journey's scroller has its natural
   height until the 3D mounts, at which point `journey.ts` sets it to
   `scenes * 100vh` -- six screens. On a reload or a back-navigation the
   browser restores the previous offset against the SHORT page, the chunk
   then lands and the document grows six-fold underneath it, and the reader
   is left somewhere near the end of a journey they have not taken. Scrolling
   back up then runs the camera through the scenes in reverse, which is what
   "it breaks the animation" was.

   Turning restoration off is the honest fix rather than a workaround: this
   page is one continuous animation driven by scroll offset, so an offset
   restored from a previous visit is not a position in a document, it is a
   frame number from a different screening. Deep links still work -- a hash
   is an explicit request and is honoured below, after the height is final.

   Set at module scope so it lands before the browser's restore. */
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

/** Put the reader where the URL says, once the page is its final height.
 *
 * Called after the journey mounts, because scrolling to `#about` while the
 * scroller is still short lands hundreds of pixels off. */
function applyEntryPosition(): void {
  const hash = location.hash.slice(1);
  const target = hash && document.getElementById(hash);
  if (target) {
    target.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }
  // `instant`, not `smooth`: this is where the page STARTS, and animating
  // to it would show the reader a scroll they did not perform.
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}

/* The scroll-reveal pass that used to live here is gone with the design it
   served. The page was a stack of modules that faded in as you reached them;
   it is now one journey whose scenes cross-fade from scroll progress, which
   `landing/journey.ts` drives. Nothing on any page carries `.reveal`. */

/* ── Overlay menu ─────────────────────────────────────────────────────── */
function menu(): void {
  const btn = document.querySelector<HTMLButtonElement>("#menu-btn");
  const panel = document.querySelector<HTMLElement>("#menu");
  if (!btn || !panel) return;

  const focusable = () => [...panel.querySelectorAll<HTMLAnchorElement>("a[href]")];
  let lastFocused: HTMLElement | null = null;

  const close = () => {
    panel.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    // Wait for the slide-out before hiding, or the panel vanishes mid-motion.
    const done = () => {
      panel.hidden = true;
      panel.removeEventListener("transitionend", done);
    };
    if (reduced()) done();
    else panel.addEventListener("transitionend", done);
    lastFocused?.focus();
  };

  const open = () => {
    lastFocused = document.activeElement as HTMLElement;
    panel.hidden = false;
    // Next frame: a transition from a just-unhidden element does not run.
    requestAnimationFrame(() => panel.classList.add("is-open"));
    btn.setAttribute("aria-expanded", "true");
    focusable()[0]?.focus();
  };

  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  // A link inside the overlay is a destination, so close on the way out.
  panel.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (panel.hidden) return;
    if (e.key === "Escape") {
      close();
      return;
    }
    // Focus trap. Without it, tab walks out of the overlay into the page
    // behind it, which is still there and still focusable.
    if (e.key !== "Tab") return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

/* ── Proof-strip count-up ─────────────────────────────────────────────────
   The final value is already in the markup, rendered by the build from the
   catalog. This only animates toward it, so a reader who never runs the
   script — or who asked for less motion — sees the real number immediately
   rather than a zero that never moves. */
function counters(): void {
  if (reduced()) return;
  if (!("IntersectionObserver" in window)) return;
  const els = [...document.querySelectorAll<HTMLElement>("[data-count-to]")];
  if (!els.length) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        io.unobserve(el);
        const target = Number(el.dataset.countTo);
        if (!Number.isFinite(target)) continue;
        const suffix = el.dataset.countSuffix ?? "";
        const started = performance.now();
        const DURATION = 900;
        const tick = (now: number) => {
          const t = Math.min(1, (now - started) / DURATION);
          // Ease out, so it decelerates into the real figure.
          const v = Math.round(target * (1 - (1 - t) ** 3));
          el.textContent = v.toLocaleString("en-US") + suffix;
          if (t < 1) requestAnimationFrame(tick);
          else el.textContent = target.toLocaleString("en-US") + suffix;
        };
        requestAnimationFrame(tick);
      }
    },
    { threshold: 0.6 },
  );
  for (const el of els) io.observe(el);
}

/* ── Hero loop ────────────────────────────────────────────────────────────
   WCAG 2.2.2: anything that moves, auto-starts and runs past five seconds
   needs a visible way to stop it. The control ships hidden and is revealed
   here, because a pause button that cannot pause anything is worse than no
   button — and `controls` is not an option, since the browser's chrome over
   a silent product loop reads as a video the reader is meant to scrub. */
function heroVideo(): void {
  const video = document.querySelector<HTMLVideoElement>("#watch video");
  const wrap = document.querySelector<HTMLElement>("#video-controls");
  const btn = document.querySelector<HTMLButtonElement>("#video-toggle");
  if (!video || !wrap || !btn) return;

  wrap.hidden = false;
  // Reduced motion means reduced motion, including the one piece of motion
  // that is the page's main illustration. It stays on the first frame until
  // asked for, which is what the poster is there for.
  if (reduced()) {
    video.autoplay = false;
    video.pause();
  }

  const sync = () => {
    btn.textContent = video.paused ? "Play" : "Pause";
  };
  btn.addEventListener("click", () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener("play", sync);
  video.addEventListener("pause", sync);
  sync();
}

/* ── The 3D prerequisite journey ─────────────────────────────────────────
   ADR 0002 and docs/landing-3d-journey.md. Three.js is ~140 KB and is NEVER
   in the initial payload: it arrives through a dynamic `import()`, and only
   once the container is actually on screen.

   The static module inside the container is the baseline, not a degraded
   state. If the guards say no, if the import fails, if WebGL will not start
   — the page is already complete and nothing is missing. That is why the
   failure path here is silent: there is nothing for a reader to act on. */
/** Whether the 3D journey is going to be attempted at all.
 *
 * Two guards, and both are correctness rather than budget avoidance (the ADR
 * is explicit that the desktop-only guard was dropped -- the 3D is the
 * product demonstration, so phones get it too, with a tighter camera).
 *
 * `save-data` is a reader telling us not to spend their bytes; reduced
 * motion is a reader telling us not to move things. Neither is negotiable,
 * and neither has anything to do with how big the chunk is.
 *
 * Pulled out of `journey()` because the ANSWER is needed long before the
 * mount: see `holdStatic` below. */
function will3D(): boolean {
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData === true) return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  // A canvas we cannot create is not worth downloading a renderer for.
  try {
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) return false;
  } catch {
    return false;
  }
  return "IntersectionObserver" in window;
}

/* ── The flash before the scene ──────────────────────────────────────────
   THE GRAPHIC GLITCH ON FIRST LOAD. The static SVG chain is the page's
   no-JavaScript fallback, so it is in the markup and paints immediately --
   and it carries its own entrance animation, a 1.6s line draw with the
   stops popping in behind it. The 3D chunk lands around 700ms later and
   `is-live` clips the SVG away. MEASURED: the reader watches a flat transit
   diagram start drawing itself, then vanish mid-stroke and be replaced by
   something else entirely.

   So the DECISION to mount, which is synchronous and cheap, is made here --
   not when the chunk arrives -- and the static chain is held back the whole
   time. Held, not removed: every path that gives up on the 3D releases it
   again, so the fallback still appears for a reader who was never going to
   get the scene. A CSS delay alone could not do this, because the chunk's
   arrival time is a network fact and no fixed delay is right for everyone.

   An inline <head> script would hide it a few milliseconds sooner. The CSP
   is `script-src 'self'` with no `unsafe-inline`, so there is no such thing
   available here -- and a module script runs before first paint in practice,
   which the CSS fade below covers either way. */
const HOLD = "journey-pending";
function holdStatic(): void {
  if (will3D()) document.documentElement.classList.add(HOLD);
}
function releaseStatic(): void {
  document.documentElement.classList.remove(HOLD);
}

function journey(): void {
  const container = document.querySelector<HTMLElement>("#journey");
  if (!container) {
    releaseStatic();
    return;
  }
  if (!will3D()) {
    releaseStatic();
    return;
  }

  let started = false;
  const io = new IntersectionObserver(
    (entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return;
      started = true;
      io.disconnect();
      void import("./landing/journey.js")
        .then(({ mount }) => {
          const handle = mount(container);
          container.classList.add("is-live");
          // The document is only now its real height -- mount is what sets
          // the scroller's `100vh` per scene. Anything that depends on the
          // final height has to happen after this line, not before.
          applyEntryPosition();

          // NOT `pagehide` -> dispose. That is what broke the back button:
          // pagehide fires on a bfcache suspend, the scene was torn down,
          // and nothing remounted it on the way back -- the observer had
          // already disconnected itself and `started` was still true, so
          // the reader returned to a dead canvas and a pinned stage.
          //
          // The page comes back out of the bfcache intact, so the right
          // move is to keep the scene and resync it. The render loop is
          // already paused while hidden by the journey's own
          // visibilitychange handler, so nothing runs in the background.
          addEventListener("pageshow", (e) => {
            if ((e as PageTransitionEvent).persisted) handle.resync();
          });
          // Disposal is gated on `persisted` being FALSE -- a real unload,
          // not a bfcache suspend. It must not be an `unload` listener:
          // registering one makes the page bfcache-INELIGIBLE in Chrome, so
          // the tidier-looking version would have silently disabled the
          // very restore path this is here to support.
          addEventListener("pagehide", (e) => {
            if (!(e as PageTransitionEvent).persisted) handle.dispose();
          });
        })
        .catch(() => {
          // Offline, blocked, or a chunk that never shipped. The static
          // chain is still sitting there and still says the same thing --
          // so let it through, which is the whole reason it was held
          // rather than removed.
          releaseStatic();
        });
    },
    { rootMargin: "200px" },
  );
  io.observe(container);
}

// Before anything else: decide whether the static chain is about to be
// replaced, and if so keep it off the screen rather than letting it animate
// and then disappear.
holdStatic();

menu();
counters();
heroVideo();
journey();
