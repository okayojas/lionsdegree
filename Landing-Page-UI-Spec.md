# LionsDegree: Landing Page UI Spec

**Supersedes** `Landing-Page-Spec.md`. Keep that file for the theme audit in section 0 and the three code fixes in section 1; everything else here replaces it.

**Date:** October 2026

---

## DECISIONS LAYERED ON TOP (2026-10-15)

Agreed after reading this spec against the repo. Where these conflict with the
body below, **these win**.

- **No pricing, anywhere.** The project is open source. §5.6's "Try one free
  run" and "One run free. No card." are struck — see the section itself.
- **Cream-led with dark accents**, not cream-only. The dominant surface is the
  map paper this spec argues for, but the hero imagery and the limits section
  sit on dark bands so the page is not flat. This supersedes both Part 1's
  "light theme for everything" and the all-dark build it replaced.
- **§5.6 Discovery and §5.7 live demo ship as placeholders.** Neither feature
  exists (`okayojas/lionsdegree#22`, `#21`). A placeholder is honest; a section
  demonstrating a feature nobody can use is not. Both must be built before
  public launch.
- **Part 8 is largely stale.** F1 (JetBrains Mono) is self-hosted, F2 (meta
  tags) is done, F4 (reduced motion) is done. Only **F3** — `font-weight: 800`
  at `styles.css` 218, 367 and 386 — is outstanding. A4 likewise: `og.png`
  exists.
- **Paths differ from the body.** The planner is at `/plan/`, not `/app`.
  Privacy and terms are at `/privacy/` and `/terms/` rather than a combined
  `/legal`, because Google and Microsoft OAuth verification require separately
  reachable policy URLs.
- **The no-new-custom-properties rule is relaxed** for the dark bands, which
  need surface and ink tokens the app's light-only palette does not define.

---

## 0. The architectural decision that drives everything

Bedrock Robotics uses cinematic photography because it has no product you can try in a browser. You do. **Your product is a better hero asset than any photograph**, and the job of this page is to prove the engine works in under ten seconds.

So the page leads with a **short silent video loop of the flowchart in use**, not a photograph and not a live canvas. Reasons, in order:

1. It loads instantly, needs no JavaScript, and works identically on a phone, where the drag canvas does not.
2. It shows the magic without the visitor having to work out what to do. A live demo asks for effort before it delivers value.
3. It costs nothing per visitor, unlike the AI discovery run.

The **live interactive demo moves further down the page** as "try it yourself," where it rewards people who are already interested. That sequencing is strictly better than either asset alone, and it fixes the mobile problem the earlier spec had to work around.

### Build target

Make the landing page a **separate static HTML entry**, not a route inside the SPA. Vite supports this through `build.rollupOptions.input`. `/` is a prerendered static page, `/app` mounts the planner. A marketing page inside a client-rendered SPA is bad for SEO and slow to first paint, and this page is your growth channel.

---

## PART 1: ASSET PRODUCTION BRIEF

This is the part to do first, because everything else is layout around these assets.

### Universal recording rules

- **Record at 2560x1440, deliver downscaled.** Downscaled footage is visibly sharper than footage captured at delivery size.
- **60fps** for anything with dragging. 30fps makes drag look like stuttering.
- **Clean browser:** no bookmarks bar, no extensions, no notifications, no other tabs. Use a fresh profile if needed.
- **Hide browser chrome entirely.** Crop it out, or record the viewport only. If you want a frame, use a drawn faux-browser bar in brand tokens rather than a real screenshot of Chrome.
- **Light theme for everything except the one dark-mode shot.** Cream is the brand; it reads warmer and is more distinctive than dark UI, which every SaaS page has.
- **Use the real ESci + AIE plan.** Real course codes (`CMPSC 465`, `A-I 341W`, `ESC 410H`, `EE 456`, `PHYS 214`) are the specificity that makes the page read as authored rather than generated.
- **Move the cursor slowly and deliberately.** Fast cursor movement reads as frantic. Pause ~300ms before each click so the eye can follow.
- **No personal data visible.** No real name, no email, no student ID, no account menu open.
- **Cursor:** keep it visible but do not use a highlight ring or click-burst effect. Those read as a tutorial screencast, not a product.

### A1. Hero loop — the single most important asset

**What it shows, in one unbroken take:** drag a course into a semester where its prerequisite is not yet satisfied, the amber warning appears, click the one-click fix, the card moves and the dot turns green.

> **Blocked.** The one-click fix does not exist (`okayojas/lionsdegree#21`), so
> the final beat cannot be recorded. Until it does, the hero uses the still
> flowchart already captured from the real planner.

That ten-second sequence demonstrates the entire engine. It is the only thing on the page that has to be perfect.

| Spec | Value |
|---|---|
| Duration | 8 to 12 seconds |
| Loop | Seamless. Start and end on the identical frame, same scroll position, cursor in the same place. |
| Audio | None. Record silent, strip the track. |
| Framing | Three to four semester columns, roughly eight cards visible. Not the whole plan. |
| Delivery | `hero.webm` (VP9) + `hero.mp4` (H.264 baseline, for Safari/iOS) |
| Size budget | **Under 1.5MB for the WebM.** If it is larger, shorten it rather than compressing harder. |
| Poster | `hero-poster.avif` with `.webp` fallback, the exact first frame |

**How to get the seamless loop:** record 20 seconds, perform the action twice, then cut a single cycle where the first and last frames match. Check by scrubbing the join.

**Encoding** (ffmpeg):
```
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libvpx-vp9 -crf 32 -b:v 0 -an hero.webm
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libx264 -crf 24 -profile:v baseline -movflags +faststart -an hero.mp4
```

### A2. Feature clips — three short loops

Same rules, 4 to 6 seconds each, silent, seamless, delivered the same way. Budget under 600KB each.

1. **Course detail.** Click a card, the modal opens showing the verbatim Bulletin description and the enforced prerequisite text. Proves the data is real and sourced.
2. **Discovery.** Type an interest phrase, results appear as a combination of major plus minor plus certificate with the double-counted credits shown. This is the wedge, so it earns a clip.
3. **AI advisor.** Ask something, the diff preview appears on the canvas with Accept and Reject. Shows the AI takes actions rather than chatting.

### A3. Still screenshots — five

Export at **2x**, deliver AVIF with WebP fallback, crop tight, round corners to `--r-lg` in CSS rather than baking them in. Transparent or cream background, never white.

1. **Full flowchart, zoomed out.** The whole four-year plan with prerequisite routes visible. This is the "wow, that's my degree" image.
2. **List view on mobile**, 390px wide frame. Proves it works on a phone.
3. **Degree audit / progress panel**, showing real remaining requirements.
4. **Dark mode**, any view. One shot only, to show the toggle exists.
5. **The discovery result**, as a static image for the OG card.

### A4. Open Graph image

1200x630, `og.png`. Must contain: the wordmark with station dot, one short line of copy, and a tight crop of the flowchart showing real course codes. Test it by pasting the URL into iMessage, Discord, and Slack, which render it differently.

This is currently missing entirely and it is the first thing anyone sees when a link is shared, which is your primary growth channel.

### A5. Icons

`favicon.svg`, `favicon-32.ico`, `apple-touch-icon.png` at 180px, and replacements for the placeholder `icon-192.png` and `icon-512.png` in `public/`. Use the simplified mark, not the full logo, for anything 32px or under.

### A6. Optional: the long explainer

A 60 to 90 second narrated walkthrough for the About page. Lower priority. If you make it, host it on Cloudflare Stream or Mux rather than self-hosting, and never autoplay it.

---

## PART 2: INFORMATION ARCHITECTURE

**Three pages at launch.** Bedrock has seven because it has seven audiences. You have one.

| Page | Purpose | Ship when |
|---|---|---|
| `/` | The landing page | Launch |
| `/about` | Who built this and why. "Built by a Penn State student" is a genuine credibility asset. | Launch |
| `/legal` | Privacy, terms, accessibility statement | Launch, required |
| `/changelog` | What shipped recently | Once there is something to log |
| `/pricing` | — | Only when you actually charge |

**Navigation: overlay menu.** Reads as legitimate at any page count and costs nothing. A `Menu` trigger in the top right opens a full-screen overlay with large type.

```
Home · About · Changelog · Legal          Open the planner →
```

Nav bar: sticky, `--surface`, `1px solid var(--border)` bottom, 56px, `z-index: 30` to match `.toolbar`. Left is the wordmark reusing the `h1::before` station-dot from `styles.css:152` so the page and the app are visibly one product. Right is the theme toggle and one primary CTA.

Overlay open: `transform: translateY(-100%)` to `0`, 320ms `--ease-out`, items staggered 40ms. Trap focus, close on Escape, restore focus to the trigger.

---

## PART 3: TEXTURE SYSTEM

Your identity is literally "map paper." **Paper and print texture is on-brand in a way photography is not.** All of this is CSS, no image files.

### T1. Paper grain

An SVG `feTurbulence` overlay, fixed, non-interactive, sitting above the background and below content.

```css
.grain::after {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1;
  opacity: .035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```
Opacity **0.035 in light, 0.05 in dark**. Above 0.06 it reads as a dirty screen rather than paper. Do not animate it.

### T2. Map grid

Reuse the existing dotted grid from `styles.css:175` as the hero background, unchanged. It already does this job.

### T3. Registration marks

Thin crop marks in `--border-strong` at section corners, 12px arms, 1px. Print-shop detail that signals craft. Use on at most three sections.

### T4. Halftone band

Section dividers as a row of `--primary` dots fading in scale from 4px to 1px across the width. Replaces a plain `<hr>`.

### T5. Off-register ink

On one hero element only, a 1px offset duplicate of the headline in `--route-b` at 8% opacity, behind the real text. Mimics misaligned print plates. Use once on the whole site or it becomes a gimmick.

**Banned:** gradients as decoration, glassmorphism, ambient glow, drop shadows larger than `--shadow-lg`, stock photography of any kind.

---

## PART 4: SCROLL ANIMATION SYSTEM

### Technique

**Native CSS scroll-driven animations are the default.** They run on the compositor thread, so they do not block the main thread or damage INP, which is the metric that now matters most. Supported in Chromium 115+ and Safari 26.

```css
@supports (animation-timeline: view()) {
  .reveal {
    animation: reveal linear both;
    animation-timeline: view();
    animation-range: entry 10% cover 30%;
  }
}
@keyframes reveal {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: none; }
}
```

**IntersectionObserver fallback** for older browsers: add a `.in` class at 15% visibility, once only, never re-trigger on scroll up.

**GSAP ScrollTrigger only if you need scrubbed timelines**, meaning animation tied continuously to scroll position rather than fired once. You likely do not. It is real weight for a benefit this page does not need.

**Lenis is optional.** Under 4KB, and it disables smoothing automatically under `prefers-reduced-motion`. If you pair it with GSAP, disable Lenis's `autoRaf` and drive both from GSAP's ticker or you get two animation loops and visible jitter.

### The hard rule

**Animate `transform` and `opacity` only.** Animating width, height, top, or box-shadow forces layout recalculation during interaction and is what actually wrecks INP. No exceptions.

### Choreography

| Element | Motion | Duration |
|---|---|---|
| Section enter | Fade + 16px rise | 280ms `--ease-out` |
| Staggered children | 60ms apart, max 5 before they feel slow | 240ms |
| Hero route lines | Existing `route-draw` keyframe | 1500ms |
| Hero station dots | Existing `stop-pop`, 140ms stagger | 340ms |
| Feature screenshot | Fade + scale 0.98 to 1 | 320ms |
| Number counters | Count up on first view, once | 900ms |
| Nav on scroll | Add `--shadow-sm` past 80px | 160ms |

Nothing over 500ms except the hero route draw. No parallax on images; it is the most common cause of jank and adds nothing here.

### Reduced motion

A full bypass, extending `styles.css:343` to the landing page: no reveals, no route draw, no counters, video replaced by its poster frame with a play button.

---

## PART 5: PAGE STRUCTURE

Nine blocks. Each earns its place.

### 5.1 Nav
Per Part 2.

### 5.2 Hero

Single column, centred, max 44rem for the text, then the video full width below at max 1100px.

- **Eyebrow:** `UNOFFICIAL · BUILT FOR PENN STATE STUDENTS`
- **Headline:** `Your degree is a route map. Now you can see it.` `clamp(30px, 5.5vw, 46px)`, weight 700 (not 800, see Part 8), `--track-tight`, line-height 1.05
- **Lede:** `LionsDegree reads Penn State's Bulletin, works out what unlocks what, and builds a four-year plan that actually holds. Drag a course and it tells you what breaks.` `--fs-md`, `--text-muted`, max 54ch
- **CTAs:** primary `Open the planner`, ghost secondary `Watch it work` which scrolls to 5.4
- **Trust line:** `--fs-xs` muted, `Free. No account needed to try it.`

**The video**, immediately below:

```html
<video autoplay muted loop playsinline preload="metadata"
       poster="/hero-poster.avif" aria-label="Dragging a course into a semester where its prerequisite is not met, the warning appearing, and the one-click fix resolving it">
  <source src="/hero.webm" type="video/webm">
  <source src="/hero.mp4" type="video/mp4">
</video>
```

Wrapped in `--surface`, `--r-lg`, `1.5px solid var(--border)`, `--shadow`, with the dotted map grid visible as a thin margin around it. Caption below in `.eyebrow`: `LIVE FROM THE PLANNER · REAL PENN STATE PREREQUISITES`.

`autoplay muted loop playsinline` is required for iOS. `preload="metadata"` not `auto`, so it does not fight LCP.

### 5.3 Proof strip

Directly below the hero CTA, because proof immediately beneath the CTA is the single highest-leverage placement available (+68% in the research), and more than half of SaaS pages omit it.

You have no logos and no testimonials yet, so use **data proof**, which is stronger for a tool anyway:

```
14,553 courses   ·   756 programs   ·   95% of prerequisites machine-verified
```

Numbers in `--fs-lg` weight 700, labels in `--fs-xs` muted. Count up on first view. Every number must be traceable to the catalog.

### 5.4 Watch it work

The anchor target for the secondary CTA. Either the three feature clips in sequence, or the long explainer if you make one. Full-bleed `--surface` band with `--border` top and bottom.

### 5.5 Feature sections — three, alternating

One idea per viewport, scroll-revealed, image and text alternating sides. Each is a feature clip or a still from A2/A3.

| Eyebrow | Headline | Body | Asset |
|---|---|---|---|
| `THE DATA IS REAL` | Straight from the Bulletin | Course descriptions verbatim, prerequisites parsed from Penn State's own text rather than hand-entered. If something can't be verified, it says so. | Course detail clip |
| `IT SOLVES THE ORDERING` | Fewest semesters, nothing out of sequence | The optimizer places your capstone correctly, balances credit load, and never schedules a course before its prerequisite. | Full flowchart still |
| `IT WORKS ON YOUR PHONE` | Built for registration week | List view when you're on a phone at 7am fighting for a seat. | Mobile still |

### 5.6 Discovery — the wedge

Most visual weight after the hero. `--surface` full-bleed band.

- **Eyebrow:** `THE PART NOBODY ELSE DOES`
- **Headline** `--fs-xl`: `Describe what you're into. Get a combination of real credentials.`
- Discovery clip from A2
- The worked example diagram, using `--route-b` for the branch lines since this is literally routes converging:

```
"I like machine learning and clean energy"
   ├─ Engineering Science, B.S.     major
   ├─ Artificial Intelligence       minor
   └─ Energy Engineering            certificate
   14 credits double-count · 1 extra semester
```
- **CTA:** `Open the planner`. ~~`Try one free run` → signup. Caption: `One run free. No card.`~~
  **Struck 2026-10-15: the project is open source and there is no paid tier.**

> **Not built.** This section ships as a visible placeholder until
> `okayojas/lionsdegree#22` lands. Do not write copy implying it works.

### 5.7 Try it yourself — the live demo

> **Not built.** Ships as a placeholder; the interactive canvas and the
> one-click fix it depends on are `okayojas/lionsdegree#21`.

Now, not in the hero. The interactive canvas with six to eight real courses, drag between columns, non-blocking warning with one-click fix, click for the verbatim description, hover for focus-plus-context.

Unauthenticated and free, because it is deterministic and costs nothing. The discovery run stays gated.

**Mobile:** replace with the list view and a `Open the full planner` CTA. Do not ship a drag canvas as a mobile interaction.

**Every drag needs a tap alternative** (WCAG 2.2 SC 2.5.7). A `Move to semester` menu on each card. Keyboard support alone does not satisfy this.

### 5.8 What this isn't

Counterintuitive but it raises conversion for a tool people trust with graduation decisions, and it is on-brand for an engine that refuses to guess.

- Not affiliated with or endorsed by Penn State.
- Not a substitute for your adviser. Confirm before you register.
- Course descriptions are verbatim from the University Bulletin.
- **If a requirement can't be verified, it says so instead of guessing.** ← `--text`, not muted. This is the actual differentiator.

### 5.9 Final CTA + footer

Repeat the primary CTA once. Footer in `--surface` with the wordmark, the disclaimer from `styles.css:136`, links to `bulletins.psu.edu`, `/legal`, `/.well-known/security.txt`, and a contact mailto. Bottom line `--fs-xs` muted: `Built by a Penn State student.`

---

## PART 6: RESPONSIVE

| Breakpoint | Behaviour |
|---|---|
| < 768px | Video stays (it is the mobile-safe hero). Live demo becomes list view. Features stack, image above text. Overlay menu full screen. All targets ≥44px. |
| 768–1023 | Features stack but wider. Video full width. |
| ≥ 1024 | Features alternate sides. Demo at full size. |
| ≥ 1440 | Cap content at 1200px, centred. Video caps at 1100px. |

Design the mobile hero first. Most shared links open on a phone.

---

## PART 7: ACCESSIBILITY

- Skip link, reusing `.skip-link`.
- One `h1`. Sections use `h2`. No skipped levels.
- Video: `aria-label` describing what happens, and **a visible pause control**, because WCAG 2.2.2 requires a mechanism to stop anything that auto-plays for more than five seconds.
- `prefers-reduced-motion`: poster frame plus play button instead of autoplay.
- Every drag in the demo has a tap alternative.
- Focus visible everywhere via the existing `:focus-visible` rule.
- No status by colour alone; the amber warning needs icon and text.
- **Verify `--text-muted` on `--bg` passes 4.5:1 in both themes.** `#6b6353` on `#f1ebdf` and `#b0a89a` on `#2b2a27` are both plausible but must be measured.
- Test at 200% zoom and keyboard-only.

---

## PART 8: CODE FIXES REQUIRED FIRST

Carried from the previous spec, still outstanding.

**F1.** JetBrains Mono is not self-hosted. `package.json` only has `space-grotesk`. Course codes fall back to system monospace, so the one typographic choice carrying meaning renders differently on every OS. Add `@fontsource-variable/jetbrains-mono` and import it in `main.tsx`.

**F2.** `index.html` is a title tag and nothing else. Needs description, Open Graph and Twitter tags, `theme-color` for both schemes (`#f1ebdf` / `#2b2a27`), favicon links, apple-touch-icon, and canonical.

**F3.** `font-weight: 800` appears in four places but **Space Grotesk's variable axis tops out at 700**, so the browser already clamps it. Change those to 700 so intent matches output.

**F4.** `prefers-reduced-motion` guard must extend to the landing page.

---

## PART 9: BUILD ORDER

1. **F1–F4.** Small, unblocks everything.
2. **Record A1.** The hero loop. Everything else is layout around it.
3. **Static shell.** Vite multi-page entry, nav, all nine blocks, footer, existing tokens only. Verify both themes.
4. **Hero video** wired with poster, fallbacks, pause control.
5. **Texture layer.** T1 and T2 first; T3–T5 only if they earn it.
6. **Scroll reveals.** CSS scroll-driven with IntersectionObserver fallback.
7. **Remaining assets.** A2, A3, A4, A5.
8. **Live demo section**, list view first, then canvas, then tap-to-move.
9. **About and Legal pages.**
10. **Audit.** Lighthouse, axe, keyboard-only, 200% zoom, both themes, 375/768/1024/1440.

---

## PART 10: ACCEPTANCE CRITERIA

**Identity**
- [ ] No new CSS custom properties; everything resolves to existing tokens
- [ ] No third font family; mono only on course codes
- [ ] `--route-b` only in the hero and the discovery diagram
- [ ] No gradients, glassmorphism, ambient glow, or stock photography
- [ ] Grain opacity ≤0.035 light, ≤0.05 dark

**Assets**
- [ ] Hero loop under 1.5MB WebM, seamless at the join
- [ ] Poster frame is the exact first video frame, no flash on load
- [ ] All screenshots 2x, AVIF with WebP fallback
- [ ] OG image renders correctly in iMessage, Discord, and Slack
- [ ] No personal data in any asset

**Performance**
- [ ] LCP under 2.5s on a throttled 4G mobile profile
- [ ] INP under 200ms
- [ ] CLS under 0.1; video and images have explicit dimensions
- [ ] Only `transform` and `opacity` animated anywhere

**Accessibility**
- [ ] Video has a visible pause control (WCAG 2.2.2)
- [ ] Every drag has a tap alternative (SC 2.5.7)
- [ ] Full keyboard path through the page and the demo
- [ ] 4.5:1 body text, 3:1 borders and route lines, both themes
- [ ] `prefers-reduced-motion` disables autoplay and all reveals

**Content**
- [ ] Every number on the page is real and traceable to the catalog
- [ ] Banned words absent: supercharge, revolutionize, seamless, effortless, unlock your potential, empower, journey, game-changing
- [ ] Unofficial disclaimer visible without scrolling on mobile
- [ ] Proof strip sits directly below the hero CTA
