/** The gravity scene (#60, #65): the sample Plan as a field of spheres.
 *
 * One fixed canvas behind the landing page, driven by how far down the page
 * the reader is. A scrambled cluster; then it falls into a pile; then the
 * floor opens, everything falls out and comes back in from the top, and the
 * Courses that are in the Plan are caught, each above its own cell, while
 * the rest fall away; then the rectangle lifts off and goes past the camera.
 *
 * AN ENHANCEMENT. The page is complete without this file (index.html), and
 * this file is never on the path to its first paint: it and three.js arrive
 * as one lazy chunk, asked for by src/gravity.ts once the page has painted
 * and only where a scene can run. Nothing here is the only copy of anything
 * a reader needs: the Plan it draws is in the document as a list.
 *
 * PORTED FROM THE OWNER'S PROTOTYPE (a standalone page, since removed), and the
 * materials, lights, physics constants, entrance and label treatment are
 * that prototype's, unchanged: they are the design. What differs:
 *   - Scroll is the only input. The prototype once pushed the spheres away
 *     from the pointer; the owner took that out.
 *   - A fixed time step. The prototype advanced once per frame, so the same
 *     scene ran twice as fast on a 120 Hz screen. Here it advances sixty
 *     times a second whatever the screen does.
 *   - The arithmetic that is not rendering (the stages, the grid) is in
 *     field-math.ts, where it can be tested without a canvas.
 */
import * as THREE from "three";
import { COURSES_PER_TERM, SAMPLE_PLAN, TERM_COUNT } from "./sample-plan.js";
import { clamp01, easeOutCubic, lerp, planGrid, smoothstep, stageAt, type Band, type PlanGrid } from "./field-math.js";

/** What the scene needs from the page it is laid over. */
export interface SceneHost {
  /** How far down the page the reader is, as field-math's `progressAt`. */
  progress(): number;
  /** The space the plan section's own text leaves free. */
  band(): Band;
  /** The browser has taken the WebGL context away (a GPU reset, a tab left
   * in the background too long) and the canvas is blank. The scene cannot
   * be drawn any more; the page should stop relying on it. */
  lost(): void;
}

/** One sphere, as the scene will report it. World units, origin at the
 * centre of the screen, y up. */
export interface CourseReport {
  code: string;
  /** In the sample Plan, as opposed to one of the Courses that fall away. */
  inPlan: boolean;
  /** Its Term and its place within the Term. Null for a Course that is not
   * in the Plan: it has neither. */
  term: number | null;
  lane: number | null;
  x: number;
  y: number;
  z: number;
  /** Its radius as drawn. */
  size: number;
  /** Drawn at all: not fallen away, and not faded out past the camera. */
  showing: boolean;
  /** For a Plan Course, the centre of its cell. */
  home: { x: number; y: number } | null;
}

/** The scene, as numbers. For looking at it from outside: a test, a console.
 * Screenshots compared by eye are not a test; this is what one reads. */
export interface SceneReport {
  /** Simulation steps taken, at sixty to the second. */
  steps: number;
  progress: number;
  /** The screen, in world units. */
  view: { width: number; height: number };
  /** The rectangle's layout: Terms across or down, and the size of a cell. */
  wide: boolean;
  cell: number;
  /** The colour of the scene's middle tone, which moves with the stages. */
  tone: string;
  /** How visible the Term names are, 0 to 1. */
  termNames: number;
  courses: CourseReport[];
}

export interface SceneHandle {
  report(): SceneReport;
  /** Advance the simulation by this many steps at once, without waiting for
   * the screen. What a test uses so that it does not depend on how fast the
   * machine under it happens to draw. */
  advance(steps: number): void;
  /** The page's text has moved (a web font arrived, the window changed):
   * measure the free band again and put the rectangle back in it. */
  relayout(): void;
  dispose(): void;
}

/* ── The design's constants ─────────────────────────────────────────────── */

type Role = "pastel" | "light" | "medium" | "deep" | "glass";
const ROLES: readonly Role[] = ["pastel", "light", "medium", "deep", "glass"];

/** Three palettes of five tones. The scene opens in the planner's petrol,
 * falls into sky, and settles into the green a plan takes when it is in
 * order. */
const PALETTES: Record<"petrol" | "sky" | "green", Record<Role, string>> = {
  petrol: { pastel: "#E4EEF3", light: "#9FC4D4", medium: "#1D627F", deep: "#043246", glass: "#3F8AA8" },
  sky: { pastel: "#E4EEF3", light: "#A9D4F2", medium: "#5DBBF5", deep: "#1F86CC", glass: "#7CC6F5" },
  green: { pastel: "#E9EFE4", light: "#C3D4BF", medium: "#5A8C69", deep: "#3D6848", glass: "#7FAE8C" },
};

/** A label is cream on a dark sphere and ink on a pale one. */
const INK = "#043246";
const PAPER = "#F8F4EA";

const SPHERES_WIDE = 96;
/** A phone: the Plan's 48 and six of the others. */
const SPHERES_NARROW = 54;
const NARROW_BELOW = 768;

/** Sixty steps a second, whatever the screen's refresh rate. */
const STEP_SECONDS = 1 / 60;
/** After a stall (a background tab, a long task) the scene does not try to
 * catch up all at once. */
const MAX_STEPS_PER_FRAME = 3;

const PHYSICS = { rebound: -0.3, damping: 0.91, centerAttract: 0.0035, bounciness: 0.02, gravity: 0.011 } as const;

/** Words drawn on a canvas and shown as a sprite. */
interface Lettering {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
}
/** A sphere's code, which is drawn again once the page's fonts arrive. */
interface Label extends Lettering {
  draw(): void;
}

interface Sphere {
  id: number;
  /** The size it happened to be given. Assembled, every Course is one size. */
  radius: number;
  mass: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  group: THREE.Group;
  sphere: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  role: Role;
  /** The radius it is drawn at now. */
  size: number;
  code: string;
  inPlan: boolean;
  term: number;
  lane: number;
  /** The centre of its cell. Meaningful for a Plan Course only. */
  home: THREE.Vector3;
  /** Still on its way to its cell: it passes through the other Plan Courses
   * and does not go round them. */
  travelling: boolean;
  /** `pile`: the floor holds it. `out`: the floor has opened and it is
   * falling off the bottom. `rain`: it has come back in from the top. */
  phase: "pile" | "out" | "rain";
  /** Not in the Plan, and the Plan is made: it fell away and is not drawn. */
  gone: boolean;
  label: Label;
}

/** Mounts the scene on a canvas inside `container`. Throws if the browser
 * will not give it a WebGL context, or if anything else stops it starting;
 * the caller falls back to the page. */
export function mount(container: HTMLElement, host: SceneHost): SceneHandle {
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("the scene needs a canvas to draw on");
  // `failIfMajorPerformanceCaveat`: no context at all is better than one
  // drawn in software. The page asks the same before it sends for this
  // file (src/gravity.ts); this is the same answer if it is asked twice.
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true,
  });
  try {
    return build(container, canvas, renderer, host);
  } catch (error) {
    // Browsers cap how many WebGL contexts a page may hold. A scene that
    // got a renderer and then failed must give its context back.
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}

function build(container: HTMLElement, canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer, host: SceneHost): SceneHandle {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 100);
  camera.position.set(0, 0, 11);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  // SHADOWS AS THE PROTOTYPE DREW THEM. It was written against three.js
  // r160 and asked for PCFSoftShadowMap with a blur radius of 12; in r160
  // that map ignored the radius. This build is on r186, which has folded
  // the soft map into PCFShadowMap and DOES honour a radius there. So the
  // radius is left at its default: asking for 12 here would draw a far
  // softer shadow than the one the owner signed off.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // ── Lights ──
  const hemiLight = new THREE.HemisphereLight(0xffffff, new THREE.Color(PALETTES.petrol.medium), 1.6);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(-6, 10, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.camera.left = -8;
  keyLight.shadow.camera.right = 8;
  keyLight.shadow.camera.top = 8;
  keyLight.shadow.camera.bottom = -8;
  keyLight.shadow.bias = -0.0003;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 1.25);
  rimLight.position.set(8, 7, -8);
  scene.add(rimLight);

  const frontLight = new THREE.DirectionalLight(0xffffff, 0.4);
  frontLight.position.set(0, 0, 11);
  scene.add(frontLight);

  const sideBounceLight = new THREE.DirectionalLight(0xffffff, 0.3);
  sideBounceLight.position.set(-9, -2, 4);
  scene.add(sideBounceLight);

  // ── The box the simulation lives in: the screen, in world units ──
  const view = { width: 10, height: 6 };
  const measureView = (): void => {
    view.height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.position.z;
    view.width = view.height * (container.clientWidth / Math.max(1, container.clientHeight));
  };
  measureView();

  // ── Palette ──
  const tones = (hexes: Record<Role, string>): Record<Role, THREE.Color> => ({
    pastel: new THREE.Color(hexes.pastel),
    light: new THREE.Color(hexes.light),
    medium: new THREE.Color(hexes.medium),
    deep: new THREE.Color(hexes.deep),
    glass: new THREE.Color(hexes.glass),
  });
  const petrol = tones(PALETTES.petrol);
  const sky = tones(PALETTES.sky);
  const green = tones(PALETTES.green);
  /** The palette as it is at this point down the page. */
  const palette = tones(PALETTES.petrol);

  // ── Labels ──
  // Drawn white and tinted per frame, so one texture serves a sphere through
  // petrol, sky and green: cream ink on a dark ball, navy ink on a pale one.
  const ink = new THREE.Color(INK);
  const paper = new THREE.Color(PAPER);
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  // The page's own faces, by the names its stylesheet gives them. A course
  // code's subject is in the mono, as everywhere on the site.
  const rootStyle = getComputedStyle(document.documentElement);
  const MONO = rootStyle.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  const SANS = rootStyle.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";

  /** `letterSpacing` is newer than the canvas types this project builds
   * against, and not in every browser. */
  const track = (ctx: CanvasRenderingContext2D, spacing: string): void => {
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = spacing;
  };
  const fitFont = (ctx: CanvasRenderingContext2D, text: string, weight: number, px: number, family: string, maxWidth: number): void => {
    ctx.font = `${weight} ${px}px ${family}`;
    const width = ctx.measureText(text).width;
    if (width > maxWidth) ctx.font = `${weight} ${Math.floor((px * maxWidth) / width)}px ${family}`;
  };

  const makeLabel = (code: string): Label => {
    const face = document.createElement("canvas");
    face.width = face.height = 256;
    const texture = new THREE.CanvasTexture(face);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    const cut = code.lastIndexOf(" ");
    const subject = code.slice(0, cut);
    const number = code.slice(cut + 1);
    const draw = (): void => {
      const ctx = face.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, 256, 256);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      track(ctx, "3px");
      fitFont(ctx, subject, 700, 50, MONO, 206);
      ctx.fillText(subject, 128, 84);
      track(ctx, "-2px");
      fitFont(ctx, number, 700, 108, SANS, 226);
      ctx.fillText(number, 128, 160);
      texture.needsUpdate = true;
    };
    draw();
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
    const sprite = new THREE.Sprite(material);
    scene.add(sprite);
    return { sprite, material, texture, draw };
  };

  // ── Spheres ──
  // The first 48 are the Plan, lane by lane; the rest are other Courses.
  const count = window.innerWidth < NARROW_BELOW ? SPHERES_NARROW : SPHERES_WIDE;
  const planSize = TERM_COUNT * COURSES_PER_TERM;
  const sphereGeometry = new THREE.SphereGeometry(1, 48, 48);
  const spheres: Sphere[] = [];
  for (let i = 0; i < count; i++) {
    let radius: number;
    const pick = Math.random();
    if (pick < 0.3) radius = 0.27 + Math.random() * 0.12;
    else if (pick < 0.8) radius = 0.42 + Math.random() * 0.18;
    else radius = 0.66 + Math.random() * 0.21;

    let role: Role;
    let material: THREE.MeshPhysicalMaterial;
    if (Math.random() < 0.22) {
      role = "glass";
      material = new THREE.MeshPhysicalMaterial({
        color: petrol.glass, roughness: 0.08, metalness: 0.0,
        clearcoat: 1.0, clearcoatRoughness: 0.03, transmission: 0.95,
        ior: 1.485, thickness: 2.2,
        specularColor: new THREE.Color("#ffffff"), specularIntensity: 1.0,
        attenuationColor: petrol.pastel, attenuationDistance: 1.0,
        emissive: petrol.glass, emissiveIntensity: 0.12,
        transparent: true,
      });
    } else {
      const tone = Math.random();
      role = tone < 0.25 ? "pastel" : tone < 0.55 ? "light" : tone < 0.85 ? "medium" : "deep";
      material = new THREE.MeshPhysicalMaterial({
        color: petrol[role], roughness: 0.44, metalness: 0.0,
        clearcoat: 0.24, clearcoatRoughness: 0.35,
        emissive: petrol[role], emissiveIntensity: 0.08,
        transparent: true,
      });
    }

    const group = new THREE.Group();
    const sphere = new THREE.Mesh(sphereGeometry, material);
    sphere.scale.setScalar(radius);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    group.add(sphere);
    scene.add(group);

    // Which Course this sphere is, and where it sits in the Plan.
    const inPlan = i < planSize;
    const lane = inPlan ? Math.floor(i / TERM_COUNT) : 0;
    const term = inPlan ? i % TERM_COUNT : 0;
    const code = inPlan ? SAMPLE_PLAN.terms[term].courses[lane] : SAMPLE_PLAN.others[(i - planSize) % SAMPLE_PLAN.others.length];

    spheres.push({
      id: i, radius, mass: radius ** 3,
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      group, sphere, material, role, size: radius,
      code, inPlan, term, lane,
      home: new THREE.Vector3(), travelling: false,
      phase: "pile", gone: false,
      label: makeLabel(code),
    });
  }

  // ── Where the Plan sits, and the names of its Terms ──
  let grid: PlanGrid = planGrid(view, host.band(), TERM_COUNT, COURSES_PER_TERM);
  let captions: Lettering[] = [];
  /** How strongly a Term's name is drawn at its strongest. It is furniture. */
  const CAPTION_STRENGTH = 0.62;

  const makeCaption = (text: string, worldHeight: number): THREE.Sprite => {
    const px = 64;
    // A label, so it is in the sans at 700, uppercase and tracked, like the
    // page's other small labels. (The prototype set these in the mono at
    // 500; this site keeps the mono for course codes.)
    const font = `700 ${px}px ${SANS}`;
    const face = document.createElement("canvas");
    const measure = face.getContext("2d");
    let width = px * text.length;
    if (measure) {
      track(measure, "5px");
      measure.font = font;
      width = Math.ceil(measure.measureText(text).width) + 24;
    }
    face.width = width;
    face.height = px * 1.5;
    const ctx = face.getContext("2d");
    if (ctx) {
      track(ctx, "5px");
      ctx.font = font;
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 12, face.height / 2);
    }
    const texture = new THREE.CanvasTexture(face);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, opacity: 0, color: ink });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(worldHeight * (face.width / face.height), worldHeight, 1);
    scene.add(sprite);
    captions.push({ sprite, material, texture });
    return sprite;
  };
  const clearCaptions = (): void => {
    for (const caption of captions) {
      scene.remove(caption.sprite);
      caption.material.dispose();
      caption.texture.dispose();
    }
    captions = [];
  };

  const layOut = (): void => {
    grid = planGrid(view, host.band(), TERM_COUNT, COURSES_PER_TERM);
    for (const b of spheres) {
      if (!b.inPlan) continue;
      const cell = grid.at(b.term, b.lane);
      b.home.set(cell.x, cell.y, 0);
    }
    clearCaptions();
    // The only furniture is the Term names, and only where Terms run across.
    if (grid.wide) {
      SAMPLE_PLAN.terms.forEach((term, t) => {
        const at = grid.captionAt(t);
        makeCaption(term.name.toUpperCase(), grid.captionHeight).position.set(at.x, at.y, 0);
      });
    }
  };
  layOut();

  // Fonts arrive after the first frame; redraw every label once they do.
  let disposed = false;
  if (document.fonts?.load) {
    Promise.all([document.fonts.load(`700 50px ${MONO}`), document.fonts.load(`700 108px ${SANS}`)])
      .then(() => {
        if (disposed) return;
        for (const b of spheres) b.label.draw();
        layOut();
      })
      .catch(() => {});
  }

  // ── Entrance: from far off the screen, inward ──
  const reach = Math.max(view.width, view.height) * 1.5;
  for (const b of spheres) {
    const angle = Math.random() * Math.PI * 2;
    const px = Math.cos(angle) * reach * 1.25;
    const py = Math.sin(angle) * reach * 0.85;
    const pz = (Math.random() - 0.5) * 4;
    b.position.set(px, py, pz);
    b.group.position.copy(b.position);
    b.velocity.set(-px, -py, -pz).normalize().multiplyScalar(0.08 + Math.random() * 0.05);
  }

  // ── The simulation ──
  let steps = 0;
  let progress = 0;
  let termNames = 0;
  const collideDiff = new THREE.Vector3();
  const relVel = new THREE.Vector3();
  const deltaPos = new THREE.Vector3();
  const rotAxis = new THREE.Vector3();
  const toCam = new THREE.Vector3();

  /** A Plan Course that has come back in from the top: the only kind that
   * is caught, drawn to a cell, and let down gently. */
  const landing = (b: Sphere): boolean => b.inPlan && b.phase === "rain";

  const placeLabel = (b: Sphere): void => {
    // On the camera's side of the sphere, along the line of sight, so it
    // stays centred on the ball wherever the ball is on screen.
    toCam.copy(camera.position).sub(b.position).normalize();
    const out = (b.size * 1.05) / Math.max(0.2, toCam.z);
    b.label.sprite.position.copy(b.position).addScaledVector(toCam, out);
    const side = b.size * 1.62;
    b.label.sprite.scale.set(side, side, 1);
    // A Course that has gone past the lens takes its name with it.
    b.label.material.opacity = b.material.opacity;
    b.label.sprite.visible = b.material.opacity > 0.01;
    const c = b.material.color;
    const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    b.label.material.color.copy(paper).lerp(ink, smoothstep(0.235, 0.285, luminance));
  };

  const step = (): void => {
    steps++;
    const time = steps * STEP_SECONDS;
    progress = host.progress();
    const stage = stageAt(progress);
    const { scrambled, falling, caught, rectangle, flight } = stage;

    // Petrol, to sky, to green.
    for (const role of ROLES) palette[role].copy(petrol[role]).lerp(sky[role], stage.toSky).lerp(green[role], stage.toGreen);
    hemiLight.groundColor.copy(palette.medium);

    const entrance = easeOutCubic(clamp01(time / 2.2));
    const attractionBoost = lerp(7.5, 1, entrance);

    let damping: number = PHYSICS.damping;
    damping = lerp(damping, 0.992, falling);
    damping = lerp(damping, 0.9, rectangle);
    damping = lerp(damping, 0.985, flight);

    const camZ = camera.position.z;
    const clusterActive = Math.max(scrambled, entrance < 1 ? 1 : 0);
    // The cluster's home is a little up and right of centre: the headline is
    // navy, set bottom-left, and so are half the spheres.
    const landscape = view.width > view.height;
    const homeX = view.width * (landscape ? 0.055 : 0);
    const homeY = view.height * (landscape ? 0.075 : 0.13);

    const topY = view.height / 2 - 0.05;
    const floorY = -view.height / 2 + 0.05;

    // 1. ACCELERATIONS
    for (const b of spheres) {
      if (b.phase === "pile" && stage.floorOpen) {
        b.phase = "out";
      } else if (b.phase !== "pile" && stage.backToPile) {
        // Back up the page. Whatever had left returns from above and lands
        // on the floor with the rest.
        if (b.gone || b.position.y < floorY - b.radius || b.position.y > topY + b.radius) {
          b.position.set((Math.random() - 0.5) * view.width * 0.8, topY + b.radius + Math.random() * 3, (Math.random() - 0.5) * 2);
          b.velocity.set(0, 0, 0);
          b.group.position.copy(b.position);
        }
        b.gone = false;
        b.group.visible = true;
        b.phase = "pile";
      }
      if (b.gone) continue;
      const fallen = b.phase !== "pile";

      if (scrambled > 0.01) {
        b.velocity.x += Math.sin(time * 0.4 + b.id * 1.5) * 0.0004 * b.radius * scrambled;
        b.velocity.y += Math.cos(time * 0.5 + b.id * 1.2) * 0.0004 * b.radius * scrambled;
        b.velocity.z += Math.sin(time * 0.35 + b.id) * 0.0001 * scrambled;
      }

      const clusterStrength = PHYSICS.centerAttract * attractionBoost * clusterActive;
      if (clusterStrength > 0.00001) {
        b.velocity.x += (homeX - b.position.x) * clusterStrength * 0.38;
        b.velocity.y += (homeY - b.position.y) * clusterStrength * 1.85;
        b.velocity.z += (0 - b.position.z) * clusterStrength * 1.8;
      }

      // ON ITS WAY, OR HOME. A Plan Course still travelling to its cell goes
      // through the others, not round them. It has to: they arrive from
      // directly above, and a Course bound for the bottom row cannot get
      // past one already seated in the top row. Measured in the prototype:
      // about half of them never reached their cell.
      let toCell = 0;
      if (landing(b)) {
        const dx = b.home.x - b.position.x;
        const dy = b.home.y - b.position.y;
        b.travelling = dx * dx + dy * dy > grid.cell * grid.cell * 0.6;
        toCell = Math.sqrt(dx * dx + dy * dy + b.position.z * b.position.z);
      } else {
        b.travelling = false;
      }

      // Gravity. On the floor it is the falling stage's. With the floor open
      // it is constant, except for a Plan Course that has come back in: that
      // one is let down more gently the more firmly it is caught.
      const g = !fallen ? PHYSICS.gravity * falling : landing(b) ? PHYSICS.gravity * (1 - caught) : PHYSICS.gravity;
      if (g > 0.00001) b.velocity.y -= g;

      // Only a Plan Course that has come back in is drawn to its cell. One
      // still in the pile has to fall out first, or it would simply rise
      // into place and nothing would have been sorted.
      if (landing(b) && rectangle > 0.001) {
        const pull = 0.06 * rectangle;
        b.velocity.x += (b.home.x - b.position.x) * pull;
        b.velocity.y += (b.home.y - b.position.y) * pull;
        b.velocity.z += (b.home.z - b.position.z) * pull;
      }

      if (flight > 0.001) {
        const stagger = (b.id * 0.6180339887) % 1;
        const local = smoothstep(stagger * 0.55, stagger * 0.55 + 0.45, flight);
        b.velocity.z += 0.05 * local;
        b.velocity.x += b.position.x * 0.006 * local;
        b.velocity.y += b.position.y * 0.006 * local;
      }

      // PARKED ONCE IT IS WELL PAST THE LENS. The flight's push grows with
      // distance, so without this a Course left alone on the footer for a
      // minute is billions of units away and heading for Infinity, and a
      // position that has overflowed does not come back.
      if (flight > 0.001 && b.position.z > 60) b.velocity.set(0, 0, 0);

      const damp = !fallen ? damping : landing(b) ? lerp(0.992, damping, caught) : 0.992;
      b.velocity.multiplyScalar(damp);

      // EASED IN, NOT FIRED IN. The pull toward a cell grows with distance,
      // and from above the screen it is strong enough to carry a Course
      // straight through its cell and off the bottom, where the sieve sends
      // it round again, for ever (measured in the prototype: a third of the
      // Plan never arrived). A caught Course may approach no faster than a
      // fraction of the distance left, so it slows as it lands. Loosely
      // caught, the cap is high and it still falls like everything else. Not
      // in flight: that is supposed to accelerate.
      if (toCell > 0 && flight < 0.001) {
        const cap = lerp(1.6, 0.08 * toCell + 0.04, caught);
        const speed = b.velocity.length();
        if (speed > cap) b.velocity.multiplyScalar(cap / speed);
      }
      b.position.add(b.velocity);

      if (fallen && b.position.y < floorY - b.size - 0.6 && !(landing(b) && caught > 0.6)) {
        const above = topY + b.size + 0.4 + Math.random() * 3.2;
        if (b.inPlan) {
          // Back in from the top, directly above its own cell, and queued so
          // the bottom of each column arrives first and the rest land on it
          // in order, like beads let down a string.
          const row = grid.wide ? b.lane : b.term;
          const rows = grid.wide ? COURSES_PER_TERM : TERM_COUNT;
          b.position.set(b.home.x, topY + b.size + 0.4 + (rows - 1 - row) * 1.25 + Math.random() * 0.5, 0);
        } else if (stage.othersReturn) {
          // Back in from the top, anywhere, and in front of or behind the
          // Plan so it falls past the rectangle and not through it.
          const side = Math.random() < 0.5 ? -1 : 1;
          b.position.set((Math.random() - 0.5) * (view.width - 1), above, side * (1.1 + Math.random() * 0.7));
        } else {
          // Not in the Plan, and the Plan is made: it does not come back.
          b.gone = true;
          b.group.visible = false;
          b.label.sprite.visible = false;
          continue;
        }
        b.velocity.set(0, -0.04, 0);
        b.phase = "rain";
        b.group.position.copy(b.position); // a jump is not a roll
      }

      b.material.color.copy(palette[b.role]);
      b.material.emissive.copy(palette[b.role]);
      b.material.opacity = flight > 0.001 ? 1 - smoothstep(camZ - 2.6, camZ - 0.3, b.position.z) : 1;

      // Scrambled, a Course is whatever size it happened to be. Assembled,
      // every Course is the same size, because a plan is a grid.
      const targetSize = b.inPlan ? lerp(b.radius, grid.radius, rectangle) : b.radius;
      b.size += (targetSize - b.size) * 0.12;
      b.sphere.scale.setScalar(b.size);
    }

    // 2. PAIRWISE COLLISIONS (nearly off once assembling, so Courses settle
    // onto their cells; off in flight)
    const collideScale = 0.28 * (1 - 0.93 * rectangle) * (1 - flight);
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < spheres.length; i++) {
        const b1 = spheres[i];
        if (b1.gone) continue;
        for (let j = i + 1; j < spheres.length; j++) {
          const b2 = spheres[j];
          if (b2.gone) continue;
          if ((b1.travelling || b2.travelling) && b1.inPlan && b2.inPlan) continue;
          // A Course falling past the Plan does not knock the Plan about.
          if (b1.inPlan !== b2.inPlan && (b1.phase === "rain" || b2.phase === "rain")) continue;
          collideDiff.subVectors(b2.position, b1.position);
          const dist = collideDiff.length();
          const minDist = b1.size + b2.size;
          if (dist < minDist && dist > 0.001) {
            const overlap = minDist - dist;
            collideDiff.multiplyScalar(1 / dist);
            const totalMass = b1.mass + b2.mass;
            b1.position.addScaledVector(collideDiff, -overlap * (b2.mass / totalMass) * collideScale);
            b2.position.addScaledVector(collideDiff, overlap * (b1.mass / totalMass) * collideScale);

            relVel.subVectors(b2.velocity, b1.velocity);
            const closing = relVel.dot(collideDiff);
            if (closing < -0.0001) {
              const impulse = (-(1 + PHYSICS.bounciness) * closing) / (1 / b1.mass + 1 / b2.mass);
              b1.velocity.addScaledVector(collideDiff, -impulse / b1.mass);
              b2.velocity.addScaledVector(collideDiff, impulse / b2.mass);
            }
          }
        }
      }
    }

    // 3. THE WALLS, AND A FLOOR WITH SOME BOUNCE IN IT
    const xBound = view.width / 2 - 0.2;
    const zBound = 2.0;
    const restitution = 0.3 + 0.35 * falling;
    // The walls let go as the field lifts off; the near and far walls first.
    const contain = flight < 0.5;
    const containZ = flight < 0.02;

    for (const b of spheres) {
      if (b.gone) continue;
      const r = b.size;

      if (contain) {
        if (b.position.x < -xBound - r) { b.position.x = -xBound - r; b.velocity.x *= PHYSICS.rebound; }
        else if (b.position.x > xBound + r) { b.position.x = xBound + r; b.velocity.x *= PHYSICS.rebound; }

        if (b.phase === "pile" && b.position.y - r < floorY) {
          b.position.y = floorY + r;
          if (b.velocity.y < 0) b.velocity.y = -b.velocity.y * restitution;
          if (falling > 0.3) { b.velocity.x *= 0.86; b.velocity.z *= 0.86; }
        }
        if (b.phase === "pile" && b.position.y + r > topY) {
          b.position.y = topY - r;
          if (b.velocity.y > 0) b.velocity.y *= PHYSICS.rebound;
        }
      }

      if (containZ) {
        if (b.position.z < -zBound) { b.position.z = -zBound; b.velocity.z *= PHYSICS.rebound; }
        else if (b.position.z > zBound) { b.position.z = zBound; b.velocity.z *= PHYSICS.rebound; }
      }

      // It rolls as far as it has moved.
      deltaPos.copy(b.position).sub(b.group.position);
      if (deltaPos.lengthSq() > 0.000001) {
        rotAxis.set(deltaPos.y, -deltaPos.x, 0).normalize();
        b.group.rotateOnWorldAxis(rotAxis, (deltaPos.length() / b.radius) * 0.95);
      }
      b.group.position.copy(b.position);
      placeLabel(b);
    }

    // 4. THE TERM NAMES, which arrive with the rectangle and leave with it
    // (None on a tall screen, where the Terms run down and are not named.)
    termNames = captions.length ? stage.captions : 0;
    for (const caption of captions) {
      caption.material.opacity = termNames * CAPTION_STRENGTH;
      caption.sprite.visible = termNames > 0.002;
    }
  };

  // ── The loop: sixty steps a second, and a frame drawn for each run of them ──
  // (So on a 120 Hz screen it draws every other frame. Nothing has moved in
  // between, and a frame that shows nothing new is only heat.)
  let frame = 0;
  let last = performance.now();
  let owed = 0;
  /** Nothing is on screen and nothing will be until the reader scrolls back:
   * the Plan has flown past the camera and faded. The loop stops stepping
   * and drawing, and only watches for the page to come back up. */
  let asleep = false;
  const allGone = (): boolean => spheres.every((b) => b.gone || b.material.opacity <= 0.01);

  const tick = (at: number): void => {
    frame = requestAnimationFrame(tick);
    if (asleep) {
      if (stageAt(host.progress()).flight >= 1) return;
      asleep = false;
      last = at;
      owed = 0;
    }
    // Never negative: the first frame's timestamp is the start of that frame,
    // which can be EARLIER than the `performance.now()` taken above it. A
    // negative count here once ran the loop below for ever and froze the tab.
    owed += Math.min(0.25, Math.max(0, at - last) / 1000);
    last = at;
    // Rounded, not floored: a 60 Hz screen delivers frames a hair under or
    // over a sixtieth of a second apart, and flooring turns that jitter into
    // a frame with no step followed by one with two.
    const due = Math.min(MAX_STEPS_PER_FRAME, Math.round(owed / STEP_SECONDS));
    if (due < 1) return;
    owed = due === MAX_STEPS_PER_FRAME ? 0 : owed - due * STEP_SECONDS;
    for (let i = 0; i < due; i++) step();
    renderer.render(scene, camera);
    asleep = stageAt(progress).flight >= 1 && allGone();
  };
  step();
  renderer.render(scene, camera);
  frame = requestAnimationFrame(tick);

  // The browser can take a context away at any time. It tells the canvas,
  // and the canvas is blank from then on. (Disposing does this too, which
  // is not news to anyone.)
  const onContextLost = (): void => {
    if (!disposed) host.lost();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const onResize = (): void => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    measureView();
    layOut();
  };
  const resizes = new ResizeObserver(onResize);
  resizes.observe(container);

  return {
    report: () => ({
      steps,
      progress,
      view: { ...view },
      wide: grid.wide,
      cell: grid.cell,
      tone: `#${palette.medium.getHexString()}`,
      termNames,
      courses: spheres.map((b) => ({
        code: b.code,
        inPlan: b.inPlan,
        term: b.inPlan ? b.term : null,
        lane: b.inPlan ? b.lane : null,
        x: b.position.x,
        y: b.position.y,
        z: b.position.z,
        size: b.size,
        showing: !b.gone && b.material.opacity > 0.01,
        home: b.inPlan ? { x: b.home.x, y: b.home.y } : null,
      })),
    }),
    advance: (count) => {
      for (let i = 0; i < count; i++) step();
      renderer.render(scene, camera);
    },
    relayout: layOut,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizes.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      clearCaptions();
      for (const b of spheres) {
        b.material.dispose();
        b.label.material.dispose();
        b.label.texture.dispose();
      }
      sphereGeometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss(); // browsers cap live contexts; give this one back
    },
  };
}
