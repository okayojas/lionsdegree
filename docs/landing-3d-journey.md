# Landing page — 3D prerequisite journey

**Build spec: tools, prompts, and the one decision that has to be made first.**

Adds a scroll-driven 3D prerequisite graph to the landing page. Companion to `Landing-Page-Canvas-Spec.md` (the identity) and `docs/media-brief.md` (the assets). Where this disagrees with the Canvas Spec, this is newer — the Canvas Spec was written before the page existed.

---

## 1. What already exists — do not rebuild it

| Thing | Where | State |
|---|---|---|
| Landing page | `apps/web/src/landing.ts`, `landing.css` | Built to the Canvas Spec. One canvas, modules, route line. |
| Palette | `apps/web/src/styles.css` | **Petrol** `--primary: #1d627f` light / `#8dc1d8` dark. The violet is gone. |
| Product shots | `public/shots/*.png` | Placeholders from `scripts/product-shots.mjs`. Ojas owns replacing them. |
| Weight budget | `test/build-output.test.ts` | **260 KB total**, enforced at build. |

This document adds one thing: a 3D scene the user travels by scrolling, replacing or augmenting a static module.

**Proof of concept:** `3d-prereq-journey-test.html` at the repo root. Open it in a browser. It is the target behaviour in the real palette.

---

## 2. The decision that has to be made first

### What the budget actually is

An earlier draft of this document said Three.js blows a 260 KB page budget. That was wrong, and the real shape matters.

`test/build-output.test.ts` enforces **two separate limits**:

| Limit | Scope | Value | Rationale, from the test's own comments |
|---|---|---|---|
| Images | `<img src>` in `index.html`, distinct files | **< 260 KB total**, < 140 KB each | *"Images are the largest contentful paint here, so their weight is what a student on a phone actually waits for."* Written after the brand mark shipped as 192 KB of full-depth PNG for four flat colours. |
| Scripts | `<script src>` in `index.html` | **< 20 KB total** | *"Whatever it does load stays tiny; the planner bundle is ~500 KB."* A separate assertion proves `/assets/plan-*.js` is absent, so the landing page can never pull in the app. |

So the ceiling that governs Three.js is the **20 KB script budget**, not the image one. Three.js tree-shaken and gzipped is ~140 KB: seven times over.

### The loophole, named out loud

Both assertions parse `index.html` markup. **A chunk fetched by a runtime `import()` appears in neither**, so lazy-loading Three.js passes the suite as written without the suite ever having considered it.

Passing a test is not the same as honouring it. The person who wrote that budget wrote it because a student on a phone waits for this page. The question is not "can this pass" but "is the 3D worth 140 KB to that student."

### Why the guards make it principled rather than sneaky

The answer is that **the phone student never downloads it.** The guards in this section mean the chunk is fetched only on a desktop viewport, on a fast connection, without save-data, without reduced-motion, and only after the user has scrolled to it. The budget's purpose — protect the mobile first paint — is preserved exactly, by a different mechanism than counting bytes in markup.

That is a defensible position *provided the guards are real and tested*. If they are weakened later, this becomes the loophole it looks like. Hence the explicit guard test in §7.

### Decided: raise the budget — see `docs/adr/0002-raising-the-landing-script-budget.md`

The script budget moves, and **the measurement is fixed first**. Both existing assertions parse `index.html` markup, so a runtime `import()` would have slipped past them. Stepping through that blind spot was available and was rejected: a budget that can be avoided by changing *how* a file is requested rather than *whether* it is downloaded measures nothing.

Order of operations, and it matters:

1. **Change `test/build-output.test.ts` to resolve the dynamic import graph** and count every script a landing-page visitor actually downloads.
2. Build, and **measure** the real chunk.
3. Set the new ceiling at measured + ~20% headroom. Record the measured figure in the commit message. Do not guess the number in advance.

The image budget stays at 260 KB. Nothing here concerns images.

**What survives from the guard approach, as correctness rather than as budget avoidance:** `prefers-reduced-motion` and `save-data` still skip the 3D entirely. Those were never about payload.

**What changes:** desktop-only is dropped. The 3D is the product demonstration, not a desktop easter egg, so phones get it too — with a tighter camera and labels for only the nearest two or three nodes, because thirteen projected labels on a 390 px screen is an unreadable pile. That is a legibility constraint, not a performance one; the scene is about thirty draw calls.

Four ways out. Pick one before writing code.

**A. Raise the budget.** Rejected. The budget exists because the audience arrives on a phone from a shared link during registration week. Raising it to accommodate decoration inverts the reason it exists.

**B. Progressive enhancement via dynamic import. ← recommended.** Three.js never enters the initial payload. The page ships exactly as it does today and stays within 260 KB. The 3D scene loads as a separate chunk, later, only where it is warranted. The static module remains the baseline and the permanent fallback.

**C. No Three.js.** Do a 2.5D version with CSS 3D transforms and SVG — nodes on `translateZ` planes, parallax by depth. Maybe 4 KB. Less impressive, fits today, no new dependency.

**D. Put the 3D on its own route** (`/atlas/`), excluded from the landing budget entirely.

If B's guards (below) feel like too much machinery, **C is a legitimate answer** and should not be treated as a consolation prize.

### B's load guards — all must pass

```ts
const warranted =
  matchMedia('(min-width: 1024px)').matches &&
  !matchMedia('(prefers-reduced-motion: reduce)').matches &&
  (navigator.connection?.saveData !== true) &&
  !/2g|slow-2g|3g/.test(navigator.connection?.effectiveType ?? '4g');
```

Plus: only fire the import when an `IntersectionObserver` says the scene's container has entered the viewport. Never on page load.

**The build test must be updated to exclude the lazy chunk explicitly**, or it will either fail wrongly or pass silently while the initial payload grows. That is a task, not a footnote.

---

## 3. Tools

| Need | Choice | Why |
|---|---|---|
| 3D | `three@^0.169.0` | Already proven in the artifact. Import only what you use — `WebGLRenderer`, `Scene`, `PerspectiveCamera`, `TorusGeometry`, `SphereGeometry`, `BufferGeometry`, `Line`, `Points`, `CatmullRomCurve3`, `Fog`, `MeshBasicMaterial`. No loaders, no controls, no post-processing. |
| Types | `@types/three` as a dev dependency | Repo is TypeScript. |
| Scroll motion | **Nothing new.** | The page already uses CSS scroll-driven animation with an IntersectionObserver fallback. Do not add GSAP or Lenis. |
| Models | **None.** | All geometry is procedural: rings, spheres, lines. No GLB, no loader, no licensing question. |
| Fonts | Already loaded | Space Grotesk + JetBrains Mono, self-hosted via `@fontsource`. |

```bash
pnpm --filter web add three
pnpm --filter web add -D @types/three
```

**Do not add:** GSAP, Lenis, react-three-fiber, drei, any model loader, any physics library, any post-processing.

`react-three-fiber` in particular is tempting and wrong here: it pulls in a reconciler for a scene that has no React state in it.

---

## 4. Data contract

The scene reads from the catalog, not from a hardcoded list. One module, one export.

```ts
// apps/web/src/landing/journey-data.ts
export interface JourneyNode {
  code: string;        // "CMPSC 465"
  title: string;       // "Data Structures and Algorithms"
  pos: [number, number, number];
  main: boolean;       // on the camera path
  conflict?: boolean;  // prerequisite violation in the source plan
}
export interface JourneyEdge { from: number; to: number; }
```

Thirteen nodes, chain ending at `A-I 410`. The artifact has working coordinates — reuse them.

**The conflict node is the point of the whole scene.** `EE 456` is an enforced prerequisite of `A-I 410` and sits in the same term in the plan this was built from. It renders amber. Everything else is scaffolding around showing that the engine caught a real error.

Field-note records must quote the Bulletin verbatim and carry the standing disclaimer. Do not write new course descriptions.

---

## 5. Build prompts

Each is self-contained and assumes the repo is open. Run in order; each ends in a testable state.

### Prompt 1 — fix the measurement, then move the number

```
Read docs/adr/0002-raising-the-landing-script-budget.md. The decision is made;
implement it in the order the ADR states.

First change test/build-output.test.ts so the script assertion resolves the
dynamic import graph and counts every script a landing-page visitor actually
downloads, including chunks fetched at runtime. Today it only parses <script
src> out of index.html, which a runtime import() slips straight past.

Keep the image assertion at 260 KB untouched. Keep the assertion that
/assets/plan-*.js never appears.

Do not raise the number yet and do not write scene code. The raised ceiling is
set from a measured build in prompt 3. Open a GitHub issue per
docs/agents/issue-tracker.md tracking the number change.
```

### Prompt 2 — data module

```
Create apps/web/src/landing/journey-data.ts exporting JourneyNode[] and
JourneyEdge[] per docs/landing-3d-journey.md §4.

Use the thirteen courses and coordinates from 3d-prereq-journey-test.html at
the repo root. Course titles and any descriptive text must come verbatim from
the catalog JSON in public/catalog/ — do not paraphrase or invent. Mark EE 456
as conflict: true.

Add a unit test asserting every node code resolves against the catalog and
that every edge references a valid index. No rendering code in this step.
```

### Prompt 3 — the scene, lazy-loaded

```
Implement the 3D journey as a lazily-imported module.

- apps/web/src/landing/journey.ts exports mount(container: HTMLElement) and
  returns a dispose() function.
- The landing page imports it with dynamic import() behind the guards in
  docs/landing-3d-journey.md §2, triggered by IntersectionObserver.
- Port the scene from 3d-prereq-journey-test.html: ring nodes, line edges,
  CatmullRomCurve3 camera path, fog, dust points.
- Read colours from CSS custom properties at runtime via
  getComputedStyle(document.documentElement) — do not hardcode hex. The accent
  is --primary, currently petrol #8dc1d8 on dark.
- Scroll progress uses the existing smoothing already in landing.ts. Do not
  add a second scroll listener; reuse the one that exists.
- dispose() must remove listeners, cancel the rAF loop, and call .dispose()
  on every geometry, material and the renderer.

Confirm the initial bundle is unchanged and the chunk is separate.
```

### Prompt 4 — labels and dialog

```
Add HTML course labels projected from 3D positions, and wire them to the
existing field-notes dialog rather than building a new one.

- Labels are real DOM, positioned by projecting node positions to screen each
  frame. Not sprites, not canvas text.
- A label is focusable only when its node is near the camera; set tabIndex=-1
  otherwise so hidden controls are not in the tab order.
- Clicking opens the field-notes dialog with prev/next wrapping, arrow keys,
  Escape, backdrop dismissal, scroll lock, and focus restored to the trigger.
- The canvas element and all decorative geometry are aria-hidden. The labels
  carry the accessible names.
- Record changes announce politely via aria-live.
```

### Prompt 5 — fallback and reduced motion

```
Make the static path first-class, not a degraded one.

- When the guards fail, render the existing static module. It must look
  finished, not like something is missing.
- prefers-reduced-motion: never load Three.js at all.
- If WebGL context creation fails or is lost, fall back to static without a
  console error reaching the user.
- Test by forcing each guard false in turn.
```

### Prompt 6 — verify

```
Run the full check: pnpm build, the type checker, and the test suite including
test/build-output.test.ts.

Then verify in a browser at 1280x720, 1440x900, 768x1024 and 375x812:
initial payload still under 260 KB; the 3D chunk loads only on desktop after
scrolling; the EE 456 conflict node is visible and amber; keyboard-only
traversal of labels and dialog works; reduced motion skips the 3D entirely;
no horizontal scroll; no console errors.

Report the actual chunk size and the initial payload number.
```

---

## 6. Accessibility — non-negotiable

- `<canvas>` is `aria-hidden="true"`. It carries no information a screen reader needs.
- Course labels are real buttons with names like `Read the field notes for CMPSC 465, Data Structures and Algorithms`.
- Labels outside the near-camera range get `tabIndex=-1`. Controls in hidden scenes must not be focusable.
- Focus ring uses `--primary` at 2px with 3px offset. Never a border colour — borders measure 1.43:1 and 2.04:1 against the canvas and do not meet 3:1.
- `prefers-reduced-motion` skips the 3D path completely.
- Dialog: focus trap, Escape, backdrop click, focus restored to trigger without moving scroll position.

---

## 7. Acceptance

- [ ] ADR 0002 recorded before implementation
- [ ] `test/build-output.test.ts` **resolves the dynamic import graph**, not markup. The raised number is decorative until it does.
- [ ] New ceiling set from a measured build plus ~20% headroom, with the measured figure in the commit message
- [ ] Image budget untouched at 260 KB
- [ ] `prefers-reduced-motion` and `save-data` skip the 3D entirely
- [ ] Mobile gets the tighter camera and at most three labels in frame
- [ ] rAF loop stops when the scene leaves the viewport and on `visibilitychange`
- [ ] Planner-bundle assertion still passes; the landing page cannot pull in the app
- [ ] Static fallback looks finished, not broken
- [ ] Colours read from CSS custom properties; no hardcoded hex in the scene
- [ ] `dispose()` releases every geometry, material, renderer, listener and rAF
- [ ] Node codes and all copy verified verbatim against `public/catalog/`
- [ ] EE 456 renders amber and its record states the real conflict
- [ ] Canvas `aria-hidden`; labels carry accessible names; out-of-range labels not focusable
- [ ] Full keyboard path through labels and dialog
- [ ] No console errors at any of the four viewports

---

## 8. Do not

- Add GSAP, Lenis, react-three-fiber, drei, or a model loader.
- Load a 3D animal model. No CC0 rigged big cat with a run cycle exists in web format; everything usable is paid and mostly royalty-free rather than CC0. The earlier lion-runner artifact is superseded.
- Use Penn State navy. The petrol accent at `styles.css:74` is deliberately not PSU's colour, and the comment there says so.
- Hardcode hex in the scene. Read the tokens.
- Add a second scroll listener.
- Let the 3D become required. The page must be complete without it.
