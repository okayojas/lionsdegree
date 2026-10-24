# Raising the landing page script budget

`test/build-output.test.ts` holds the landing page to two weight limits: images under 260 KB total, and scripts referenced from `index.html` under 20 KB. Both were written against a page whose job was to describe the planner in text and three screenshots. The 20 KB script limit carries the comment *"whatever it does load stays tiny; the planner bundle is ~500 KB"*, and a companion assertion proves `/assets/plan-*.js` never leaks onto the page.

The landing page is becoming a scroll-driven 3D prerequisite graph: the visitor travels a real chain of thirteen Penn State courses and arrives at a real scheduling conflict the engine caught. That needs Three.js, which is roughly 140 KB gzipped after tree-shaking — seven times the script ceiling.

**We raise the script budget rather than engineer around it, and we fix the measurement at the same time.**

## The measurement was wrong first

Both existing assertions parse `index.html` markup. A chunk fetched by a runtime `import()` appears in neither, so lazy-loading Three.js would have passed the suite without the suite ever having considered it.

That route was available and we rejected it. Passing a test is not the same as honouring it, and a budget that can be stepped around by changing *how* a file is requested rather than *whether* it is downloaded is not measuring anything.

**So the test changes to count every script a landing-page visitor actually downloads, including chunks fetched at runtime.** Only then is the number raised. The new ceiling is set at the measured size of the real build plus roughly 20 percent headroom; it is not guessed in advance, and the measured figure is recorded in the commit that moves it.

The image budget is untouched at 260 KB. Nothing about this decision concerns images, and that limit still carries the scar it was written for — the brand mark once shipped as 192 KB of full-depth PNG for four flat colours.

## The precedent this sets

Budgets here are decisions, not laws, and they move under three conditions:

1. **The budget measures the thing it claims to measure.** If a change would pass only because the metric has a blind spot, the metric is fixed before the number moves.
2. **The reason is recorded as an ADR**, naming what is bought and what is given up.
3. **The protection the budget existed for is preserved by some other mechanism**, or its loss is stated plainly.

A budget nobody may ever change becomes dogma and gets worked around. A budget that moves silently measures nothing. The cost of this route is a short written argument, which is the point.

## Considered options

- **Lazy chunk behind device guards, budget untouched.** Initial payload unchanged, phone never downloads it. Rejected as the *primary* mechanism: it passes the suite only through the markup blind spot described above, and it makes the 3D a desktop easter egg when it is meant to be the product demonstration. The guards survive, but as correctness rather than as a way of avoiding the number.
- **CSS 3D transforms instead of Three.js.** About 4 KB, fits the existing ceiling outright, works on phones, no dependency. Rejected: no true perspective and no camera travelling a curve, which is the part that makes the prerequisite chain read as a journey rather than a diagram. Worth revisiting if the measured chunk comes in materially above expectation.
- **A separate `/atlas/` route with its own budget.** Rejected: it hides the strongest demonstration of the engine one click away from the page people actually land on.

## Consequences

- `test/build-output.test.ts` must resolve the dynamic import graph, not scan markup. Until it does, the raised number is decorative.
- **`prefers-reduced-motion` and `save-data` still skip the 3D entirely.** These were never about payload. Respecting them is correct independent of any budget, and they are now the only guards that remain mandatory.
- **Mobile keeps the 3D, but not the same framing.** Thirteen projected labels on a 390 px screen is an unreadable pile. Phones get a tighter camera with fewer nodes in frame and labels only for the nearest two or three. This is a legibility constraint, not a performance one; the scene is roughly thirty draw calls and runs fine.
- Battery cost of a continuous `requestAnimationFrame` loop on mobile is real. The loop must stop when the scene leaves the viewport and on `visibilitychange`.
- The landing page now has a runtime dependency it did not have. `dispose()` has to release every geometry, material, renderer, listener and animation frame, or repeated navigation leaks GPU memory.
- The planner-bundle assertion stays exactly as it is. Nothing here loosens the rule that the landing page cannot pull in the app.
