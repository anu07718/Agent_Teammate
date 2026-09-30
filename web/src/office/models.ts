// Low-poly pieces of the office, all built in code: plinths, walkways, desks with live screens, chairs,
// people, plants. Materials come from a per-owner palette so a department can be dimmed on its own.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export class Palette {
  readonly entries: { mat: THREE.MeshStandardMaterial; base: THREE.Color; owner: string }[] = [];
  private cache = new Map<string, THREE.MeshStandardMaterial>();

  get(owner: string, hex: string, opts: { rough?: number; metal?: number; emissive?: string } = {}) {
    const key = `${owner}|${hex}|${opts.rough ?? 0.85}|${opts.emissive ?? ""}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: hex, roughness: opts.rough ?? 0.85, metalness: opts.metal ?? 0 });
      if (opts.emissive) {
        m.emissive = new THREE.Color(opts.emissive);
        m.emissiveIntensity = 0.35;
      }
      this.cache.set(key, m);
      this.entries.push({ mat: m, base: new THREE.Color(hex), owner });
    }
    return m;
  }

  /** tint every material of `owner`, e.g. for dark mode */
  retint(owner: string, from: string, to: string) {
    for (const e of this.entries) {
      if (e.owner === owner && e.base.getHexString() === new THREE.Color(from).getHexString()) {
        e.base.set(to);
        e.mat.color.set(to);
      }
    }
  }
}

const tag = (o: THREE.Object3D, owner: string, part?: string) => {
  o.traverse((c) => {
    c.userData.owner = owner;
    if (part) c.userData.part = part;
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
};

export function plinth(pal: Palette, owner: string, size: number, floor: string, side: string) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(size, 1.6, size, 4, 0.7), pal.get(owner, side, { rough: 0.95 }));
  body.position.y = -0.8;
  body.userData.part = "plinth";
  g.add(body);
  const top = new THREE.Mesh(new RoundedBoxGeometry(size - 0.9, 0.2, size - 0.9, 3, 0.4), pal.get(owner, floor, { rough: 0.9 }));
  top.position.y = 0.02;
  top.userData.part = "floor";
  g.add(top);
  return tag(g, owner);
}

export function walkway(pal: Palette, from: [number, number], to: [number, number], side: string) {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const len = Math.hypot(dx, dz);
  const m = new THREE.Mesh(new RoundedBoxGeometry(3.2, 0.5, len, 2, 0.2), pal.get("walk", side, { rough: 0.95 }));
  m.position.set((from[0] + to[0]) / 2, -0.35, (from[1] + to[1]) / 2);
  m.rotation.y = Math.atan2(dx, dz);
  return tag(m, "walk");
}

/** a monitor screen drawn on a canvas: a header in the department colour and the desk's last few lines */
export class Screen {
  readonly canvas = document.createElement("canvas");
  readonly tex: THREE.CanvasTexture;
  private lines: string[] = [];
  private mode: "idle" | "working" | "waiting" = "idle";

  constructor(private chip: string) {
    this.canvas.width = 256;
    this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.draw();
  }

  set(lines: string[], mode: "idle" | "working" | "waiting") {
    this.lines = lines.slice(-4);
    this.mode = mode;
    this.draw();
  }

  private draw() {
    const x = this.canvas.getContext("2d")!;
    const w = this.canvas.width, h = this.canvas.height;
    x.fillStyle = "#fbfcf7";
    x.fillRect(0, 0, w, h);
    x.fillStyle = this.mode === "waiting" ? "#e8a33a" : this.chip;
    x.fillRect(0, 0, w, 18);
    x.fillStyle = "rgba(255,255,255,.9)";
    x.font = "bold 11px ui-monospace, Menlo, monospace";
    x.fillText(this.mode === "waiting" ? "WAITING FOR YOUR OK" : this.mode === "working" ? "WORKING" : "READY", 8, 13);
    x.font = "13px ui-monospace, Menlo, monospace";
    const lines = this.lines.length ? this.lines : ["▸ ready for the next case"];
    lines.forEach((l, i) => {
      x.fillStyle = i === lines.length - 1 ? "#1d1c1a" : "#77756f";
      x.fillText(l.slice(0, 29), 8, 42 + i * 28);
    });
    if (this.mode === "working") {
      x.fillStyle = this.chip;
      x.fillRect(8, h - 12, 60 + Math.random() * 150, 4);
    }
    this.tex.needsUpdate = true;
  }
}

export function desk(pal: Palette, owner: string, chip: string) {
  const g = new THREE.Group();
  const wood = pal.get(owner, "#d8b98c", { rough: 0.8 });
  const leg = pal.get(owner, "#b9b6ab");
  const top = new THREE.Mesh(new RoundedBoxGeometry(5.2, 0.28, 2.6, 2, 0.1), wood);
  top.position.y = 1.9;
  g.add(top);
  for (const sx of [-2.35, 2.35]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.8, 2.3), leg);
    panel.position.set(sx, 0.95, 0);
    g.add(panel);
  }
  const screen = new Screen(chip);
  const frame = new THREE.Mesh(new RoundedBoxGeometry(3.1, 2.0, 0.18, 2, 0.06), pal.get(owner, "#26262a", { rough: 0.5 }));
  frame.position.set(0, 3.35, -0.75);
  g.add(frame);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(2.86, 1.76), new THREE.MeshBasicMaterial({ map: screen.tex, toneMapped: false }));
  face.position.set(0, 3.35, -0.65);
  face.userData.owner = owner;
  face.userData.screen = true;
  g.add(face);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.5, 8), leg);
  stand.position.set(0, 2.25, -0.8);
  g.add(stand);
  const kb = new THREE.Mesh(new RoundedBoxGeometry(1.8, 0.08, 0.6, 1, 0.03), pal.get(owner, "#ecebe5"));
  kb.position.set(-0.2, 2.08, 0.35);
  g.add(kb);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.36, 12), pal.get(owner, chip));
  mug.position.set(1.8, 2.22, 0.3);
  g.add(mug);
  tag(g, owner);
  face.castShadow = false;
  return { group: g, screen };
}

export function chair(pal: Palette, owner: string) {
  const g = new THREE.Group();
  const dark = pal.get(owner, "#3b3b40", { rough: 0.6 });
  const seat = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.25, 1.4, 2, 0.1), dark);
  seat.position.y = 1.15;
  g.add(seat);
  const back = new THREE.Mesh(new RoundedBoxGeometry(1.4, 1.5, 0.2, 2, 0.08), dark);
  back.position.set(0, 2.0, 0.65);
  g.add(back);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 8), pal.get(owner, "#8d8b85"));
  pole.position.y = 0.6;
  g.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.12, 12), dark);
  base.position.y = 0.12;
  g.add(base);
  return tag(g, owner);
}

export interface Person {
  root: THREE.Group;
  body: THREE.Group;   // everything above the hips: leans, stands, turns
  head: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legs: { thigh: THREE.Mesh; shin: THREE.Mesh }[];
}

/** 0 = seated, 1 = standing: the thighs swing down and the body rises */
export function standPose(p: Person, k: number) {
  for (const { thigh, shin } of p.legs) {
    thigh.rotation.x = (Math.PI / 2) * (1 - k);
    thigh.position.y = 1.35 + 0.35 * k;
    thigh.position.z = -0.35 * (1 - k);
    shin.position.y = 0.75 - 0.15 * k;
    shin.position.z = -0.85 * (1 - k);
  }
  p.body.position.y = 0.55 * k;
}

export function person(pal: Palette, owner: string, look: { hair: string; skin: string }, shirt: string, lead: boolean): Person {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const s = lead ? 1.08 : 1;
  const skin = pal.get(owner, look.skin, { rough: 0.7 });
  const hairM = pal.get(owner, look.hair, { rough: 0.9 });
  const cloth = pal.get(owner, shirt, { rough: 0.9 });
  const trousers = pal.get(owner, "#3c3f48");
  const legs: Person["legs"] = [];
  for (const sx of [-0.3, 0.3]) {
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.8, 4, 8), trousers);
    thigh.position.x = sx;
    root.add(thigh);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.8, 4, 8), trousers);
    shin.position.x = sx;
    root.add(shin);
    legs.push({ thigh, shin });
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55 * s, 1.0 * s, 4, 12), cloth);
  torso.position.y = 2.35;
  body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 16, 12), skin);
  head.position.y = 3.55 * s;
  body.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.53 * s, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairM);
  hair.position.y = 0.04;
  hair.rotation.x = 0.25;
  head.add(hair);
  const mkArm = (sx: number) => {
    const a = new THREE.Group();
    a.position.set(sx * 0.62 * s, 2.85, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.75, 4, 8), cloth);
    upper.position.y = -0.45;
    a.add(upper);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), skin);
    hand.position.y = -0.95;
    a.add(hand);
    body.add(a);
    return a;
  };
  const armL = mkArm(-1), armR = mkArm(1);
  tag(root, owner, "person");
  const p = { root, body, head, armL, armR, legs };
  standPose(p, 0);
  return p;
}

export function plant(pal: Palette, owner: string) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.42, 0.9, 12), pal.get(owner, "#e7e2d6"));
  pot.position.y = 0.45;
  g.add(pot);
  const leaf = pal.get(owner, "#5f8f57", { rough: 0.9 });
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 - i * 0.05, 0), leaf);
    const a = (i / 5) * Math.PI * 2;
    l.position.set(Math.cos(a) * 0.35, 1.2 + (i % 2) * 0.45, Math.sin(a) * 0.35);
    l.scale.y = 1.4;
    g.add(l);
  }
  return tag(g, owner);
}

/** a round, cream bubble with an emoji in it: rises and fades over a desk */
const bubbleCache = new Map<string, THREE.CanvasTexture>();
export function bubbleTexture(icon: string, amber = false) {
  const key = icon + (amber ? "!" : "");
  let t = bubbleCache.get(key);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d")!;
    x.beginPath();
    x.arc(64, 58, 50, 0, Math.PI * 2);
    x.fillStyle = amber ? "rgba(255,244,222,.98)" : "rgba(252,253,247,.97)";
    x.fill();
    x.lineWidth = 3;
    x.strokeStyle = amber ? "rgba(200,130,20,.75)" : "rgba(23,22,20,.22)";
    x.stroke();
    x.beginPath();
    x.moveTo(52, 104);
    x.lineTo(64, 124);
    x.lineTo(74, 103);
    x.closePath();
    x.fill();
    x.font = '56px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = "#171614";
    x.fillText(icon, 64, 62);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    bubbleCache.set(key, t);
  }
  return t;
}

export function glowTexture(hex: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 30);
  const col = new THREE.Color(hex);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(0.4, `rgba(${rgb},.55)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
