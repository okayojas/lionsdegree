/** Cut the paper out from behind the pictorial mark.
 *
 * `public/mark.png` is the mark drawn on the app's own cream (`--bg`). That is
 * the right file for anything that needs a rectangle: a link-preview card, a
 * home-screen icon. In a page header it is the wrong one, because the moment
 * the header sits on anything that is not exactly that cream -- a tinted band,
 * a scene passing underneath -- the rectangle shows.
 *
 *   node scripts/make-mark.mjs
 *
 * Writes `public/mark-clear.png`, which is committed: nothing regenerates it
 * at build time, and it only changes when the mark does.
 *
 * THE LION GOES WITH THE PAPER, AND THAT IS THE DRAWING, NOT A SHORTCUT. It
 * is tempting to keep the lion cream and remove only "the background". There
 * is no such line to cut along: the lion is negative space. Its back runs
 * straight into the gap between the L and the D with no ink between them
 * (measured: a flood fill from the picture's edge reaches its face), so it is
 * the page showing through the letters, exactly as it is on cream. Keeping
 * part of it opaque would mean inventing an outline the mark does not have.
 * So every paper-coloured pixel is paper, wherever it is.
 *
 * AND THE EDGE IS UNMIXED, NOT JUST FADED. Where ink meets paper the source
 * has antialiased pixels that are part ink, part cream. Making those merely
 * semi-transparent keeps the cream in them, and on a dark or tinted
 * background that reads as a pale halo round the whole mark. Each edge pixel
 * is instead given the colour of the ink beside it, with an alpha equal to
 * how much of it was ink.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(web, "public", "mark.png");
const OUT = path.join(web, "public", "mark-clear.png");

/** A pixel this close to the paper colour is paper. Measured, not guessed:
 * the source is a 24-colour image whose creams all sit within 16 of the
 * paper (the furthest is a paler cream left in a thin ring beside the ink),
 * and its next colour, the sage of the route, is 95 away. Anything in the
 * gap between those would do. */
const PAPER_TOLERANCE = 20;
/** How far to look for the ink an edge pixel was mixed with. */
const INK_REACH = 2;
/** The least a colour can differ from the paper and still be called ink. The
 * palest ink in the mark, the sage of the route, is about 90 away. */
const MIN_INK = 40;
/** Height of the file written, in pixels. `siteHeader()` states the
 * resulting size in its <img>, and site-surface.test.ts holds the two together. */
const OUT_HEIGHT = 144;

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
const at = (x, y) => (y * w + x) * 3;
const paper = [data[0], data[1], data[2]];
const fromPaper = (i) => Math.hypot(data[i] - paper[0], data[i + 1] - paper[1], data[i + 2] - paper[2]);

// 1. Paper is a colour, not a region (see above).
const isPaper = new Uint8Array(w * h);
for (let p = 0; p < w * h; p++) isPaper[p] = fromPaper(p * 3) <= PAPER_TOLERANCE ? 1 : 0;

// 2. Write it out, unmixing the ring of pixels that touch the paper.
const out = Buffer.alloc(w * h * 4);
let cut = 0, edged = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 3, o = p * 4;
    if (isPaper[p]) { cut++; continue; } // left at 0,0,0,0

    let touchesPaper = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || isPaper[ny * w + nx]) touchesPaper = true;
    }
    if (!touchesPaper) {
      out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = 255;
      continue;
    }

    // The ink this pixel was blended with: the nearby pixel furthest from
    // paper. Its distance is what "fully ink" means here, so this pixel's own
    // distance over that is the share of it that was ink.
    let ink = i, inkDist = fromPaper(i);
    for (let dy = -INK_REACH; dy <= INK_REACH; dy++) {
      for (let dx = -INK_REACH; dx <= INK_REACH; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || isPaper[ny * w + nx]) continue;
        const d = fromPaper(at(nx, ny));
        if (d > inkDist) { inkDist = d; ink = at(nx, ny); }
      }
    }
    // No ink within reach: a speck barely off the paper colour with nothing
    // darker beside it. It is paper that missed the tolerance, and keeping
    // it would leave a faint cream dot floating in the cut-out.
    if (inkDist < MIN_INK) { cut++; continue; }
    const share = Math.min(1, fromPaper(i) / inkDist);
    out[o] = data[ink]; out[o + 1] = data[ink + 1]; out[o + 2] = data[ink + 2];
    out[o + 3] = Math.round(share * 255);
    edged++;
  }
}

// 3. Down to the size a header needs. The source is 327px tall and the mark
// is shown at 36: four times that covers a 3x phone with room to spare, at a
// quarter of the bytes. sharp premultiplies before it resamples, so the
// transparent pixels (stored as black) do not darken the new edge.
const made = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
  .resize({ height: OUT_HEIGHT, kernel: "lanczos3" })
  .png({ compressionLevel: 9, palette: false })
  .toFile(OUT);

const pct = (n) => `${((n / (w * h)) * 100).toFixed(1)}%`;
console.log(
  `mark-clear.png ${made.width}x${made.height}, ${(made.size / 1024).toFixed(1)} KB: ` +
    `${pct(cut)} paper cut out, ${edged} edge pixels unmixed`,
);
