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
function journey(): void {
  const container = document.querySelector<HTMLElement>("#journey");
  if (!container) return;

  // Two guards, and both are correctness rather than budget avoidance (the
  // ADR is explicit that the desktop-only guard was dropped — the 3D is the
  // product demonstration, so phones get it too, with a tighter camera).
  //
  // `save-data` is a reader telling us not to spend their bytes; reduced
  // motion is a reader telling us not to move things. Neither is negotiable,
  // and neither has anything to do with how big the chunk is.
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData === true) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // A canvas we cannot create is not worth downloading a renderer for.
  try {
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) return;
  } catch {
    return;
  }

  if (!("IntersectionObserver" in window)) return;

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
          addEventListener("pagehide", () => handle.dispose(), { once: true });
        })
        .catch(() => {
          // Offline, blocked, or a chunk that never shipped. The static
          // module is still sitting there and still says the same thing.
        });
    },
    { rootMargin: "200px" },
  );
  io.observe(container);
}

menu();
counters();
heroVideo();
journey();
