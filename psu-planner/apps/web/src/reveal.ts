/** Scroll reveals.
 *
 * A progressive enhancement, and deliberately a small one. Elements marked
 * `.reveal` start hidden ONLY once this script confirms it can reveal them —
 * the class that hides them is added here, at runtime. If the script never
 * runs, never loads, or throws, every element is simply visible, which is the
 * only acceptable failure mode for a page whose entire premise is that it
 * reads without JavaScript.
 *
 * IntersectionObserver rather than a scroll handler: it fires off the main
 * thread and does not run on every frame of a scroll.
 */
const SELECTOR = ".reveal";
const SHOW = "is-in";

function run(): void {
  // Someone who asked for less motion gets the page, not the animation.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  const targets = [...document.querySelectorAll<HTMLElement>(SELECTOR)];
  if (!targets.length) return;

  // Arm only now: until this line the elements have no hiding styles at all.
  document.documentElement.classList.add("reveals-armed");

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add(SHOW);
        // One-way. Re-hiding on scroll-up makes a page feel broken when you
        // go back to re-read something.
        io.unobserve(e.target);
      }
    },
    // Fire a little before the element's edge, so content is already settled
    // by the time it is comfortably in view.
    { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
  );

  for (const t of targets) io.observe(t);

  // Anything already on screen at load reveals immediately rather than
  // animating in behind the fold the user is currently looking at.
  requestAnimationFrame(() => {
    for (const t of targets) {
      if (t.getBoundingClientRect().top < window.innerHeight * 0.9) {
        t.classList.add(SHOW);
        io.unobserve(t);
      }
    }
  });
}

run();
