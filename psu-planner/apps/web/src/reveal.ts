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

/* ── Scroll reveals ──────────────────────────────────────────────────────
   Where `animation-timeline: view()` exists the stylesheet already does this
   on the compositor thread and this function does nothing at all. The
   observer is only for browsers without it. */
function reveals(): void {
  if (reduced()) return;
  if (CSS.supports("animation-timeline", "view()")) return;
  if (!("IntersectionObserver" in window)) return;

  const targets = [...document.querySelectorAll<HTMLElement>(".reveal")];
  if (!targets.length) return;
  document.documentElement.classList.add("reveals-armed");

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        // One-way. Re-hiding on scroll-up makes a page feel broken when you
        // go back to re-read something.
        io.unobserve(e.target);
      }
    },
    { threshold: 0.15 },
  );
  for (const t of targets) io.observe(t);

  // Anything already on screen reveals at once rather than animating in
  // behind the fold the reader is currently looking at.
  requestAnimationFrame(() => {
    for (const t of targets) {
      if (t.getBoundingClientRect().top < window.innerHeight * 0.9) {
        t.classList.add("is-in");
        io.unobserve(t);
      }
    }
  });
}

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

reveals();
menu();
counters();
heroVideo();
