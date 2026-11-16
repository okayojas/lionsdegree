# 5. The landing page's first-paint budget counts the document and the stylesheet

Date: 2026-11-16

## Status

Accepted (#64). Builds on ADR 0002, and changes what one of its two numbers measures.

## Context

ADR 0002 fixed what the landing page's script budget measures (every script a visitor downloads,
lazy chunks included) and how a ceiling is set (the measured figure plus about a fifth, with the
figure in the commit). Under it the page had two ceilings, both of script: what runs before the
page is interactive, and everything reachable.

The landing page that replaced that one in #64 runs 0.54 KB of script. A ceiling on that number
protects nothing: the page could triple the stylesheet that blocks its first paint, or put the
whole catalog in its markup, and both script ceilings would pass. The ticket asked for the
page's first-paint weight to be held, and script alone is no longer most of it. It is under 3
percent of it.

## Decision

**The landing page's first-paint ceiling counts what the browser must have before it can draw
the page: the document, every stylesheet it links, and the static script graph, gzipped.**
Measured at 20.2 KB when this was written (document 4.7, stylesheet 15.0, script 0.54); ceiling
24.

The second ceiling held every script the page can load, lazy chunks included, and was 0.65 KB
when this was written because there were none.

**Since #65 (same day) there are three numbers**, each the measurement plus about a fifth:

| What | Measured | Ceiling |
| --- | --- | --- |
| First paint: document, stylesheet, static script | 23.2 KB | 28 |
| The page's own script, which loads with it | 3.1 KB | 3.7 |
| The scene: three.js and the simulation, one lazy chunk | 134.8 KB | 162 |

The first paint grew by 3 KB with the scene: the script that decides whether a browser gets
one, and the layout rules for when it does. The scene itself is asked for after the page has
painted and is not in the first number, which is what having three numbers is for.

Fonts and images are not in the first-paint figure. Fonts are swapped in when they land and the
text is readable before they do; the page's one image is the header's mark, which has its own
limit in the same test file.

## Consequences

- The number went from 3 KB to 24 KB without the page getting heavier. It is a different
  measurement, not a raised budget, which is why it is recorded here and not passed off as a
  re-measure.
- A stylesheet change can now fail the landing page's budget. That is the point.
- The other pages outside the planner are not held to a first-paint figure. They share most of
  the stylesheet, so this ceiling catches the common case; if one grows a heavy document of its
  own (the Sample plans list, #67), it should get the same measure.
