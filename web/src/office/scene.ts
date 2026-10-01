// The office scene: an isometric three.js diorama of six department pods around the Brain.
// React owns the words (cards, pills, panels); this owns the pixels and moves bound HTML elements so
// they stay pinned to the things they describe.
import * as THREE from "three";
import { BRAIN_SIZE, POD_IDS, POD_SIZE, POD_STYLE, SR, SU, LOOKS, podCentre, seat, type PodId } from "./layout";
import { Palette, bubbleTexture, chair, desk, glowTexture, person, plant, plinth, standPose, walkway, type Person, type Screen } from "./models";

export type Mode = "idle" | "working" | "waiting";
export interface SceneAgent { id: string; name: string; pod: PodId; lead: boolean }
export interface BrainNode { id: string; x: number; y: number; d: number }

interface AgentRT {
  a: SceneAgent;
  station: THREE.Group;
  p: Person;
  screen: Screen;
  world: THREE.Vector3;       // where the head is, for bubbles and the ⚠
  pin: THREE.Vector3;         // the same without the breathing bob, so name tags hold still
  seatPos: THREE.Vector3;
  mode: Mode;
  lines: string[];
  phase: number;
  standK: number;
  cheerUntil: number;
  slumpUntil: number;
  warn: THREE.Sprite;
  glance: number;
  glanceUntil: number;
}

interface Opts {
  panelWidth: () => number;
  railWidth: () => number;
  onAgent: (id: string) => void;
  onPod: (id: PodId) => void;
  onBrain: () => void;
  onEmpty: () => void;
  onFrame?: (s: OfficeScene, now: number) => void;
}

const FR = 40;
const ISO = new THREE.Vector3(1, 0.95, 1).normalize();
const TOP_BAR = 52;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// where each department's card sits relative to its pod: which corner, and which way it hangs
const CARD: Record<PodId, { corner: "top" | "bottom" | "left" | "right"; hang: "up" | "down" | "left" | "right" }> = {
  intake: { corner: "left", hang: "up" },
  resolution: { corner: "right", hang: "up" },
  verification: { corner: "right", hang: "down" },
  decision: { corner: "right", hang: "down" },
  commit: { corner: "left", hang: "down" },
  oversight: { corner: "left", hang: "up" },
};

export class OfficeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);
  readonly pal = new Palette();
  readonly agents: Record<string, AgentRT> = {};
  readonly view = { target: new THREE.Vector3(), zoom: 0.8 };
  focused: PodId | "brain" | null = null;
  dark = false;
  private tween: null | { t0: number; dur: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromZ: number; toZ: number } = null;
  private dimK = 0;
  private dimTarget = 0;
  private binds = new Map<string, HTMLElement>();
  private emotes: { s: THREE.Sprite; born: number }[] = [];
  private tickets: { s: THREE.Sprite; path: THREE.Vector3[]; lens: number[]; total: number; born: number; dur: number }[] = [];
  private glints: { s: THREE.Sprite; line?: THREE.Line; born: number; label?: HTMLElement; at: THREE.Vector3 }[] = [];
  private raf = 0;
  private ray = new THREE.Raycaster();
  private clickables: THREE.Object3D[] = [];
  private drag: null | { x: number; y: number; moved: boolean } = null;
  private pinch: null | { d: number; zoom: number } = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private ground: THREE.Mesh;
  private brainCanvas = document.createElement("canvas");
  private brainTex: THREE.CanvasTexture;
  private brainBoard: THREE.Sprite;
  private brainNodes: BrainNode[] = [];
  private brainLinks: [number, number][] = [];
  private brainIndex = new Map<string, number>();
  private glowTex = new Map<string, THREE.Texture>();
  private userMoved = false;
  private disposed = false;

  constructor(private host: HTMLElement, private overlay: HTMLElement, private opts: Opts) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "o-canvas";
    host.appendChild(this.renderer.domElement);

    this.hemi = new THREE.HemisphereLight(0xfdfdf6, 0xd6d2c6, 0.95);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff3e2, 2.1);
    this.key.position.set(-55, 95, 25);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, far: 400 });
    this.key.shadow.bias = -0.0005;
    this.key.shadow.radius = 5;
    this.scene.add(this.key);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.12 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -1.7;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.brainCanvas.width = 1024;
    this.brainCanvas.height = 620;
    this.brainTex = new THREE.CanvasTexture(this.brainCanvas);
    this.brainTex.colorSpace = THREE.SRGBColorSpace;
    this.brainBoard = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.brainTex, transparent: true, depthWrite: false }));
    this.brainBoard.scale.set(16, 9.6, 1);
    this.brainBoard.position.set(0, 2.2, 0);
    this.brainBoard.renderOrder = 4;
    this.brainBoard.userData.owner = "brain";

    this.buildWorld();
    this.bindInput();
    this.resize();
    this.view.target.copy(this.overviewTarget());
    this.view.zoom = this.overviewZoom();
    window.addEventListener("resize", this.resize);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ── building ──────────────────────────────────────────────────────────────
  private buildWorld() {
    const side = "#efeee7";
    const brain = plinth(this.pal, "brain", BRAIN_SIZE, POD_STYLE.brain.floor, side);
    this.scene.add(brain);
    this.clickables.push(brain);
    this.scene.add(this.brainBoard);
    const bp = plant(this.pal, "brain");
    bp.position.set(BRAIN_SIZE / 2 - 1.8, 0.1, -BRAIN_SIZE / 2 + 1.8);
    this.scene.add(bp);
    for (const id of POD_IDS) {
      const [x, z] = podCentre(id);
      const g = plinth(this.pal, id, POD_SIZE, POD_STYLE[id].floor, side);
      g.position.set(x, 0, z);
      this.scene.add(g);
      this.clickables.push(g);
      // a walkway from the Brain's edge to the pod's edge, along the line between their centres
      const len = Math.hypot(x, z);
      const ux = x / len, uz = z / len;
      const edge = (half: number) => half / Math.max(Math.abs(ux), Math.abs(uz));
      this.scene.add(walkway(this.pal, [ux * edge(BRAIN_SIZE / 2 - 0.3), uz * edge(BRAIN_SIZE / 2 - 0.3)],
        [x - ux * edge(POD_SIZE / 2 - 0.3), z - uz * edge(POD_SIZE / 2 - 0.3)], "#e9e8e0"));
      // a plant on the pod's outer corner
      const pl = plant(this.pal, id);
      const ox = Math.sign(x) || 1, oz = Math.sign(z) || 1;
      pl.position.set(x + ox * (POD_SIZE / 2 - 1.6), 0.1, z + oz * (POD_SIZE / 2 - 1.6));
      this.scene.add(pl);
    }
  }

  setAgents(list: SceneAgent[]) {
    const byPod: Record<string, SceneAgent[]> = {};
    for (const a of list) (byPod[a.pod] ||= []).push(a);
    for (const pod of POD_IDS) {
      const mine = (byPod[pod] || []).sort((a, b) => Number(b.lead) - Number(a.lead));
      mine.forEach((a, i) => {
        if (this.agents[a.id]) return;
        const [x, z] = seat(pod, i);
        const st = new THREE.Group();
        st.position.set(x, 0.12, z);
        st.rotation.y = Math.PI / 4; // the desk's front faces the camera
        const { group: d, screen } = desk(this.pal, pod, POD_STYLE[pod].chip);
        st.add(d);
        const ch = chair(this.pal, pod);
        ch.position.set(0, 0, 1.75);
        st.add(ch);
        const look = LOOKS[a.id] || { hair: "#222", skin: "#e0b08a" };
        const shirt = new THREE.Color(POD_STYLE[pod].chip).lerp(new THREE.Color("#3a3a40"), 0.35).getStyle();
        const p = person(this.pal, pod, look, shirt, a.lead);
        p.root.position.set(0, 0, 1.75);
        p.root.traverse((o) => { o.userData.agent = a.id; });
        st.add(p.root);
        this.scene.add(st);
        this.clickables.push(st);
        const warn = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTexture("⚠️", true), depthTest: false, transparent: true }));
        warn.visible = false;
        warn.renderOrder = 60;
        this.scene.add(warn);
        this.agents[a.id] = {
          a, station: st, p, screen, world: new THREE.Vector3(x, 5.6, z), pin: new THREE.Vector3(x, 5.6, z), seatPos: new THREE.Vector3(x, 1.2, z),
          mode: "idle", lines: [], phase: Math.random() * 10, standK: 0, cheerUntil: 0, slumpUntil: 0, warn,
          glance: 0, glanceUntil: 0,
        };
      });
    }
  }

  // ── what agents are doing ─────────────────────────────────────────────────
  setMode(id: string, mode: Mode) {
    const r = this.agents[id];
    if (!r || r.mode === mode) return;
    r.mode = mode;
    r.warn.visible = mode === "waiting";
    r.screen.set(r.lines, mode);
  }

  pushLine(id: string, line: string) {
    const r = this.agents[id];
    if (!r) return;
    r.lines = [...r.lines.slice(-3), line];
    r.screen.set(r.lines, r.mode);
  }

  cheer(id: string) { const r = this.agents[id]; if (r) r.cheerUntil = performance.now() + 2400; }
  slump(id: string) { const r = this.agents[id]; if (r) r.slumpUntil = performance.now() + 2400; }

  emote(id: string, icon: string) {
    const r = this.agents[id];
    if (!r) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTexture(icon), depthTest: false, transparent: true }));
    s.position.copy(r.world).add(new THREE.Vector3(0.6, 0.6, 0));
    s.scale.set(2.6, 2.6, 1);
    s.renderOrder = 70;
    this.scene.add(s);
    this.emotes.push({ s, born: performance.now() });
  }

  private glow(hex: string) {
    let t = this.glowTex.get(hex);
    if (!t) { t = glowTexture(hex); this.glowTex.set(hex, t); }
    return t;
  }

  /** a glowing case token that walks from one desk to another through the Brain */
  ticket(from: string, to: string, hex = "#f2b33d") {
    const a = this.agents[from], b = this.agents[to];
    if (!a || !b || from === to) return;
    const pts = [a.seatPos.clone()];
    if (a.a.pod !== b.a.pod) {
      const [ax, az] = podCentre(a.a.pod), [bx, bz] = podCentre(b.a.pod);
      pts.push(new THREE.Vector3(ax, 1.2, az), new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(bx, 1.2, bz));
    }
    pts.push(b.seatPos.clone());
    const lens = pts.slice(1).map((p, i) => p.distanceTo(pts[i]));
    const total = lens.reduce((s, x) => s + x, 0);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(hex), depthTest: false, transparent: true }));
    s.scale.set(2.2, 2.2, 1);
    s.renderOrder = 65;
    this.scene.add(s);
    this.tickets.push({ s, path: pts, lens, total, born: performance.now(), dur: 900 + total * 14 });
  }

  // ── the Brain board ───────────────────────────────────────────────────────
  setBrain(nodes: BrainNode[], links: [number, number][]) {
    this.brainNodes = nodes;
    this.brainLinks = links;
    this.brainIndex = new Map(nodes.map((n, i) => [n.id, i]));
    this.drawBrain();
  }

  private drawBrain(fresh?: Set<string>) {
    const x = this.brainCanvas.getContext("2d")!;
    const W = this.brainCanvas.width, H = this.brainCanvas.height;
    x.clearRect(0, 0, W, H);
    const ink = this.dark ? "236,235,228" : "23,22,20";
    const P = (n: BrainNode) => [W / 2 + n.x * W * 0.42, H / 2 + n.y * H * 0.4];
    x.lineWidth = 5;
    x.strokeStyle = `rgba(${ink},.26)`;
    for (const [a, b] of this.brainLinks) {
      const A = this.brainNodes[a], B = this.brainNodes[b];
      if (!A || !B) continue;
      const [x1, y1] = P(A), [x2, y2] = P(B);
      x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
    }
    for (const n of this.brainNodes) {
      const [px, py] = P(n);
      x.fillStyle = fresh?.has(n.id) ? "#1f8f6a" : `rgba(${ink},.5)`;
      x.beginPath(); x.arc(px, py, 9 + Math.sqrt(n.d) * 4, 0, Math.PI * 2); x.fill();
    }
    this.brainTex.needsUpdate = true;
  }

  private brainWorld(n: BrainNode) {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    return this.brainBoard.position.clone()
      .addScaledVector(right, n.x * 0.84 * 7.5)
      .addScaledVector(up, -n.y * 0.8 * 4.5);
  }

  /** an agent read these nodes: each glints, with a dashed line to the desk and a small label */
  brainRead(agentId: string, ids: string[], labelOf: (id: string) => string) {
    const r = this.agents[agentId];
    ids.slice(0, 4).forEach((id, k) => {
      const i = this.brainIndex.get(id);
      if (i === undefined) return;
      setTimeout(() => {
        const at = this.brainWorld(this.brainNodes[i]);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow("#1f8f6a"), depthTest: false, transparent: true }));
        s.position.copy(at);
        s.renderOrder = 62;
        this.scene.add(s);
        let line: THREE.Line | undefined;
        if (r) {
          const geo = new THREE.BufferGeometry().setFromPoints([at, r.world.clone().setY(3)]);
          line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x1f8f6a, dashSize: 0.8, gapSize: 0.6, transparent: true, depthTest: false }));
          line.computeLineDistances();
          line.renderOrder = 61;
          this.scene.add(line);
        }
        let label: HTMLElement | undefined;
        if (k === 0) {
          label = document.createElement("div");
          label.className = "o-readlab";
          label.textContent = `${r ? r.a.name : agentId} read ${labelOf(id)}`;
          this.overlay.appendChild(label);
        }
        this.glints.push({ s, line, born: performance.now(), label, at });
      }, k * 260);
    });
  }

  // ── HTML bound to the scene ───────────────────────────────────────────────
  bind(key: string, el: HTMLElement | null) {
    if (el) this.binds.set(key, el);
    else this.binds.delete(key);
  }

  project(p: THREE.Vector3): [number, number] {
    const v = p.clone().project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.host.clientWidth, (-v.y * 0.5 + 0.5) * this.host.clientHeight];
  }

  /** a pod's corner on screen (top = the corner furthest from the camera) */
  corner(pod: PodId | "brain", which: "top" | "bottom" | "left" | "right", y = 0.3) {
    const [x, z] = podCentre(pod);
    const h = (pod === "brain" ? BRAIN_SIZE : POD_SIZE) / 2 - 0.4;
    const d = { top: [-h, -h], bottom: [h, h], left: [-h, h], right: [h, -h] }[which];
    return this.project(new THREE.Vector3(x + d[0], y, z + d[1]));
  }

  // ── camera ────────────────────────────────────────────────────────────────
  private ppw(zoom = this.view.zoom) { return zoom * this.host.clientHeight / (2 * FR); }

  private free() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const right = this.opts.panelWidth() + 36;
    return { W, H, right, availW: W - right - 24, availH: H - TOP_BAR - 24 };
  }

  overviewZoom() {
    const { H, availW, availH } = this.free();
    const ppw = Math.min(availW / 112, availH / 104);
    return clamp(ppw * 2 * FR / H, 0.42, 1.25);
  }

  /** a camera target that shows `centre` dxPx right of and dyPx below the middle of the screen */
  private shifted(centre: THREE.Vector3, zoom: number, dxPx: number, dyPx: number) {
    const ppw = this.ppw(zoom);
    const sr = new THREE.Vector3(SR[0], 0, SR[1]);
    const su = new THREE.Vector3(SU[0], 0, SU[1]).multiplyScalar(1 / 0.557);
    // moving the target right makes the scene appear to move left; moving it up, down
    return centre.clone().addScaledVector(sr, -dxPx / ppw).addScaledVector(su, dyPx / ppw);
  }

  overviewTarget(zoom = this.overviewZoom()) {
    const { W, right } = this.free();
    // centre the ring in the space left of the panel, a touch below the bar
    const dx = (W - right) / 2 - W / 2;
    return this.shifted(new THREE.Vector3(0, 0, 0), zoom, dx, TOP_BAR / 2 + 6);
  }

  private flyTo(target: THREE.Vector3, zoom: number, dur = 750) {
    this.tween = { t0: performance.now(), dur, fromT: this.view.target.clone(), toT: target, fromZ: this.view.zoom, toZ: zoom };
  }

  overview() {
    this.focused = null;
    this.dimTarget = 0;
    this.userMoved = false;
    const z = this.overviewZoom();
    this.flyTo(this.overviewTarget(z), z, 650);
  }

  focus(pod: PodId | "brain") {
    this.focused = pod;
    this.dimTarget = pod === "brain" ? 0 : 1;
    const { W, H, right } = this.free();
    const rail = pod === "brain" ? 0 : this.opts.railWidth() + 30;
    const zoom = clamp((Math.min((W - rail - right - 40) / 30, (H - TOP_BAR - 40) / 26) * 2 * FR) / H, 1.2, 3.4);
    const [x, z] = podCentre(pod);
    const dx = rail + (W - rail - right) / 2 - W / 2;
    this.flyTo(this.shifted(new THREE.Vector3(x, 0, z), zoom, dx, TOP_BAR / 2), zoom, 850);
  }

  zoomBy(f: number) {
    const z = clamp(this.view.zoom * f, 0.4, 5);
    this.userMoved = true;
    this.flyTo(this.view.target.clone(), z, 300);
  }

  private applyCamera() {
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    Object.assign(this.camera, { left: -FR * aspect, right: FR * aspect, top: FR, bottom: -FR, zoom: this.view.zoom });
    this.camera.position.copy(this.view.target).addScaledVector(ISO, 220);
    this.camera.lookAt(this.view.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  resize = () => {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    if (!this.focused && !this.userMoved && !this.tween) {
      this.view.zoom = this.overviewZoom();
      this.view.target.copy(this.overviewTarget(this.view.zoom));
    }
    this.applyCamera();
  };

  // ── input ─────────────────────────────────────────────────────────────────
  private worldAt(px: number, py: number) {
    const el = this.renderer.domElement;
    const nx = (px / el.clientWidth) * 2 - 1, ny = -(py / el.clientHeight) * 2 + 1;
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.tween = null;
      this.userMoved = true;
      const r = el.getBoundingClientRect();
      const before = this.worldAt(e.clientX - r.left, e.clientY - r.top);
      this.view.zoom = clamp(this.view.zoom * Math.exp(-e.deltaY * 0.0028), 0.4, 5);
      this.applyCamera();
      const after = this.worldAt(e.clientX - r.left, e.clientY - r.top);
      if (before && after) this.view.target.add(before.sub(after));
      if (this.view.zoom < 1.05 && this.focused && this.focused !== "brain") this.opts.onEmpty();
    }, { passive: false });
    el.addEventListener("pointerdown", (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.view.zoom };
      } else this.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.view.zoom = clamp(this.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d, 0.4, 5);
        this.userMoved = true;
        return;
      }
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.tween = null;
        this.userMoved = true;
        const r = el.getBoundingClientRect();
        const a = this.worldAt(this.drag.x - r.left, this.drag.y - r.top), b = this.worldAt(e.clientX - r.left, e.clientY - r.top);
        if (a && b) this.view.target.add(a.sub(b));
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved || e.type !== "pointerup") return;
      this.click(e.clientX, e.clientY);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("dblclick", (e) => {
      const hit = this.hit(e.clientX, e.clientY);
      if (!hit) this.opts.onEmpty();
    });
  }

  private hit(cx: number, cy: number) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const nx = ((cx - r.left) / r.width) * 2 - 1, ny = -((cy - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = this.ray.intersectObjects(this.clickables, true);
    return hits[0]?.object ?? null;
  }

  private click(cx: number, cy: number) {
    const o = this.hit(cx, cy);
    if (!o) return;
    if (o.userData.agent) return this.opts.onAgent(o.userData.agent);
    const owner = o.userData.owner;
    if (owner === "brain") return this.opts.onBrain();
    if (POD_IDS.includes(owner)) this.opts.onPod(owner);
  }

  // ── looks ─────────────────────────────────────────────────────────────────
  setDark(on: boolean) {
    this.dark = on;
    const side = on ? "#2c2d2a" : "#efeee7", walk = on ? "#30322f" : "#e9e8e0";
    for (const e of this.pal.entries) {
      const hex = "#" + e.base.getHexString();
      if (["#efeee7", "#2c2d2a"].includes(hex)) e.base.set(side);
      if (["#e9e8e0", "#30322f"].includes(hex)) e.base.set(walk);
    }
    for (const id of [...POD_IDS, "brain" as const]) {
      const s = POD_STYLE[id];
      const darkFloor = new THREE.Color(s.chip).lerp(new THREE.Color("#1c1d1b"), id === "brain" ? 0.9 : 0.74);
      for (const e of this.pal.entries) {
        if (e.owner !== id) continue;
        const hex = "#" + e.base.getHexString();
        if (hex === s.floor.toLowerCase() || e.mat.userData.floor) {
          e.mat.userData.floor = true;
          e.base.set(on ? darkFloor : new THREE.Color(s.floor));
        }
      }
    }
    for (const e of this.pal.entries) e.mat.color.copy(e.base);
    this.hemi.color.set(on ? 0x9098a6 : 0xfdfdf6);
    this.hemi.groundColor.set(on ? 0x15161a : 0xd6d2c6);
    this.hemi.intensity = on ? 0.8 : 0.95;
    this.key.intensity = on ? 1.5 : 2.1;
    (this.ground.material as THREE.ShadowMaterial).opacity = on ? 0.35 : 0.12;
    this.drawBrain();
  }

  // ── the frame ─────────────────────────────────────────────────────────────
  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = 1 / 60;
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      const e = ease(k);
      this.view.target.lerpVectors(this.tween.fromT, this.tween.toT, e);
      this.view.zoom = this.tween.fromZ + (this.tween.toZ - this.tween.fromZ) * e;
      if (k >= 1) this.tween = null;
    }
    this.applyCamera();
    this.tickDim(dt);
    this.tickAgents(now, dt);
    this.tickFx(now);
    this.placeBinds();
    this.opts.onFrame?.(this, now);
    this.renderer.render(this.scene, this.camera);
  };

  private tickDim(dt: number) {
    const prev = this.dimK;
    this.dimK += (this.dimTarget - this.dimK) * (1 - Math.exp(-dt * 6));
    if (Math.abs(prev - this.dimK) < 1e-4 && this.dimK === this.dimTarget) return;
    const grey = new THREE.Color();
    for (const e of this.pal.entries) {
      const lit = e.owner === this.focused;
      const l = (e.base.r + e.base.g + e.base.b) / 3;
      grey.setRGB(l * 0.42 + 0.1, l * 0.42 + 0.1, l * 0.4 + 0.09);
      e.mat.color.copy(e.base).lerp(grey, lit ? 0 : this.dimK * 0.85);
    }
    (this.brainBoard.material as THREE.SpriteMaterial).opacity = 1 - 0.7 * this.dimK;
  }

  private tickAgents(now: number, dt: number) {
    this.scene.updateMatrixWorld();
    for (const r of Object.values(this.agents)) {
      const { p } = r;
      const t = now / 1000 + r.phase;
      const waiting = r.mode === "waiting";
      const cheer = now < r.cheerUntil, slump = now < r.slumpUntil;
      const standGoal = waiting || cheer ? 1 : 0;
      r.standK += (standGoal - r.standK) * (1 - Math.exp(-dt * 5));
      standPose(p, r.standK);
      // standing agents step out beside the desk and turn to face the camera
      p.root.position.x = 2.9 * r.standK;
      p.root.position.z = 1.75 + 0.6 * r.standK;
      p.root.rotation.y = Math.PI * r.standK;
      p.body.rotation.x = slump ? 0.35 : r.mode === "working" ? 0.12 : 0;
      if (cheer) {
        p.armL.rotation.set(0, 0, -2.6 + Math.sin(t * 9) * 0.15);
        p.armR.rotation.set(0, 0, 2.6 + Math.sin(t * 9 + 1) * 0.15);
      } else if (waiting) {
        p.armL.rotation.set(0, 0, -0.15);
        p.armR.rotation.set(0, 0, 2.5 + Math.sin(t * 7) * 0.45);
      } else if (r.mode === "working") {
        p.armL.rotation.set(1.15 + Math.sin(t * 14) * 0.08, 0, -0.12);
        p.armR.rotation.set(1.15 + Math.sin(t * 14 + 2) * 0.08, 0, 0.12);
        p.head.rotation.set(0.1 + Math.sin(t * 2) * 0.04, 0, 0);
      } else {
        // idle: hands on the desk, now and then a glance around
        p.armL.rotation.set(0.9, 0, -0.1);
        p.armR.rotation.set(0.9 + (Math.sin(t * 0.7) > 0.93 ? 0.8 : 0), 0, 0.1);
        if (now > r.glanceUntil) {
          r.glance = Math.random() < 0.4 ? (Math.random() - 0.5) * 1.2 : 0;
          r.glanceUntil = now + 2500 + Math.random() * 4000;
        }
        p.head.rotation.y += (r.glance - p.head.rotation.y) * (1 - Math.exp(-dt * 3));
      }
      r.pin.copy(p.head.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 1.3, 0));
      p.body.position.y += Math.sin(t * 2.1) * 0.015;
      // where the head is now, for bubbles and the ⚠
      r.world.copy(p.head.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 1.3, 0));
      if (waiting) {
        r.warn.position.copy(r.world).add(new THREE.Vector3(0, 0.8, 0));
        const k = 2.3 + Math.sin(now / 240) * 0.35;
        r.warn.scale.set(k, k, 1);
      }
    }
  }

  private tickFx(now: number) {
    for (let i = this.emotes.length - 1; i >= 0; i--) {
      const e = this.emotes[i], age = (now - e.born) / 1800;
      if (age >= 1) {
        this.scene.remove(e.s);
        e.s.material.dispose();
        this.emotes.splice(i, 1);
        continue;
      }
      e.s.position.y += 0.03;
      e.s.material.opacity = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
    }
    for (let i = this.tickets.length - 1; i >= 0; i--) {
      const tk = this.tickets[i];
      const k = (now - tk.born) / tk.dur;
      if (k >= 1) {
        this.scene.remove(tk.s);
        tk.s.material.dispose();
        this.tickets.splice(i, 1);
        continue;
      }
      let d = ease(k) * tk.total, j = 0;
      while (j < tk.lens.length - 1 && d > tk.lens[j]) { d -= tk.lens[j]; j++; }
      tk.s.position.lerpVectors(tk.path[j], tk.path[j + 1], tk.lens[j] ? Math.min(1, d / tk.lens[j]) : 1);
      tk.s.material.opacity = k > 0.9 ? (1 - k) * 10 : 1;
    }
    for (let i = this.glints.length - 1; i >= 0; i--) {
      const g = this.glints[i], k = (now - g.born) / 2200;
      if (k >= 1) {
        this.scene.remove(g.s);
        if (g.line) this.scene.remove(g.line);
        g.label?.remove();
        this.glints.splice(i, 1);
        continue;
      }
      const a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      g.s.material.opacity = a;
      const sc = 1.2 + k * 2;
      g.s.scale.set(sc, sc, 1);
      if (g.line) (g.line.material as THREE.LineDashedMaterial).opacity = 0.85 * a;
      if (g.label) {
        const [x, y] = this.project(g.at);
        g.label.style.transform = `translate(${x}px,${y - 16}px) translate(-50%,-100%)`;
        g.label.style.opacity = String(a);
      }
    }
  }

  private placeBinds() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const rightEdge = W - this.opts.panelWidth() - 30;
    const z = this.view.zoom;
    const cardScale = 1 - 0.28 * smooth(1.1, 2.6, z);
    const pillScale = 0.66 + 0.34 * smooth(0.9, 2.2, z);
    const pills: { el: HTMLElement; x: number; y: number; w: number; h: number }[] = [];
    for (const [key, el] of this.binds) {
      const [kind, id] = key.split(":");
      if (kind === "pod") {
        const pod = id as PodId;
        const cfg = CARD[pod];
        let [x, y] = this.corner(pod, cfg.corner, 0.6);
        const w = el.offsetWidth * cardScale, h = el.offsetHeight * cardScale;
        const off = 14;
        let tx = "-50%", ty = "-50%";
        if (cfg.hang === "up") { ty = "-100%"; y -= off; }
        if (cfg.hang === "down") { ty = "0%"; y += off; }
        if (cfg.corner === "left") { tx = "-100%"; x -= off; }
        if (cfg.corner === "right") { tx = "0%"; x += off; }
        if (cfg.corner === "top" || cfg.corner === "bottom") tx = "-50%";
        // keep every card on screen, clear of the bar and the panel
        const left = x - (tx === "-100%" ? w : tx === "-50%" ? w / 2 : 0);
        const top = y - (ty === "-100%" ? h : ty === "-50%" ? h / 2 : 0);
        const cl = clamp(left, 8, rightEdge - w), ct = clamp(top, TOP_BAR + 10, H - h - 8);
        el.style.transform = `translate(${cl}px,${ct}px) scale(${cardScale})`;
        const dimmed = this.focused && this.focused !== "brain";
        const underRail = dimmed && cl < this.opts.railWidth() + 20; // a card the rail would half cover
        el.style.opacity = dimmed ? (pod === this.focused || underRail ? "0" : String(1 - 0.8 * this.dimK)) : "1";
        el.style.pointerEvents = dimmed && (pod === this.focused || underRail) ? "none" : "auto";
      } else if (kind === "agent") {
        const r = this.agents[id];
        if (!r) continue;
        const [x, y] = this.project(r.pin.clone().add(new THREE.Vector3(0, r.a.lead ? 0.35 : 0, 0)));
        pills.push({ el, x, y, w: el.offsetWidth * pillScale, h: el.offsetHeight * pillScale });
        const dim = this.focused && this.focused !== "brain" && r.a.pod !== this.focused;
        el.style.opacity = dim ? String(1 - 0.85 * this.dimK) : "1";
      } else if (kind === "brain") {
        const [x, y] = this.corner("brain", "top", 0.5);
        el.style.transform = `translate(${x}px,${y - 10}px) translate(-50%,-100%)`;
        el.style.opacity = this.focused && this.focused !== "brain" ? String(1 - 0.8 * this.dimK) : "1";
      }
    }
    // Desks sit close together when the whole office is in view, so name tags would cover each other.
    // Lowest tag first; any tag that would overlap one already placed moves up above it.
    pills.sort((a, b) => b.y - a.y);
    const placed: typeof pills = [];
    for (const p of pills) {
      for (let tries = 0; tries < pills.length; tries++) {
        const hit = placed.find((q) => Math.abs(p.x - q.x) < (p.w + q.w) / 2 + 3 && p.y > q.y - q.h - 2 && p.y - p.h < q.y + 2);
        if (!hit) break;
        p.y = hit.y - hit.h - 2;
      }
      placed.push(p);
      p.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px) translate(-50%,-100%) scale(${pillScale})`;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    for (const g of this.glints) g.label?.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
