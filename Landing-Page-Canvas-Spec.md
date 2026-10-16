# LionsDegree: Landing Page — Canvas Spec

**The definitive landing page spec.** Supersedes `Landing-Page-Spec.md` and `Landing-Page-UI-Spec.md`.

**Date:** October 2026

---

## DECISIONS CARRIED FORWARD

From the 2026-10-15 review, still binding.

- **No pricing, anywhere.** The project is open source.
- **§7.6 Discovery and §7.7 live demo ship as placeholders.** Neither feature exists (`okayojas/lionsdegree#22`, `#21`). A placeholder is honest; demonstrating a feature nobody can use is not.
- **Only F3 outstanding** from the old fix list: `font-weight: 800` at `styles.css` 218, 367, 386. Space Grotesk's variable axis tops out at 700, so the browser already clamps these. F1, F2, F4 are done. `og.png` exists.
- **Paths:** planner at `/plan/`. Privacy and terms at `/privacy/` and `/terms/` as separate URLs, because Google and Microsoft OAuth verification require separately reachable policy pages.
- **New custom properties are permitted** where the canvas needs tokens the app doesn't define.

**Superseded:** the earlier "cream-led with dark accents" decision. The canvas is dark throughout. See §1.

---

## 1. THE CANVAS

### 1.1 The decision

**The page is one continuous dark canvas: the planner's own background, carried across the whole site.** `--bg` dark (`#2b2a27`) with the dot grid from `styles.css:175` behind everything.

Not a stack of sections with different backgrounds. One canvas, start to finish, with content floating on it as discrete modules.

### 1.2 Why this works, specifically

Worth stating so nobody "fixes" it later.

**It is a warm dark, not a cold one.** `#2b2a27` is slightly olive-brown. It reads as slate, or dark paper, not as a terminal. Paired with `#ece6da` ink — warm cream, not white — the whole scheme is warm-on-warm. That is what makes it comfortable for long reading, and it is what separates this from the `#0a0a0a` default that every developer-tool site uses. **Do not let it drift toward neutral grey or pure black.** On an uncalibrated monitor the warmth can look like a colour cast and someone will try to correct it. It is deliberate.

**The contrast is genuinely good**, measured rather than assumed:

| Pair | Ratio | Verdict |
|---|---|---|
| `--text` `#ece6da` on `--bg` `#2b2a27` | **11.9:1** | Far exceeds AAA |
| `--text-muted` `#b0a89a` on `--bg` | **6.2:1** | Passes AA comfortably |
| `--primary` `#cba3ee` on `--bg` | **7.0:1** | Passes AA for text and UI |

So "easy on the eyes" is not a vibe here, it is measurable. High legibility at moderate overall luminance.

**The dot grid is the texture.** It supplies depth without a single image file, without parallax, and without anything that can look generated. It is already in the app, so the landing page and the product share one surface.

### 1.3 The finding that changes the module spec

I measured the surfaces too, and this matters:

| Pair | Ratio |
|---|---|
| `--surface` `#33322e` on `--bg` `#2b2a27` | **1.15:1** |
| `--surface-2` `#3c3a35` on `--bg` | **1.28:1** |
| `--border` `#45423c` on `--bg` | **1.45:1** |
| `--border-strong` `#5e584e` on `--bg` | **2.06:1** |

**Modules will barely separate from the canvas on fill alone.** A `--surface` card on `--bg` is a 1.15:1 difference, which is near-invisible. If modules are to read as floating objects, their edges have to do the work.

**Therefore, on this canvas:**

- Modules sit on **`--surface-2`**, not `--surface`. More separation, and it leaves `--surface` free for nested elements inside a module.
- Module borders use **`--border-strong`**, not `--border`.
- The **heavy dark shadows carry real weight here**. Dark `--shadow` is 0.45 alpha against light's 0.10 — that four-fold difference is doing the separation work, so do not tone it down.
- The **inset top highlight (§4.4) is mandatory**, not optional. On this canvas it is a primary separation cue, not a flourish.

Accept that the separation stays soft. That is consistent with "easy on the eyes," and it is why overlap and shadow matter more here than they would on cream.

### 1.4 Light mode

**The landing page is dark regardless of system preference.** It is a designed marketing surface, like a poster. The theme toggle in the nav affects `/plan/` only.

This is a decision, not an oversight — note it in code so nobody files it as a bug. The app continues to respect `prefers-color-scheme`.

Consequence: **all product assets are recorded in dark theme** so clicking through is continuous.

---

## 2. CANVAS LAYERS

Five layers, bottom to top. Only the top one scrolls normally; the rest are fixed or scroll-linked.

| z | Layer | Treatment |
|---|---|---|
| 0 | Base | `--bg` `#2b2a27`, fixed |
| 1 | Fine grid | `radial-gradient(color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px)` at **12px**, opacity .5 |
| 2 | Coarse grid | The existing `styles.css:175` grid at **24px** |
| 3 | Route spine | SVG, `--primary`, 3.5px, scroll-drawn, station dots at junctions |
| 4 | Modules | Opaque, `--surface-2` |

Two grids at different scales give depth with no moving pixels and no parallax. This is the cheapest depth in the spec and it does most of the work.

**Vignette:** a fixed radial gradient dimming the canvas edges by about 8%, so the centre reads as lit and modules feel placed rather than pasted.

---

## 3. THE ROUTE SPINE

The device that makes this one page rather than a stack.

One continuous SVG path from beneath the nav to the footer. It weaves between modules — left of one, right of the next — with a **station dot at every point a module attaches**. It draws as you scroll via `stroke-dashoffset`, reusing the existing `route-draw` keyframe, and always passes *behind* modules.

Station dots are rings (`background: var(--bg); border: 3px solid var(--primary)`), consistent with `.card .dot` and the wordmark. **Only the final dot at the footer is filled** — the end of the line.

Where discovery needs a second route, `--route-b` (`#7fae8b` dark) branches and rejoins. That is the only legitimate use of the green on this page.

On mobile the spine becomes a vertical line at 24px from the left, modules stacked to its right. Still unbroken.

---

## 4. MODULES

### 4.1 Built from real app CSS, never screenshots

The central technique, and what Obsidian actually does — their note, graph, plugin list and sync panel are live HTML recreations, which is why their text is in the DOM.

`styles.css` already contains every component needed:

| Module | Reuse |
|---|---|
| Course card | `.card`, `.card .code`, `.card .dot`, `.st-ok` `.st-warn` `.st-bad` |
| Semester column | `.col-header`, `.col-header .cr` |
| Course detail | `.modal`, `.modal .verbatim`, `.modal .status` |
| Search | `.search-results`, `.sr-item`, `.sr-code`, `.sr-snip mark` |
| Progress | `.progress`, `.progress .fill` with the "you are here" marker |
| AI advisor | `.chat-msg`, `.chat-bubble`, `.chat-tools` |
| List view | `.listview li`, `.lv-status` |
| Legend | `.legend`, `.legend .line` |

Advantages over images, all real: text indexable and screen-readable; pixel-perfect forever; kilobytes not hundreds of kilobytes; hover and focus actually work; never goes stale.

**Import the app stylesheet. Do not copy rules.** Copies drift.

### 4.2 Anatomy

- Background **`--surface-2`**, opaque always. Text must never sit on the dot grid.
- Border **`1.5px solid var(--border-strong)`** (see §1.3)
- `--r-lg` corners
- Elevation per §5.1
- Padding `--sp-4` to `--sp-6`
- An `.eyebrow` label — wayfinding labels are already the identity

**No backdrop blur.** A busy canvas is exactly when glassmorphism tempts and exactly when it is wrong. Opacity solves legibility properly.

### 4.3 Widths

Four, so the layout has rhythm instead of a uniform column.

| Size | Width | Use |
|---|---|---|
| `sm` | 280px | One course card, a stat, a line of proof |
| `md` | 420px | Most content |
| `lg` | 640px | Main explanation modules |
| `xl` | 900px | Hero video, flowchart fragment |

Never centre everything. Alternate left and right of the spine.

### 4.4 Light from above — mandatory here

```css
box-shadow: var(--shadow), inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent);
```

A 1px brighter top edge reads as a surface catching light. On this low-separation canvas it is a primary cue, not decoration. Nobody notices it consciously; everybody notices its absence.

---

## 5. DEPTH

### 5.1 Elevation tiers

Dark gives a five-step ramp: `#2b2a27` → `#33322e` → `#3c3a35` → `#43413c` → `#4d4a44`. Map it to **elevation**, not to component type.

| Tier | Surface | Shadow | Border | Use |
|---|---|---|---|---|
| 0 | `--bg` | none | none | Canvas |
| 1 | `--surface` | `--shadow-sm` | `--border` | Ambient modules only |
| 2 | `--surface-2` | `--shadow` | `--border-strong` | Standard content |
| 3 | `--surface-hover` `#43413c` | `--shadow-lg` | `--border-strong` | Hero, discovery, what matters |

Maximum three tiers visible at once. More reads as noise.

### 5.2 Overlap

The strongest depth cue, and free. Adjacent modules overlap vertically by **24 to 48px**, higher tier on top. Overlap implies z-space in a way shadow alone cannot.

Do it on roughly **a third** of module pairs. All of them looks like a collapsed stack.

### 5.3 Ambient modules

Three to five across the page. Tier 1, `scale(0.94)`, `opacity .55`. They read as further away, the way the planner has courses you aren't currently looking at.

**Decorative only** — never put information in them, because at `.55` opacity they fail contrast. `aria-hidden="true"`. They must contain real course codes, never lorem.

### 5.4 Hover

Modules lift exactly as `.card` does: `translateY(-1px)`, shadow one tier up, border to `--primary`. Reuse the existing transition so the page feels like the app under the cursor.

### 5.5 Prohibited

No parallax. No glassmorphism or backdrop blur. No gradient fills on modules. No glow. No shadow beyond `--shadow-lg`. No 3D transforms or perspective. Depth is elevation, overlap, scale and contrast — the four tools the app already uses.

---

## 6. INFORMATION ARCHITECTURE

| Path | Purpose | Status |
|---|---|---|
| `/` | The canvas | Launch |
| `/about` | Who built this and why | Launch |
| `/privacy/` | Separate URL — OAuth verification | Launch |
| `/terms/` | Separate URL — same reason | Launch |
| `/plan/` | The planner | Exists |
| `/changelog` | When there's something to log | Later |

**Overlay menu**, not inline nav. A `Menu` trigger top right opens full screen with large type. Trap focus, close on Escape, restore focus to the trigger. Reads as considered at any page count.

Nav bar: sticky, 56px, `--surface-2` with `1px solid var(--border-strong)` bottom, `z-index: 30`. Wordmark left, reusing the `h1::before` station dot from `styles.css:152`. One primary CTA right.

**Build target:** a separate static HTML entry via Vite `build.rollupOptions.input`, not a route inside the SPA. `/` is prerendered, `/plan/` mounts the app. A marketing page inside a client-rendered SPA is slow to first paint and bad for search, and this page is the growth channel.

---

## 7. PAGE FLOW

Not sections. **Stops on one route.** Each has a station dot.

### 7.1 Nav
Per §6.

### 7.2 Opening — `lg`, tier 2, left of spine

- Eyebrow: `UNOFFICIAL · BUILT FOR PENN STATE STUDENTS`
- Headline: `Your degree is a route map. Now you can see it.` `clamp(30px, 5.5vw, 46px)`, weight **700**, `--track-tight`, line-height 1.05
- Lede: `LionsDegree reads Penn State's Bulletin, works out what unlocks what, and builds a four-year plan that actually holds. Drag a course and it tells you what breaks.`
- CTAs: `Open the planner` primary, `Watch it work` ghost
- Trust: `--fs-xs` muted — `Free and open source. No account needed to try it.`

Two or three **ambient course cards** right of the spine, real codes, per §5.3.

### 7.3 Hero video — `xl`, tier 3

Canvas visible as a margin around it. Caption `.eyebrow`: `LIVE FROM THE PLANNER · REAL PENN STATE PREREQUISITES`.

```html
<video autoplay muted loop playsinline preload="metadata" poster="/hero-poster.avif"
       aria-label="Dragging a course into a semester where its prerequisite is not met, the warning appearing, and the one-click fix resolving it">
  <source src="/hero.webm" type="video/webm">
  <source src="/hero.mp4" type="video/mp4">
</video>
```

`autoplay muted loop playsinline` required for iOS. `preload="metadata"`, not `auto`, so it doesn't fight LCP. **Visible pause control required** — WCAG 2.2.2 applies to anything auto-playing beyond five seconds.

### 7.4 Proof — three `sm` modules in a row

Immediately after the hero, because proof directly below the CTA is the highest-leverage placement available and most comparable pages omit it.

```
14,553 courses   ·   756 programs   ·   95% of prerequisites machine-verified
```

Numbers `--fs-lg` weight 700, labels `--fs-xs` muted. Count up once on first view. Every number traceable to the catalog.

### 7.5 Three content modules, alternating sides

Each pairs prose with a **live HTML module** from real app CSS. Overlap where §5.2 allows.

| Eyebrow | Headline | Module |
|---|---|---|
| `THE DATA IS REAL` | Straight from the Bulletin | `.modal` with `.verbatim`, real description and enforced prerequisite text |
| `IT SOLVES THE ORDERING` | Fewest semesters, nothing out of sequence | Flowchart fragment: three `.col-header`, six `.card`, route lines between |
| `IT WORKS ON YOUR PHONE` | Built for registration week | `.listview` fragment at 390px in a drawn device frame |

### 7.6 Discovery — placeholder until `#22`

`lg`, tier 3, with `--route-b` branching off the spine and rejoining.

- Eyebrow: `THE PART NOBODY ELSE DOES`
- Headline: `Describe what you're into. Get a combination of real credentials.`
- Worked example as a live module:

```
"I like machine learning and clean energy"
   ├─ Engineering Science, B.S.     major
   ├─ Artificial Intelligence       minor
   └─ Energy Engineering            certificate
   14 credits double-count · 1 extra semester
```

**Placeholder treatment:** a `--warning`-bordered strip reading `In development`. No CTA, no pricing.

### 7.7 Live demo — placeholder until `#21`

Same treatment. When built: unauthenticated, deterministic, free. **Every drag needs a tap alternative** (WCAG 2.2 SC 2.5.7) — keyboard support alone does not satisfy it. Mobile gets list view, never a drag canvas.

### 7.8 What this isn't — `md`, tier 2

Raises trust for a tool people rely on for graduation decisions, and it suits an engine that refuses to guess.

- Not affiliated with or endorsed by Penn State.
- Not a substitute for your adviser. Confirm before you register.
- Course descriptions are verbatim from the University Bulletin.
- **If a requirement can't be verified, it says so instead of guessing.** ← `--text`, not muted.

### 7.9 Close

Final CTA repeated. The spine ends in the one filled station dot. Footer: wordmark, the disclaimer from `styles.css:136`, links to `bulletins.psu.edu`, `/privacy/`, `/terms/`, `/.well-known/security.txt`, GitHub, contact. Bottom line `--fs-xs` muted: `Open source. Built by a Penn State student.`

---

## 8. ASSETS

Because modules are live HTML, almost nothing is needed.

### A1. Hero loop — the only required asset

The one thing HTML can't do is show interaction over time.

**One unbroken take:** drag a course into a semester where its prerequisite isn't satisfied → amber warning appears → click the fix → card moves, dot turns green.

| Spec | Value |
|---|---|
| Theme | **Dark**, matching the canvas |
| Duration | 8 to 12 seconds, seamless loop |
| Audio | None |
| Framing | Three to four columns, ~8 cards. Not the whole plan. |
| Delivery | `hero.webm` (VP9) + `hero.mp4` (H.264 baseline) |
| Budget | Under 1.5MB WebM. Shorten rather than compress harder. |
| Poster | Exact first frame, `.avif` + `.webp` |

Record at 2560x1440 and downscale, 60fps, clean browser with no chrome, cursor moved slowly with ~300ms pause before each click, real ESci + AIE codes, no personal data.

```
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libvpx-vp9 -crf 32 -b:v 0 -an hero.webm
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libx264 -crf 24 -profile:v baseline -movflags +faststart -an hero.mp4
```

For a clean loop: record 20 seconds performing the action twice, cut one cycle where first and last frames match.

### A2. Later

AI advisor diff clip once `#22` exists. `og.png` and icons already exist — **re-check `og.png` reads correctly against the dark page**, since it was made for the old direction.

---

## 9. MOTION

**Native CSS scroll-driven animations by default.** Compositor thread, so they don't block the main thread or damage INP. Chromium 115+, Safari 26+.

```css
@supports (animation-timeline: view()) {
  .module {
    animation: rise linear both;
    animation-timeline: view();
    animation-range: entry 8% cover 28%;
  }
}
@keyframes rise {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: none; }
}
```

IntersectionObserver fallback at 15% visibility, once, never re-triggering on scroll up.

**GSAP only if you need scrubbed timelines.** The spine draw is the one candidate and it works with `animation-timeline: scroll()`.

**Lenis optional**, under 4KB, honours `prefers-reduced-motion` automatically. Paired with GSAP, disable its `autoRaf` and drive both from GSAP's ticker or you get two loops and jitter.

**Hard rule: animate `transform` and `opacity` only.** Layout-affecting properties force recalculation during interaction and are what actually wreck INP.

| Element | Motion | Duration |
|---|---|---|
| Module enter | Fade + 20px rise | 280ms `--ease-out` |
| Ambient enter | Fade only | 400ms |
| Spine | `stroke-dashoffset`, scroll-linked | continuous |
| Station dots | Existing `stop-pop` as the spine arrives | 340ms |
| Counters | Count up, once | 900ms |
| Hover | `translateY(-1px)` + shadow tier up | 150ms |

Nothing over 500ms except the spine. Stagger at most five siblings.

**Reduced motion:** no reveals, no spine draw, no counters; video replaced by poster plus play button.

---

## 10. RESPONSIVE

| Breakpoint | Behaviour |
|---|---|
| < 768px | Single column. Spine vertical at 24px left, modules stacked right. Full width minus `--sp-4`. **No overlap, no ambient modules, no `scale()`** — depth on a small screen reads as broken layout. Video stays. Demo becomes list view. |
| 768–1023 | Modules alternate but narrower. Overlap reduced to 16px. At most two ambient. |
| ≥ 1024 | Full canvas: alternating sides, overlap, ambient modules, all four widths. |
| ≥ 1440 | Canvas caps at 1280px centred. Spine stays centred. |

Design mobile first. Most shared links open on a phone, and the canvas concept is likeliest to break there.

---

## 11. ACCESSIBILITY

- Skip link, reusing `.skip-link`.
- One `h1`; modules use `h2`. Canvas layers create no heading structure.
- Grids, spine, vignette, ambient modules all `aria-hidden="true"`.
- Ambient modules are decorative only — they fail contrast by design.
- Video needs a visible pause control (WCAG 2.2.2).
- Every drag has a tap alternative (SC 2.5.7).
- `prefers-reduced-motion` disables autoplay, reveals and the spine.
- **Text contrast is verified** (§1.2): `--text` 11.9:1, `--text-muted` 6.2:1, `--primary` 7.0:1. All pass.
- **Borders do not meet 3:1** (`--border` 1.45:1, `--border-strong` 2.06:1). Acceptable for decorative module edges since shadow and the inset highlight also define them, but **focus indicators must use `--primary` (7.0:1), never a border colour.** The existing `:focus-visible` rule already does this — keep it.
- Modules opaque so text never sits on the grid.
- Test at 200% zoom and keyboard-only.

---

## 12. BUILD ORDER

1. **F3** — the three `font-weight: 800` declarations.
2. **Canvas layers.** Base, two grids, vignette. Static, no modules. Confirm the warmth survives.
3. **Module primitives.** Four widths, three tiers, inset highlight, hover. Import the app stylesheet.
4. **Route spine.** Static path first, threading correctly between module slots, before animating.
5. **Static page**, all stops, real copy, no motion.
6. **Record A1**, wire the video with poster, fallbacks, pause control.
7. **Live HTML modules** for §7.5.
8. **Motion.** Module reveals, then spine, then counters.
9. **Depth pass.** Overlap, ambient modules. Easiest thing here to overdo, so add it last and judge it against a finished page.
10. **`/about`, `/privacy/`, `/terms/`.**
11. **Audit.** Lighthouse, axe, keyboard-only, 200% zoom, 375/768/1024/1440.

---

## 13. ACCEPTANCE CRITERIA

**Canvas**
- [ ] One background, start to finish. No section bands, no `<hr>`, no per-stop background colours
- [ ] Warm dark preserved — `#2b2a27` not drifted toward neutral grey or black
- [ ] Both dot grids present at 12px and 24px
- [ ] Spine continuous from nav to footer
- [ ] Every module attaches at a station dot; only the closing dot is filled

**Depth**
- [ ] Modules on `--surface-2` with `--border-strong`, per §1.3
- [ ] Inset top highlight present on every module
- [ ] At most three elevation tiers visible at once
- [ ] Roughly a third of module pairs overlap, not all
- [ ] Three to five ambient modules, real course codes, `aria-hidden`
- [ ] No parallax, glass, gradient fills, glow, or 3D transforms

**Modules**
- [ ] Live HTML reusing app classes, not screenshots
- [ ] App stylesheet imported, not copied
- [ ] Every module opaque
- [ ] Hover matches the app

**Performance**
- [ ] LCP under 2.5s on throttled 4G mobile
- [ ] INP under 200ms
- [ ] CLS under 0.1; video and modules have explicit dimensions
- [ ] Only `transform` and `opacity` animated

**Accessibility**
- [ ] Canvas layers and ambient modules `aria-hidden`
- [ ] Visible video pause control
- [ ] Every drag has a tap alternative
- [ ] Focus indicators use `--primary`, never a border colour
- [ ] `prefers-reduced-motion` honoured throughout

**Content**
- [ ] Every number real and traceable
- [ ] No pricing anywhere
- [ ] Unbuilt features marked `In development`, no CTA
- [ ] Unofficial disclaimer visible without scrolling on mobile
- [ ] Banned words absent: supercharge, revolutionize, seamless, effortless, unlock your potential, empower, journey, game-changing
