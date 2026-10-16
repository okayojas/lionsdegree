# LionsDegree: Landing Page UI Spec

**Supersedes** `Landing-Page-Spec.md`. Keep that file for the theme audit in section 0.

**Date:** October 2026 · **Revision 2** — canvas and module architecture

---

## DECISIONS LAYERED ON TOP (2026-10-15)

Agreed after reading this spec against the repo. Where these conflict with the body below, **these win**.

- **No pricing, anywhere.** The project is open source. The old "Try one free run" and "One run free. No card." are struck.
- **Cream-led with dark accents**, not cream-only. *(Revision 2 reinterprets this — see §1.2. The resolution is a single canvas that passes through a dark stretch, not cream-only and not dark-only.)*
- **§6.6 Discovery and §6.7 live demo ship as placeholders.** Neither feature exists (`okayojas/lionsdegree#22`, `#21`). A placeholder is honest; a section demonstrating a feature nobody can use is not. Both must be built before public launch.
- **Part 8 is largely stale.** F1 (JetBrains Mono) is self-hosted, F2 (meta tags) is done, F4 (reduced motion) is done. Only **F3** — `font-weight: 800` at `styles.css` 218, 367, 386 — is outstanding. `og.png` exists.
- **Paths:** the planner is at `/plan/`, not `/app`. Privacy and terms are at `/privacy/` and `/terms/` rather than a combined `/legal`, because Google and Microsoft OAuth verification require separately reachable policy URLs.
- **The no-new-custom-properties rule is relaxed** for the dark stretch, which needs surface and ink tokens the light-only palette does not define.

---

## 1. THE CANVAS

### 1.1 Why the page felt flat

The previous revision was a stack of full-bleed bands: hero band, proof band, feature band, discovery band. Each had its own background, so the eye read six separate pages glued together. Bands are the definition of flat, because every boundary resets depth to zero.

**Replace bands with one continuous canvas.** The background never changes section to section. Content sits *on* the canvas as discrete floating modules at varied positions and widths. There are no dividers, no full-bleed colour changes, no `<hr>`.

This also makes the page look like the product, which is the whole argument: the planner is a canvas with cards on it, so the landing page is a canvas with cards on it.

### 1.2 The canvas treatment — recommended

You asked for the dark flowchart background throughout. That works, and §1.3 specifies it. But it reverses your own cream-led decision and gives up the thing that makes you visually distinctive, because every developer-tool site is dark.

**Recommendation: one canvas that goes underground.**

The canvas starts as cream map paper, descends into a dark stretch for the middle of the page, and surfaces back to cream at the end. The dot grid and the route line run continuously through the transition, unbroken.

This is on-metaphor rather than arbitrary: transit maps go above ground and below ground. The route doesn't stop, the surroundings change. It gives you the depth and drama you want, keeps the cream that makes you recognisable, satisfies "cream-led with dark accents" as written, and still reads as one page because the route never breaks.

The transition is a 240px gradient on the canvas background only. Modules crossing the boundary keep their own surface token and simply swap theme variables via a scoped class.

**If you prefer all-dark**, everything else in this spec holds unchanged. Set the canvas to `--bg` dark throughout, drop the transition, and record product assets in dark theme for coherence. The module system, depth system, and route spine are identical either way.

### 1.3 Canvas layers

Four stacked layers, bottom to top:

| z | Layer | Treatment |
|---|---|---|
| 0 | Base fill | `--bg` (cream, or dark, or the transition) |
| 1 | Fine dot grid | `radial-gradient(... 6% ...) 1px` at **12px** spacing, opacity .5 |
| 2 | Coarse dot grid | The existing `styles.css:175` grid at **24px** spacing |
| 3 | Route spine | SVG, `--primary`, 3.5px, drawn on scroll, station dots at junctions |
| 4 | Modules | Opaque cards, see Part 2 |

Two grids at different scales produce depth without parallax and without a single moving pixel. This is the cheapest depth in the whole spec.

Add a **vignette**: a fixed radial gradient dimming the canvas edges to about 6%, which focuses attention centrally and makes modules feel lit.

### 1.4 The route spine

The single most important cohesion device. One continuous SVG path running the full length of the page, from under the nav to the footer. It weaves between modules — left of one, right of the next — and has a station dot at every point where a module attaches.

It draws as you scroll using `stroke-dashoffset`, reusing the existing `route-draw` keyframe. It passes *behind* modules, never over them.

Where the discovery section needs a second route, `--route-b` branches off and rejoins. That is the only legitimate use of the green.

On mobile the spine becomes a vertical line down the left margin at 24px, with modules stacked to its right. Still one continuous route.

---

## 2. THE MODULE SYSTEM

### 2.1 Build modules from real app CSS, not screenshots

This is the central technique, and it's what Obsidian actually does. Their note, graph, plugin list, sync settings and version-history diff are live HTML recreations of product UI, not images. That's why their text is in the DOM.

**You can do this better than almost anyone, because `styles.css` already contains every component you need:**

| Module | Existing class to reuse |
|---|---|
| Course card | `.card` + `.card .code` + `.card .dot` + status variants `.st-ok` `.st-warn` `.st-bad` |
| Semester column header | `.col-header` + `.col-header .cr` |
| Course detail | `.modal` + `.modal .verbatim` + `.modal .status` |
| Search results | `.search-results` + `.sr-item` + `.sr-code` + `.sr-snip mark` |
| Progress / audit | `.progress` + `.progress .fill` (with the "you are here" marker) |
| AI advisor | `.chat-msg` + `.chat-bubble` + `.chat-tools` |
| List view | `.listview li` + `.lv-status` |
| Legend | `.legend` + `.legend .line` |

**Why this beats screenshots on every axis:** real text in the DOM so it's indexable, selectable, translatable and screen-readable; pixel-perfect fidelity forever; a few KB instead of a few hundred; hover and focus states actually work; and it can never go stale when the app changes.

**Practical rule:** import the app's stylesheet into the landing page rather than copying rules. Copies drift.

### 2.2 Module anatomy

Every module is an opaque card on the canvas:

- Background `--surface`, never transparent. Text must never sit directly on the dot grid.
- `1.5px solid var(--border)`, matching `.card`
- `--r-lg` corners
- Elevation per §3.1
- Padding `--sp-4` to `--sp-6`
- A `.eyebrow` label, because wayfinding labels are already the identity

**No backdrop blur.** The canvas is busy, which is exactly when glassmorphism is most tempting and most wrong. Opaque surfaces solve legibility properly.

### 2.3 Module sizes

Four widths, so the layout has rhythm rather than a uniform column:

| Size | Width | Use |
|---|---|---|
| `sm` | 280px | A single course card, a stat, a quote |
| `md` | 420px | Most content modules |
| `lg` | 640px | The main explanation modules |
| `xl` | 900px | Hero video, full flowchart fragment |

Never centre everything. Modules alternate between left-of-spine and right-of-spine, with deliberate vertical overlap between neighbours (see §3.2).

---

## 3. THE DEPTH SYSTEM

You already have the tokens for this and aren't using them as elevation.

### 3.1 Elevation tiers

Dark mode gives you a five-step surface ramp: `#2b2a27` → `#33322e` → `#3c3a35` → `#43413c` → `#4d4a44`. Light gives the same count. **Map them to elevation**, not to component type.

| Tier | Surface | Shadow | Border | Use |
|---|---|---|---|---|
| 0 | canvas `--bg` | none | none | Background |
| 1 | `--surface` | `--shadow-sm` | `--border` | Ambient modules, quiet detail |
| 2 | `--surface` | `--shadow` | `--border` | Standard content modules |
| 3 | `--surface-2` | `--shadow-lg` | `--border-strong` | Hero, discovery result, the things that matter |

Three tiers visible at once is the maximum. More reads as noise.

### 3.2 Overlap

The strongest depth cue available and it costs nothing. Adjacent modules overlap vertically by 24 to 48px, with the higher-tier module on top. Overlap implies z-space in a way shadows alone never do.

Do this on roughly a third of module pairs. Every pair overlapping looks like a collapsed stack.

### 3.3 Distance

Ambient modules — ones that are texture rather than content — render at `scale(0.94)` and `opacity: 0.55`, at tier 1. They read as further away. Use them for decorative course cards scattered behind the real content, the same way the planner has courses you aren't currently looking at.

Three to five of these across the whole page. They must contain real course codes, never lorem.

### 3.4 Light from above

On dark canvas only, a 1px inset highlight on the top edge of each module:

```css
box-shadow: var(--shadow), inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent);
```

Classic dark-UI depth trick. Subtle enough that nobody notices it consciously, and the surface reads as catching light. Skip it on cream, where it muddies.

### 3.5 Hover

Modules lift on hover exactly as `.card` does: `translateY(-1px)`, shadow one tier up, border to `--primary`. Reuse the existing transition. This makes the page feel like the app under the cursor, which is the point.

### 3.6 What not to do

No parallax. No glassmorphism or backdrop blur. No gradient fills on modules. No glow. No shadow larger than `--shadow-lg`. No 3D transforms or perspective. Depth comes from elevation, overlap, scale and contrast — the same four tools the app already uses.

---

## 4. ASSET BRIEF (much reduced)

Because modules are live HTML, the screenshot list from revision 1 mostly disappears. What's still needed:

### A1. Hero loop — still required

The only thing HTML modules can't do is show interaction over time. This clip is the proof that the engine works.

**One unbroken take:** drag a course into a semester where its prerequisite isn't satisfied, the amber warning appears, click the one-click fix, the card moves and the dot turns green.

| Spec | Value |
|---|---|
| Duration | 8 to 12 seconds, seamless loop |
| Theme | Match the canvas at that point in the page |
| Audio | None |
| Framing | Three to four columns, ~8 cards. Not the whole plan. |
| Delivery | `hero.webm` (VP9) + `hero.mp4` (H.264 baseline) |
| Budget | Under 1.5MB WebM. Shorten rather than compress harder. |
| Poster | Exact first frame, `.avif` + `.webp` |

Record at 2560x1440 and downscale, 60fps, clean browser with no chrome, cursor moved slowly with a ~300ms pause before each click, real ESci + AIE course codes, no personal data.

```
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libvpx-vp9 -crf 32 -b:v 0 -an hero.webm
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libx264 -crf 24 -profile:v baseline -movflags +faststart -an hero.mp4
```

To get a clean loop: record 20 seconds performing the action twice, then cut one cycle where first and last frames match.

### A2. Optional second clip

The AI advisor diff preview appearing with Accept and Reject, 4 to 6 seconds. Only once that feature exists (`#22`).

### A3. Already done

`og.png` exists. Icons exist. No further stills needed — the modules replace them.

---

## 5. INFORMATION ARCHITECTURE

| Path | Purpose | Status |
|---|---|---|
| `/` | The canvas | Launch |
| `/about` | Who built this and why | Launch |
| `/privacy/` | Separate URL, OAuth verification needs it | Launch |
| `/terms/` | Separate URL, same reason | Launch |
| `/plan/` | The planner itself | Exists |
| `/changelog` | Once there's something to log | Later |

**Overlay menu**, not an inline nav. A `Menu` trigger top right opens a full-screen overlay with large type. Reads as considered at any page count.

Nav bar: sticky, 56px, `--surface` with `1px solid var(--border)` bottom, `z-index: 30`. Wordmark left using the `h1::before` station dot from `styles.css:152`. Theme toggle and one primary CTA right.

---

## 6. PAGE FLOW

Not sections. **Stops along one route.** Each has a station dot on the spine.

### 6.1 Nav
Per Part 5.

### 6.2 Opening — cream canvas

Text module, `lg`, tier 2, left of spine.

- Eyebrow: `UNOFFICIAL · BUILT FOR PENN STATE STUDENTS`
- Headline: `Your degree is a route map. Now you can see it.` `clamp(30px, 5.5vw, 46px)`, weight **700** (F3 — Space Grotesk tops out at 700), `--track-tight`, line-height 1.05
- Lede: `LionsDegree reads Penn State's Bulletin, works out what unlocks what, and builds a four-year plan that actually holds. Drag a course and it tells you what breaks.`
- CTAs: `Open the planner` primary, `Watch it work` ghost
- Trust line `--fs-xs`: `Free and open source. No account needed to try it.`

Two or three **ambient course cards** scattered right of the spine at tier 1, `scale(0.94)`, `opacity .55`, showing real codes.

### 6.3 Hero video — `xl`, tier 3

The video in a module, canvas visible as a margin around it. Caption in `.eyebrow`: `LIVE FROM THE PLANNER · REAL PENN STATE PREREQUISITES`.

```html
<video autoplay muted loop playsinline preload="metadata" poster="/hero-poster.avif"
       aria-label="Dragging a course into a semester where its prerequisite is not met, the warning appearing, and the one-click fix resolving it">
  <source src="/hero.webm" type="video/webm">
  <source src="/hero.mp4" type="video/mp4">
</video>
```

`autoplay muted loop playsinline` is required for iOS. `preload="metadata"`, not `auto`, so it doesn't fight LCP. **Visible pause control required** — WCAG 2.2.2 covers anything auto-playing beyond five seconds.

### 6.4 Proof — three `sm` modules in a row

Directly after the hero, because proof immediately below the CTA is the highest-leverage placement there is and most comparable pages skip it.

```
14,553 courses   ·   756 programs   ·   95% of prerequisites machine-verified
```

Numbers `--fs-lg` weight 700, labels `--fs-xs` muted. Count up on first view, once. Every number traceable to the catalog.

### 6.5 The descent — canvas goes dark

The 240px transition. The spine continues unbroken. An `.eyebrow` marks it: `UNDER THE HOOD`.

### 6.6 Three content modules on dark canvas

Alternating sides, overlapping where §3.2 allows. Each pairs prose with a **live HTML module** built from real app CSS.

| Eyebrow | Headline | Module to recreate |
|---|---|---|
| `THE DATA IS REAL` | Straight from the Bulletin | `.modal` with `.verbatim` showing a real description and enforced prerequisite text |
| `IT SOLVES THE ORDERING` | Fewest semesters, nothing out of sequence | A flowchart fragment: three `.col-header` columns, six `.card`s, route lines between them |
| `IT WORKS ON YOUR PHONE` | Built for registration week | `.listview` fragment at 390px width inside a drawn device frame |

### 6.7 Discovery — placeholder until `#22`

`lg`, tier 3, with `--route-b` branching off the spine and rejoining.

- Eyebrow: `THE PART NOBODY ELSE DOES`
- Headline: `Describe what you're into. Get a combination of real credentials.`
- The worked example as a live module:

```
"I like machine learning and clean energy"
   ├─ Engineering Science, B.S.     major
   ├─ Artificial Intelligence       minor
   └─ Energy Engineering            certificate
   14 credits double-count · 1 extra semester
```

**Honest placeholder treatment:** a `--warning`-bordered strip reading `In development`. No CTA promising a feature that doesn't exist, no pricing.

### 6.8 Live demo — placeholder until `#21`

Same treatment. When built: unauthenticated, deterministic, free. **Every drag needs a tap alternative** (WCAG 2.2 SC 2.5.7); keyboard support alone does not satisfy it. Mobile gets the list view instead of a drag canvas.

### 6.9 Surfacing — canvas returns to cream

### 6.10 What this isn't — `md`, tier 2

Raises conversion for a tool people trust with graduation decisions, and it's on-brand for an engine that refuses to guess.

- Not affiliated with or endorsed by Penn State.
- Not a substitute for your adviser. Confirm before you register.
- Course descriptions are verbatim from the University Bulletin.
- **If a requirement can't be verified, it says so instead of guessing.** ← `--text`, not muted.

### 6.11 Close

Final CTA repeated. The spine terminates in a filled station dot — the only filled dot on the page, every other being a ring. Footer: wordmark, the disclaimer from `styles.css:136`, links to `bulletins.psu.edu`, `/privacy/`, `/terms/`, `/.well-known/security.txt`, GitHub, contact. Bottom line `--fs-xs` muted: `Open source. Built by a Penn State student.`

---

## 7. MOTION

### Technique

**Native CSS scroll-driven animations by default.** They run on the compositor thread, so they don't block the main thread or damage INP. Chromium 115+, Safari 26+.

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

IntersectionObserver fallback at 15% visibility, once only, never re-trigger on scroll up.

**GSAP ScrollTrigger only if you need scrubbed timelines.** The route-spine draw is the one candidate, and even that works with `animation-timeline: scroll()`.

**Lenis optional**, under 4KB, honours `prefers-reduced-motion` automatically. If paired with GSAP, disable Lenis's `autoRaf` and drive both from GSAP's ticker or you get two loops and visible jitter.

**Hard rule: animate `transform` and `opacity` only.** Layout-affecting properties force recalculation during interaction and are what actually wreck INP.

### Choreography

| Element | Motion | Duration |
|---|---|---|
| Module enter | Fade + 20px rise | 280ms `--ease-out` |
| Ambient module enter | Fade only, no rise | 400ms |
| Route spine | `stroke-dashoffset`, tied to scroll | continuous |
| Station dots | Existing `stop-pop` as the spine reaches each | 340ms |
| Canvas transition | Background position, scroll-linked | continuous |
| Counters | Count up, once | 900ms |
| Module hover | `translateY(-1px)` + shadow tier up | 150ms |

Nothing over 500ms except the spine. Stagger no more than five siblings.

### Reduced motion

Full bypass: no reveals, no spine draw, no counters, canvas transition becomes a hard switch, video replaced by poster plus play button.

---

## 8. RESPONSIVE

| Breakpoint | Behaviour |
|---|---|
| < 768px | Single column. Spine becomes a vertical line at 24px left, modules stacked right of it. All modules full width minus `--sp-4`. **No overlap, no ambient modules, no `scale()`** — depth on a small screen reads as broken layout. Video stays. Demo becomes list view. |
| 768–1023 | Two-column feel, modules alternate but narrower. Overlap reduced to 16px. Ambient modules at most two. |
| ≥ 1024 | Full canvas. Alternating sides, overlap, ambient modules, all four widths. |
| ≥ 1440 | Canvas caps at 1280px, centred. Spine stays centred. |

Design mobile first. Most shared links open on a phone, and the canvas concept is the thing most likely to break there.

---

## 9. ACCESSIBILITY

- Skip link, reusing `.skip-link`.
- One `h1`; modules use `h2`. The canvas is decorative and must not create heading structure.
- Dot grid, route spine, vignette and ambient modules all `aria-hidden="true"`.
- Ambient modules at `opacity .55` are **decorative only** — never put information in them, since they will fail contrast.
- Video needs a visible pause control (WCAG 2.2.2).
- Every drag has a tap alternative (SC 2.5.7).
- `prefers-reduced-motion` disables autoplay and all reveals.
- **Measure `--text-muted` on `--bg` in both themes.** `#6b6353` on `#f1ebdf` and `#b0a89a` on `#2b2a27` are both plausible but unverified.
- Modules must be opaque so text never sits on the grid.
- Test at 200% zoom and keyboard-only.

---

## 10. BUILD ORDER

1. **F3** — the three `font-weight: 800` declarations at `styles.css` 218, 367, 386.
2. **Canvas layers.** Base, two grids, vignette. Static, no modules. Verify both themes and the transition.
3. **Module primitives.** The four widths, three elevation tiers, hover. Import the app stylesheet rather than copying.
4. **Route spine.** Static path first, threading correctly between module slots, before animating.
5. **Static page**, all stops, real copy, no motion.
6. **Record A1**, wire the hero video with poster, fallbacks, pause control.
7. **Live HTML modules** for §6.6, built from real app classes.
8. **Motion.** Module reveals, then spine draw, then counters.
9. **Depth pass.** Overlap, ambient modules, light-from-above. This is the step that's easy to overdo; add it last so you can judge it against a finished page.
10. **`/about`, `/privacy/`, `/terms/`.**
11. **Audit.** Lighthouse, axe, keyboard-only, 200% zoom, both themes, 375/768/1024/1440.

---

## 11. ACCEPTANCE CRITERIA

**Canvas and cohesion**
- [ ] Background never changes abruptly between stops; only the one 240px transition
- [ ] No `<hr>`, no full-bleed section bands, no per-section background colours
- [ ] Route spine is continuous from nav to footer with no breaks
- [ ] Every module attaches to the spine at a station dot
- [ ] Only the closing dot is filled; all others are rings

**Depth**
- [ ] At most three elevation tiers visible at once
- [ ] Roughly a third of module pairs overlap, not all
- [ ] Three to five ambient modules, all containing real course codes
- [ ] No parallax, glassmorphism, gradient fills, glow, or 3D transforms
- [ ] No shadow larger than `--shadow-lg`

**Modules**
- [ ] Content modules are live HTML reusing app classes, not screenshots
- [ ] The app stylesheet is imported, not copied
- [ ] Every module is opaque; no text sits on the dot grid
- [ ] Hover states work and match the app

**Performance**
- [ ] LCP under 2.5s on throttled 4G mobile
- [ ] INP under 200ms
- [ ] CLS under 0.1; video and modules have explicit dimensions
- [ ] Only `transform` and `opacity` animated anywhere

**Accessibility**
- [ ] Canvas layers and ambient modules are `aria-hidden`
- [ ] Video has a visible pause control
- [ ] Every drag has a tap alternative
- [ ] 4.5:1 body text and 3:1 borders in both themes, measured
- [ ] `prefers-reduced-motion` disables autoplay, reveals, spine and transition

**Content**
- [ ] Every number is real and traceable to the catalog
- [ ] No pricing anywhere
- [ ] Unbuilt features marked `In development`, with no CTA
- [ ] Unofficial disclaimer visible without scrolling on mobile
- [ ] Banned words absent: supercharge, revolutionize, seamless, effortless, unlock your potential, empower, journey, game-changing
