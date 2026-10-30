/** The 3D prerequisite journey (docs/landing-3d-journey.md).
 *
 * A scroll-driven camera travelling a real chain of thirteen Penn State
 * courses and arriving at a real scheduling conflict the engine caught. This
 * module is NEVER in the landing page's initial payload — `reveal.ts` reaches
 * it through a dynamic `import()`, and only once the container is on screen.
 * ADR 0002 covers why the script budget moved to allow that, and why the
 * budget test had to learn to follow import edges before the number did.
 *
 * `mount()` returns a `dispose()` that must release every geometry, material,
 * renderer, listener and animation frame. A WebGL context is not garbage in
 * the ordinary sense; leaking one leaks GPU memory for the life of the tab.
 *
 * COLOURS ARE READ FROM CSS CUSTOM PROPERTIES at mount time, never hardcoded.
 * The palette moved from violet to petrol once already, and a hex buried in a
 * shader is the one place a rename does not reach.
 */
import * as THREE from "three";
import { JOURNEY_NODES, JOURNEY_EDGES, JOURNEY_NOTES, type JourneyNode } from "./journey-data.js";
import { mountDialog } from "./journey-dialog.js";

/** Nodes within this many world units of the camera are "near": emphasised,
 * labelled, and focusable. Everything else fades back into the fog. */
const NEAR_RANGE = 60;
/** Below this viewport width, thirteen projected labels is an unreadable
 * pile, so only the closest few are drawn. A legibility limit, not a
 * performance one — the scene is about thirty draw calls either way. */
const PHONE_WIDTH = 760;
const PHONE_LABEL_CAP = 3;

export interface JourneyHandle {
  dispose(): void;
}

/** Read a CSS custom property as a Three.js colour.
 *
 * `getComputedStyle` resolves whatever the cascade actually produced, so this
 * follows the theme without knowing anything about it. */
function token(styles: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) return fallback;
  try {
    return new THREE.Color(raw).getHex();
  } catch {
    // A token that is not a colour is a bug, but not one worth taking the
    // page down for — the scene is decoration over a complete document.
    return fallback;
  }
}

export function mount(container: HTMLElement): JourneyHandle {
  // The scroller sets the travel distance; the stage is what gets pinned.
  const scroller = (container.closest(".journey-scroll") ?? container) as HTMLElement;
  const stage = (container.closest(".journey-stage") ?? container) as HTMLElement;
  const scenes = [...document.querySelectorAll<HTMLElement>("#scenes .scene")];

  const styles = getComputedStyle(document.documentElement);
  const BG = token(styles, "--bg", 0x2b2a27);
  const PETROL = token(styles, "--primary", 0x8dc1d8);
  const AMBER = token(styles, "--warning", 0xd3ab6b);
  const MUTED = token(styles, "--border-strong", 0x5e584e);
  const INK = token(styles, "--text", 0xece6da);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Renderer ──────────────────────────────────────────────────────────
  // TRANSPARENT, not matching. An opaque clear colour made the scene a flat
  // rectangle sitting on a page that carries dot grids and a vignette over
  // the same hue -- identical colour, visibly different surface, and a seam
  // where one began. Matching the two would have worked until either side
  // moved; compositing over the page means they cannot disagree.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearAlpha(0);
  const canvas = renderer.domElement;
  // The canvas carries no information a screen reader needs; the labels do.
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "journey-canvas";
  container.insertBefore(canvas, container.firstChild);

  const scene = new THREE.Scene();
  // Fog still resolves to BG even though nothing clears to it: distant
  // geometry has to fade into the colour the PAGE is painting behind the
  // canvas, and that colour is --bg either way.
  scene.fog = new THREE.Fog(BG, 70, 250);
  const cam = new THREE.PerspectiveCamera(52, 1, 0.1, 900);

  // Everything disposable, collected as it is made. A scene graph walk at
  // teardown misses anything already detached; a list cannot.
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => (geometries.push(g), g);
  const paint = <T extends THREE.Material>(m: T): T => (materials.push(m), m);

  // ── Course nodes, as rings — the same language as the route's station dot
  const ringGeo = track(new THREE.TorusGeometry(2.2, 0.42, 10, 42));
  const coreGeo = track(new THREE.SphereGeometry(0.85, 14, 12));
  const haloGeo = track(new THREE.TorusGeometry(3.1, 0.1, 8, 42));
  const coreMat = paint(new THREE.MeshBasicMaterial({ color: BG }));

  interface NodeView {
    group: THREE.Group;
    halo: THREE.Mesh;
    node: JourneyNode;
  }

  const views: NodeView[] = JOURNEY_NODES.map((node) => {
    const colour = node.conflict ? AMBER : node.main ? PETROL : MUTED;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(ringGeo, paint(new THREE.MeshBasicMaterial({ color: colour })));
    const core = new THREE.Mesh(coreGeo, coreMat);
    const halo = new THREE.Mesh(
      haloGeo,
      paint(new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.3 })),
    );
    group.add(ring, core, halo);
    group.position.set(...node.pos);
    scene.add(group);
    return { group, halo, node };
  });

  // ── Edges ─────────────────────────────────────────────────────────────
  const edgeMat = paint(new THREE.LineBasicMaterial({ color: MUTED, transparent: true, opacity: 0.55 }));
  const mainMat = paint(new THREE.LineBasicMaterial({ color: PETROL, transparent: true, opacity: 0.85 }));
  for (const { from, to } of JOURNEY_EDGES) {
    const spine = JOURNEY_NODES[from].main && JOURNEY_NODES[to].main;
    const geo = track(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...JOURNEY_NODES[from].pos),
        new THREE.Vector3(...JOURNEY_NODES[to].pos),
      ]),
    );
    scene.add(new THREE.Line(geo, spine ? mainMat : edgeMat));
  }

  // ── The camera path, through the spine only ───────────────────────────
  const spinePoints = JOURNEY_NODES.filter((n) => n.main).map((n) => new THREE.Vector3(...n.pos));
  const curve = new THREE.CatmullRomCurve3(spinePoints, false, "catmullrom", 0.4);

  // A travelling marker riding ahead of the camera, so the journey has a
  // subject and not just a viewpoint.
  const marker = new THREE.Group();
  marker.add(
    new THREE.Mesh(track(new THREE.TorusGeometry(1.5, 0.3, 10, 36)), paint(new THREE.MeshBasicMaterial({ color: PETROL }))),
    new THREE.Mesh(
      track(new THREE.TorusGeometry(2.3, 0.09, 8, 36)),
      paint(new THREE.MeshBasicMaterial({ color: PETROL, transparent: true, opacity: 0.45 })),
    ),
  );
  scene.add(marker);

  // ── Dust, purely for depth cues ───────────────────────────────────────
  const dustGeo = track(new THREE.BufferGeometry());
  const dust = new Float32Array(900);
  for (let i = 0; i < 300; i++) {
    dust[i * 3] = (Math.random() - 0.5) * 190;
    dust[i * 3 + 1] = (Math.random() - 0.5) * 110;
    dust[i * 3 + 2] = -Math.random() * 250 + 20;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
  scene.add(
    new THREE.Points(dustGeo, paint(new THREE.PointsMaterial({ color: INK, size: 0.32, transparent: true, opacity: 0.34 }))),
  );

  // ── Labels: real DOM, projected each frame ────────────────────────────
  const labelLayer = document.createElement("div");
  labelLayer.className = "journey-labels";
  container.appendChild(labelLayer);

  const dialog = mountDialog();
  const annotated = new Set(JOURNEY_NOTES.map((n) => n.code));

  const labels = JOURNEY_NODES.map((node) => {
    const wrap = document.createElement("div");
    wrap.className = "journey-label" + (node.conflict ? " is-conflict" : "");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.code = node.code;
    button.innerHTML = `${node.code}<span>${node.title}</span>`;
    const hasNote = annotated.has(node.code);
    // Nine of the thirteen stops have no field note. Announcing them as
    // readable and then doing nothing on click is worse than labelling them
    // for what they are: a course on the route.
    button.setAttribute(
      "aria-label",
      hasNote
        ? `Read the field notes for ${node.code}, ${node.title}`
        : `${node.code}, ${node.title}`,
    );
    if (hasNote) {
      button.classList.add("has-note");
      button.addEventListener("click", () => dialog.open(node.code, button));
    } else {
      button.disabled = true;
    }
    button.tabIndex = -1;
    wrap.appendChild(button);
    labelLayer.appendChild(wrap);
    return { wrap, button, hasNote };
  });

  // ── Sizing ────────────────────────────────────────────────────────────
  let width = 0;
  let height = 0;
  function resize(): void {
    const rect = container.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }

  // ── Scroll, read once ─────────────────────────────────────────────────
  // The page has no other scroll listener: reveals run on CSS scroll-driven
  // animation with an IntersectionObserver fallback, neither of which exposes
  // a progress value. This is the page's only one.
  //
  // Progress is the CONTAINER's travel through the viewport, not the
  // document's. The proof-of-concept used document scroll because its canvas
  // was the whole screen; in a module that is wrong in a way that looks like
  // a rendering bug — the module appears about a third of the way down the
  // page, so the camera began a third of the way along the chain, parked
  // inside a node with nothing legible on screen.
  //
  // The band is deliberately tighter than "enters the bottom, leaves the
  // top": over the full window the chain's last stop — EE 456 and the
  // terminus it blocks, which is the entire point of the scene — only
  // arrives once the module has scrolled off the screen. 0 when the module's
  // top reaches 85% of the viewport, 1 when its bottom passes 15%, so the
  // whole journey happens while the reader is looking at it.
  let target = 0;
  let shown = 0;
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  function readScroll(): void {
    // Progress through the SCROLLER, not the stage. The stage is sticky, so
    // its own box barely moves — reading it would report a journey that
    // never starts. The scroller is the tall element whose height defines
    // how far the reader travels.
    const rect = scroller.getBoundingClientRect();
    const span = rect.height - innerHeight;
    target = span > 0 ? clamp(-rect.top / span, 0, 1) : 0;
  }

  // ── The loop, which must not run when nobody can see it ───────────────
  let frame = 0;
  let last = performance.now();
  let onScreen = true;
  const scratch = new THREE.Vector3();
  const phone = () => innerWidth < PHONE_WIDTH;

  function tick(now: number): void {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(64, now - last);
    last = now;
    // Reduced motion still draws the scene — it just stops easing toward the
    // scroll position, so the picture is correct and nothing drifts.
    shown = reduced ? target : shown + (target - shown) * (1 - Math.pow(1 - 0.11, dt / 16.667));

    const t = clamp(shown * 0.97, 0, 0.999);
    curve.getPointAt(t, scratch);
    // A phone sits closer in, so fewer nodes crowd the frame at once.
    const back = phone() ? 26 : 34;
    cam.position.set(scratch.x + Math.sin(t * 7) * 4, scratch.y + 13, scratch.z + back);
    curve.getPointAt(clamp(t + 0.055, 0, 1), scratch);
    cam.lookAt(scratch);
    marker.position.copy(scratch);
    if (!reduced) {
      marker.rotation.z += 0.012;
      marker.rotation.x = Math.sin(now * 0.0007) * 0.3;
    }

    // Emphasis and labels by proximity.
    const ranked: { index: number; near: number }[] = [];
    views.forEach((view, i) => {
      const distance = view.group.position.distanceTo(cam.position);
      const near = clamp(1 - (distance - 18) / NEAR_RANGE, 0, 1);
      (view.halo.material as THREE.MeshBasicMaterial).opacity = 0.12 + near * 0.5;
      view.group.scale.setScalar(0.85 + near * 0.3);
      ranked.push({ index: i, near });
    });

    // On a phone, only the closest few labels are allowed on screen at all.
    let allowed: Set<number> | null = null;
    if (phone()) {
      allowed = new Set(
        [...ranked].sort((a, b) => b.near - a.near).slice(0, PHONE_LABEL_CAP).map((r) => r.index),
      );
    }

    for (const { index, near } of ranked) {
      const { wrap, button, hasNote } = labels[index];
      const projected = views[index].group.position.clone().project(cam);
      // BOUNDS, not just depth. `project()` happily returns coordinates for a
      // node beside or behind the frustum, and without this a label for a
      // course the camera has already passed is drawn outside the module
      // entirely — floating on the page canvas next to it.
      const inFrame =
        projected.z < 1 && projected.x > -0.95 && projected.x < 0.95 && projected.y > -0.9 && projected.y < 0.9;
      const visible = inFrame && near > 0.04 && (!allowed || allowed.has(index));
      if (visible) {
        wrap.style.opacity = String(clamp(near * 1.5, 0, 1));
        wrap.style.visibility = "visible";
        wrap.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
        wrap.style.top = `${(-projected.y * 0.5 + 0.5) * height - 34}px`;
        // A control nobody can read must not be a tab stop — and neither
        // must one that does nothing when activated.
        button.tabIndex = hasNote && near > 0.4 ? 0 : -1;
      } else {
        wrap.style.opacity = "0";
        wrap.style.visibility = "hidden";
        button.tabIndex = -1;
      }
    }

    // ── Scenes ──────────────────────────────────────────────────────
    // Each scene owns an equal slice of the journey. Exactly one is on at
    // a time: cross-fading two would put two headlines over the same frame
    // and read as a rendering fault rather than a transition.
    if (scenes.length) {
      const slice = 1 / scenes.length;
      const active = Math.min(scenes.length - 1, Math.floor(shown / slice));
      for (let i = 0; i < scenes.length; i++) scenes[i].classList.toggle("is-on", i === active);
    }

    renderer.render(scene, cam);
  }

  function start(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
  function stop(): void {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  // A continuous rAF loop on a phone is a real battery cost, so it runs only
  // while the scene is both on screen and in a visible tab.
  const visibility = () => (document.hidden || !onScreen ? stop() : start());
  const seen = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      visibility();
    },
    { threshold: 0 },
  );
  seen.observe(container);

  addEventListener("scroll", readScroll, { passive: true });
  addEventListener("resize", resize);
  addEventListener("resize", readScroll);
  document.addEventListener("visibilitychange", visibility);

  // Pin the stage and give the scroller its travel distance only once the
  // scene is actually mounted. Doing it in CSS would pin an empty box on
  // every browser that never loads the 3D, and a reader with WebGL off
  // would scroll several screens of nothing.
  stage.classList.add("is-pinned");
  scroller.style.height = `${Math.max(2, scenes.length) * 100}vh`;
  container.classList.add("is-live");

  resize();
  readScroll();
  shown = target;
  start();

  // Losing the context is not an error the reader should hear about; the
  // static module behind this is a complete page on its own.
  const lost = (e: Event) => {
    e.preventDefault();
    stop();
  };
  canvas.addEventListener("webglcontextlost", lost);

  return {
    dispose(): void {
      stop();
      seen.disconnect();
      removeEventListener("scroll", readScroll);
      removeEventListener("resize", resize);
      removeEventListener("resize", readScroll);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      stage.classList.remove("is-pinned");
      scroller.style.height = "";
      container.classList.remove("is-live");
      for (const sc of scenes) sc.classList.remove("is-on");
      dialog.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      renderer.dispose();
      canvas.remove();
      labelLayer.remove();
    },
  };
}
