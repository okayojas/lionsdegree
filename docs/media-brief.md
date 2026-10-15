# Landing page media — brief

**Ojas owns these.** Everything in this folder today is a placeholder I
generated with `scripts/product-shots.mjs`: functional, correctly sized, and
not good enough to launch with. Replace them.

**Drop a file in at the same path and filename and it just works.** Nothing
imports these by anything but their URL, so there is no code change and no
build step to remember. The only thing the build enforces is weight (below).

Derived from `Landing-Page-UI-Spec.md` Part 1. Where this disagrees with the
spec, this is the newer document — the spec was written before the page
existed and lists assets the page no longer uses.

---

## What the page actually consumes

| File | Rendered at | Current | Budget | Where |
|---|---|---|---|---|
| `shots/flowchart.png` | 1100 × 440 | 66 KB | ≤ 140 KB | Hero, and again in feature 2 |
| `shots/audit.png` | 620 × 700 | 59 KB | ≤ 140 KB | "Watch it work" |
| `shots/mobile.png` | 390 × 760 | 44 KB | ≤ 140 KB | "Built for registration week" |
| `../mark.png` | 36 px tall | 34 KB | ≤ 140 KB | Nav, every page |
| `../og.png` | 1200 × 630 | 39 KB | — | Link previews |

**Total across the landing page must stay under 260 KB.** `test/build-output.test.ts`
fails the build if it doesn't — it counts distinct files, so the hero shot
appearing twice costs one download, not two.

Ship at **2× the rendered size** and let the browser downscale; it is visibly
sharper than shipping at 1×. A 64-colour palette PNG holds UI screenshots
crisply at a fraction of the size — JPEG smears the type. `scripts/product-shots.mjs`
has the exact quantise call if you want it.

---

## Recording rules

Carried from the spec, and all of them matter:

- **2560 × 1440**, delivered downscaled.
- **Clean browser.** No bookmarks bar, no extensions, no notifications, no
  other tabs. Fresh profile if that is easier.
- **No browser chrome in the frame.** Crop it out or capture the viewport
  only. If you want a frame, draw one in brand tokens rather than
  photographing Chrome.
- **Light theme**, except the one dark-mode shot. Cream is the brand.
- **Real courses.** `CMPSC 465`, `A-I 341W`, `ESC 410H`, `EE 456`, `PHYS 214`.
  Real codes are what make the page read as authored rather than generated.
- **No personal data.** No name, no email, no student ID, no account menu
  open. Check the corner of every frame before you ship it.
- Cursor visible, moved slowly, ~300 ms pause before each click. No highlight
  ring or click-burst — those read as a tutorial screencast, not a product.

---

## Still to shoot

**`shots/flowchart.png`** — the current one is a crop of a zoomed canvas and
it reads as arbitrary. It wants to be a deliberate composition: three or four
term columns, roughly eight cards, at least two prerequisite lines clearly
running between them, and one open slot visible so the "click to fill"
affordance is on screen.

**`shots/audit.png`** — fine in content, but shot at a scale where the body
text is small. Zoom in so a requirement row and its courses are comfortably
legible.

**`shots/mobile.png`** — the list view at 390 px. Should show term headings
and at least one course whose prerequisite status is written out in words,
since that is the claim the section makes.

**`og.png`** — 1200 × 630. Needs the wordmark with its station dot, one short
line of copy, and a tight crop of the flowchart with real course codes
visible. Test it by pasting the URL into iMessage, Discord and Slack; all
three crop and compress it differently.

---

## The hero video — first pass captured

`scripts/hero-capture.mjs` records it headlessly against a running preview:

```
node scripts/hero-capture.mjs
```

It drives the real planner — drag a course into a term its prerequisite does
not allow, the warning appears, click the fix, the card moves — with a drawn
cursor, because Playwright's synthetic mouse moves no real pointer and without
one the cards appear to move by themselves. Current output: **411 KB, 8.5 s,
1280x720**, which is inside the spec's budget and duration.

It is a FIRST PASS, and three things are still missing:

- **Not a seamless loop.** The first and last frames differ, so it will jump.
  The spec's method is to record twice as long, perform the action twice, and
  cut a cycle whose ends match.
- **No `hero.mp4`.** Playwright bundles a WebM-only ffmpeg with no MP4 muxer,
  so the Safari and iOS fallback cannot be produced here. With a real ffmpeg
  on PATH it is one command (below). Until then a `<video>` carrying only the
  WebM is a black box on an iPhone, which is most of the audience for a link
  shared in a group chat.
- **25 fps, not 60.** Playwright's recorder is fixed at 25; drag footage wants
  60, and at 25 the drag reads slightly steppy.

Judge the pacing before anything else — a headless capture gets the sequence
right and has no feel for timing.

## Encoding reference

The spec's A1 is an 8–12 second silent loop: drag a course into a term where
its prerequisite is not satisfied, the amber warning appears, **click the
one-click fix**, the card moves and the dot turns green.

That last beat does not exist yet — it is `okayojas/lionsdegree#21`. The first
two thirds are recordable today, but a loop that shows a problem and never
resolves it sells the opposite of what the engine does. So the hero stays a
still until #21 lands.

When it does, the specs are: seamless loop (record 20 s, perform the action
twice, cut a cycle whose first and last frames match), silent, `hero.webm`
VP9 under 1.5 MB plus `hero.mp4` H.264 baseline for Safari, and
`hero-poster.avif` as the exact first frame.

```
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libvpx-vp9 -crf 32 -b:v 0 -an hero.webm
ffmpeg -i raw.mov -vf "scale=1440:-2" -c:v libx264 -crf 24 -profile:v baseline -movflags +faststart -an hero.mp4
```

It also needs a visible pause control to ship: WCAG 2.2.2 requires a way to
stop anything that autoplays for more than five seconds.
