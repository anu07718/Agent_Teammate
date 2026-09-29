/**
 * The office floor, drawn on a canvas in original pixel art.
 *
 * The scene is laid out on a 48×30 grid of 16px tiles and rendered at that logical size, then scaled
 * up without smoothing. Text (room names, speech bubbles, labels) is drawn afterwards at the display
 * resolution so it stays sharp. The engine only animates; the data comes from the event stream.
 */
import type { Agent, NEvent } from "../types";

export const TILE = 16;
export const GW = 48;
export const GH = 30;
export const LW = GW * TILE;
export const LH = GH * TILE;

interface Rect { x: number; y: number; w: number; h: number }
interface Room { id: string; name: string; r: Rect; floor: [string, string]; door: "top" | "bottom" | "left" | "right" }

export const ROOMS: Room[] = [
  { id: "front_desk", name: "Front Desk", r: { x: 1, y: 1, w: 11, h: 9 }, floor: ["#c9a882", "#bf9d77"], door: "bottom" },
  { id: "triage", name: "Triage", r: { x: 13, y: 1, w: 9, h: 9 }, floor: ["#3f7f7a", "#3a7672"], door: "bottom" },
  { id: "specialists", name: "Specialists", r: { x: 23, y: 1, w: 14, h: 9 }, floor: ["#44609c", "#405a92"], door: "bottom" },
  { id: "verification", name: "Verification Lab", r: { x: 38, y: 1, w: 9, h: 9 }, floor: ["#d9e1ea", "#cfd8e2"], door: "bottom" },
  { id: "decision", name: "Decision Room", r: { x: 38, y: 11, w: 9, h: 9 }, floor: ["#5d4b8f", "#574685"], door: "left" },
  { id: "vault", name: "Seal Vault", r: { x: 30, y: 21, w: 17, h: 8 }, floor: ["#3a3f4a", "#353a44"], door: "top" },
  { id: "comms", name: "Comms", r: { x: 15, y: 21, w: 14, h: 8 }, floor: ["#9c5b6f", "#925567"], door: "top" },
  { id: "compliance", name: "Compliance", r: { x: 1, y: 21, w: 13, h: 8 }, floor: ["#6b7280", "#646b78"], door: "top" },
  { id: "humans", name: "Human Desk", r: { x: 1, y: 11, w: 11, h: 9 }, floor: ["#4d7c53", "#48744e"], door: "right" },
];
export const BRAIN: Rect = { x: 14, y: 11, w: 22, h: 9 };

/** Where each agent sits (tile of the character's top-left). */
export const DESKS: Record<string, { x: number; y: number }> = {
  sentry: { x: 3, y: 4 }, pii: { x: 8, y: 4 },
  triage: { x: 16.5, y: 4 },
  upi: { x: 24.5, y: 4 }, refund: { x: 27.8, y: 4 }, fraud: { x: 31.1, y: 4 }, kyc: { x: 34.3, y: 4 },
  evidence: { x: 39.5, y: 3.5 }, shadow: { x: 43.3, y: 3.5 }, recheck: { x: 41.4, y: 6.6 },
  calibrator: { x: 39.6, y: 13.4 }, router: { x: 43.2, y: 15.8 },
  seal: { x: 32.5, y: 23.8 }, commit: { x: 36.2, y: 23.8 },
  guard: { x: 18, y: 23.8 }, responder: { x: 23.5, y: 23.8 },
  trail: { x: 3.8, y: 23.8 }, drift: { x: 8.8, y: 23.8 },
  human: { x: 5, y: 14.4 },
};
const SYSTEMS = ["UPI switch", "Core banking", "Refund engine", "CRM", "Wallet ledger", "Dispute desk", "Card & UPI control", "Messaging"];
export const RACKS = SYSTEMS.map((system, i) => ({ system, x: 39.6 + (i % 4) * 1.75, y: 22.2 + Math.floor(i / 4) * 3.1 }));

const SHIRT: Record<string, string> = {
  front_desk: "#5b7cfa", triage: "#14b8a6", specialists: "#f59e0b", verification: "#06b6d4", decision: "#8b5cf6",
  vault: "#e0a100", comms: "#ec4899", compliance: "#94a3b8", humans: "#22c55e",
};
const SKIN = ["#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#ffdbac", "#d4a373"];
const HAIR = ["#2b1b0e", "#4a2c17", "#121212", "#7a4a1e", "#b98b4e", "#3d2314"];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

interface Flight { from: { x: number; y: number }; to: { x: number; y: number }; t0: number; dur: number; label: string; color: string }
interface Walker { t0: number; label: string; color: string }
interface Wire { system: string; agent: string; t0: number; ok: boolean }

export class OfficeEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private scene: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private raf = 0;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  agents: Record<string, Agent> = {};
  hover: string | null = null;
  selected: string | null = null;
  private flights: Flight[] = [];
  private walkers: Walker[] = [];
  private wires: Wire[] = [];
  private lastDesk: Record<string, string> = {};
  private brainPulse = 0;
  private drift = false;
  private down = new Set<string>();
  private rackPulse: Record<string, { t: number; ok: boolean }> = {};
  private bubbles: Record<string, { text: string; t: number }> = {};
  graphSize = 40;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.base = document.createElement("canvas");
    this.base.width = LW;
    this.base.height = LH;
    this.scene = document.createElement("canvas");
    this.scene.width = LW;
    this.scene.height = LH;
    this.sctx = this.scene.getContext("2d")!;
    this.drawBase(this.base.getContext("2d")!);
    this.resize();
    const loop = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.scale = Math.min(this.canvas.width / LW, this.canvas.height / LH);
    this.ox = (this.canvas.width - LW * this.scale) / 2;
    this.oy = (this.canvas.height - LH * this.scale) / 2;
  }

  setAgents(list: Agent[]) {
    for (const a of list) {
      const prev = this.agents[a.id];
      if (a.status === "working" && a.doing && (!prev || prev.doing !== a.doing || prev.case_id !== a.case_id)) {
        this.bubbles[a.id] = { text: `${a.case_id ?? ""} · ${a.doing}`, t: performance.now() };
      }
      this.agents[a.id] = a;
    }
  }

  setDrift(alarm: boolean) {
    this.drift = alarm;
  }

  setDown(systems: string[]) {
    this.down = new Set(systems);
  }

  onEvent(ev: NEvent) {
    const now = performance.now();
    if (ev.kind === "case.created") {
      this.walkers.push({ t0: now, label: ev.case.id, color: ev.case.channel === "voice" ? "#f59e0b" : "#5b7cfa" });
      this.lastDesk[ev.case.id] = "door";
    } else if (ev.kind === "superstep" && ev.phase === "start" && ev.agents?.length) {
      const to = ev.agents[0];
      const fromId = this.lastDesk[ev.case_id] ?? "door";
      const from = fromId === "door" ? { x: 1.2 * TILE, y: 6.5 * TILE } : this.deskCenter(fromId);
      if (DESKS[to] && fromId !== to) {
        this.flights.push({ from, to: this.deskCenter(to), t0: now, dur: 520, label: ev.case_id, color: "#ffffff" });
      }
      this.lastDesk[ev.case_id] = to;
      if (ev.step === "evidence") this.brainPulse = now;
    } else if (ev.kind === "tool.called") {
      this.rackPulse[ev.system] = { t: now, ok: ev.ok };
      if (ev.agent && DESKS[ev.agent]) this.wires.push({ system: ev.system, agent: ev.agent, t0: now, ok: ev.ok });
    } else if (ev.kind === "approval.requested") {
      const from = this.deskCenter("seal");
      this.flights.push({ from, to: this.deskCenter("human"), t0: now, dur: 900, label: ev.case_id, color: "#ffd166" });
    }
  }

  /** Logical → display pixels. */
  private dx(x: number) { return this.ox + x * this.scale; }
  private dy(y: number) { return this.oy + y * this.scale; }

  deskCenter(id: string) {
    const d = DESKS[id];
    return { x: d.x * TILE + 8, y: d.y * TILE + 10 };
  }

  agentAt(clientX: number, clientY: number): string | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) * this.dpr - this.ox) / this.scale;
    const y = ((clientY - r.top) * this.dpr - this.oy) / this.scale;
    for (const [id, d] of Object.entries(DESKS)) {
      const px = d.x * TILE, py = d.y * TILE;
      if (x >= px - 3 && x <= px + 19 && y >= py - 2 && y <= py + 22) return id;
    }
    return null;
  }

  brainAt(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) * this.dpr - this.ox) / this.scale;
    const y = ((clientY - r.top) * this.dpr - this.oy) / this.scale;
    const cx = (BRAIN.x + BRAIN.w / 2) * TILE, cy = (BRAIN.y + BRAIN.h / 2) * TILE;
    return Math.hypot(x - cx, y - cy) < 48;
  }

  // ── static layer ─────────────────────────────────────────────────────────
  private drawBase(g: CanvasRenderingContext2D) {
    g.imageSmoothingEnabled = false;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      g.fillStyle = (x + y) % 2 ? "#2b2e35" : "#2f323a";
      g.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    // atrium carpet
    const b = BRAIN;
    g.fillStyle = "#1d2230";
    g.fillRect(b.x * TILE, b.y * TILE, b.w * TILE, b.h * TILE);
    g.strokeStyle = "#2b3350";
    g.lineWidth = 2;
    g.strokeRect(b.x * TILE + 3, b.y * TILE + 3, b.w * TILE - 6, b.h * TILE - 6);
    for (const room of ROOMS) this.drawRoom(g, room);
    // entrance door on the far left of the front desk
    g.fillStyle = "#1a1a1a";
    g.fillRect(0, 5 * TILE, 1 * TILE + 4, 3 * TILE);
    g.fillStyle = "#5b7cfa";
    g.fillRect(2, 5 * TILE + 2, 3, 3 * TILE - 4);
    // reception counter
    this.block(g, 2, 7.2, 9, 0.9, "#8a6a4a", "#6d5238");
    // waiting chairs
    for (let i = 0; i < 3; i++) this.block(g, 2 + i * 1.3, 8.6, 1, 0.8, "#4b5563", "#374151");
    // plants
    for (const [x, y] of [[11, 2], [21, 2], [36, 2], [46, 2], [46, 12], [1.2, 12], [13, 22], [28, 22], [46, 27]]) this.plant(g, x, y);
    // whiteboards
    this.board(g, 17.6, 1.2, 4);
    this.board(g, 42.4, 11.2, 4);
    // bookshelf in compliance
    this.block(g, 11, 21.3, 2.5, 1.3, "#6b4f35", "#533c28");
    // vault door
    g.fillStyle = "#6b7280";
    g.beginPath();
    g.arc(33.5 * TILE, 22.1 * TILE, 11, Math.PI, 0);
    g.fill();
    // desks (drawn per agent in the dynamic layer so the character can sit behind them)
    // racks
    for (const r of RACKS) {
      const x = r.x * TILE, y = r.y * TILE;
      g.fillStyle = "#15171c";
      g.fillRect(x, y, 22, 36);
      g.fillStyle = "#2a2e37";
      g.fillRect(x + 2, y + 2, 18, 32);
      for (let i = 0; i < 5; i++) {
        g.fillStyle = "#1c1f26";
        g.fillRect(x + 3, y + 4 + i * 6, 16, 4);
      }
    }
  }

  private drawRoom(g: CanvasRenderingContext2D, room: Room) {
    const { x, y, w, h } = room.r;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      g.fillStyle = (i + j) % 2 ? room.floor[0] : room.floor[1];
      g.fillRect((x + i) * TILE, (y + j) * TILE, TILE, TILE);
    }
    const X = x * TILE, Y = y * TILE, Wp = w * TILE, Hp = h * TILE;
    // back wall with depth
    g.fillStyle = "#e7e2d8";
    g.fillRect(X, Y, Wp, 14);
    g.fillStyle = "#cfc8ba";
    g.fillRect(X, Y + 11, Wp, 3);
    g.fillStyle = "#9a9384";
    g.fillRect(X, Y - 3, Wp, 3);
    // side and front walls
    g.fillStyle = "#8f887a";
    g.fillRect(X - 3, Y - 3, 3, Hp + 6);
    g.fillRect(X + Wp, Y - 3, 3, Hp + 6);
    g.fillRect(X - 3, Y + Hp, Wp + 6, 3);
    // door gap
    g.fillStyle = room.floor[0];
    const mid = (a: number, len: number) => a + len / 2 - 20;
    if (room.door === "bottom") g.fillRect(mid(X, Wp), Y + Hp, 40, 3);
    if (room.door === "top") {
      g.fillStyle = "#23262d";
      g.fillRect(mid(X, Wp), Y - 3, 40, 17);
      g.fillStyle = "#8f887a";
      g.fillRect(mid(X, Wp) - 2, Y - 3, 2, 17);
      g.fillRect(mid(X, Wp) + 40, Y - 3, 2, 17);
      g.fillStyle = "#5b7cfa";
      g.fillRect(mid(X, Wp) + 6, Y + 15, 28, 2);
    }
    if (room.door === "left") g.fillRect(X - 3, mid(Y, Hp), 3, 40);
    if (room.door === "right") g.fillRect(X + Wp, mid(Y, Hp), 3, 40);
  }

  private block(g: CanvasRenderingContext2D, tx: number, ty: number, tw: number, th: number, top: string, front: string) {
    const x = tx * TILE, y = ty * TILE, w = tw * TILE, h = th * TILE;
    g.fillStyle = top;
    g.fillRect(x, y, w, h * 0.6);
    g.fillStyle = front;
    g.fillRect(x, y + h * 0.6, w, h * 0.4);
  }

  private plant(g: CanvasRenderingContext2D, tx: number, ty: number) {
    const x = tx * TILE, y = ty * TILE;
    g.fillStyle = "#7c4a2b";
    g.fillRect(x + 4, y + 9, 8, 6);
    g.fillStyle = "#2f8f4e";
    g.fillRect(x + 2, y + 2, 12, 8);
    g.fillStyle = "#3fb463";
    g.fillRect(x + 4, y, 8, 6);
  }

  private board(g: CanvasRenderingContext2D, tx: number, ty: number, tw: number) {
    const x = tx * TILE, y = ty * TILE;
    g.fillStyle = "#f8fafc";
    g.fillRect(x, y, tw * TILE, 10);
    g.fillStyle = "#94a3b8";
    g.fillRect(x + 3, y + 3, 20, 1);
    g.fillRect(x + 3, y + 6, 32, 1);
  }

  // ── dynamic layer ────────────────────────────────────────────────────────
  private frame(t: number) {
    const g = this.sctx;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.base, 0, 0);
    this.drawBrain(g, t);
    this.drawRacks(g, t);
    for (const id of Object.keys(DESKS).sort((a, b) => DESKS[a].y - DESKS[b].y)) this.drawAgent(g, id, t);
    this.drawWalkers(g, t);
    this.drawWires(g, t);
    this.drawFlights(g, t);
    if (this.drift) {
      const room = ROOMS.find((r) => r.id === "compliance")!.r;
      g.fillStyle = `rgba(251,191,36,${0.1 + 0.08 * Math.sin(t / 200)})`;
      g.fillRect(room.x * TILE, room.y * TILE, room.w * TILE, room.h * TILE);
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#16181d";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.imageSmoothingEnabled = false;
    c.drawImage(this.scene, this.ox, this.oy, LW * this.scale, LH * this.scale);
    this.drawOverlay(c, t);
  }

  private drawBrain(g: CanvasRenderingContext2D, t: number) {
    const cx = (BRAIN.x + BRAIN.w / 2) * TILE, cy = (BRAIN.y + BRAIN.h / 2) * TILE + 4;
    const pulse = Math.max(0, 1 - (t - this.brainPulse) / 1200);
    const grd = g.createRadialGradient(cx, cy, 6, cx, cy, 70);
    grd.addColorStop(0, `rgba(109,139,255,${0.35 + pulse * 0.4})`);
    grd.addColorStop(1, "rgba(109,139,255,0)");
    g.fillStyle = grd;
    g.fillRect(cx - 80, cy - 70, 160, 140);
    g.fillStyle = "#3b4260";
    g.beginPath();
    g.ellipse(cx, cy + 6, 44, 20, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#4b5580";
    g.beginPath();
    g.ellipse(cx, cy + 2, 44, 20, 0, 0, Math.PI * 2);
    g.fill();
    const n = Math.min(18, Math.max(8, Math.round(this.graphSize / 4)));
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t / 4000 * (i % 2 ? 1 : -1);
      const r = 12 + (i % 3) * 9;
      pts.push([cx + Math.cos(a) * r * 1.6, cy + 2 + Math.sin(a) * r * 0.6]);
    }
    g.strokeStyle = `rgba(190,205,255,${0.35 + pulse * 0.5})`;
    g.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i * 5 + 3) % n];
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    for (const [x, y] of pts) {
      g.fillStyle = `rgba(232,179,57,${0.7 + pulse * 0.3})`;
      g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    }
  }

  private drawRacks(g: CanvasRenderingContext2D, t: number) {
    for (const r of RACKS) {
      const x = r.x * TILE, y = r.y * TILE;
      const p = this.rackPulse[r.system];
      const hot = p && t - p.t < 700;
      const down = this.down.has(r.system);
      for (let i = 0; i < 5; i++) {
        const on = down ? (Math.floor(t / 300) % 2 === 0) : hot ? (i + Math.floor(t / 60)) % 2 === 0 : (i + Math.floor(t / 900)) % 3 === 0;
        g.fillStyle = down ? (on ? "#ef4444" : "#4b1d1d") : hot ? (p!.ok ? "#4ade80" : "#ef4444") : on ? "#60a5fa" : "#1e3a5f";
        g.fillRect(x + 15, y + 5 + i * 6, 2, 2);
        g.fillRect(x + 11, y + 5 + i * 6, 2, 2);
      }
    }
  }

  private drawAgent(g: CanvasRenderingContext2D, id: string, t: number) {
    const d = DESKS[id];
    const a = this.agents[id];
    const px = Math.round(d.x * TILE), py = Math.round(d.y * TILE);
    const h = hash(id);
    const shirt = SHIRT[a?.department ?? "front_desk"] ?? "#5b7cfa";
    const skin = SKIN[h % SKIN.length], hair = HAIR[(h >> 3) % HAIR.length];
    const working = a?.status === "working";
    const waiting = a?.status === "waiting";
    const bob = working ? 0 : Math.floor((t + h) / 900) % 2;
    const armL = working ? (Math.floor(t / 120) % 2) : 0;
    const armR = working ? (Math.floor(t / 120 + 1) % 2) : 0;
    // highlight
    if (this.selected === id || this.hover === id) {
      g.fillStyle = this.selected === id ? "rgba(109,139,255,0.35)" : "rgba(255,255,255,0.16)";
      g.fillRect(px - 5, py - 3, 26, 30);
    }
    // chair
    g.fillStyle = "#31343c";
    g.fillRect(px + 1, py + 3, 14, 12);
    g.fillStyle = "#3d414b";
    g.fillRect(px + 2, py + 4, 12, 3);
    // body
    g.fillStyle = shirt;
    g.fillRect(px + 3, py + 8 + bob, 10, 8);
    g.fillStyle = shade(shirt, -0.12);
    g.fillRect(px + 3, py + 13 + bob, 10, 3);
    // arms
    if (waiting) {
      g.fillStyle = shirt;
      g.fillRect(px + 13, py + 1, 2, 8);
      g.fillStyle = skin;
      g.fillRect(px + 13, py - 1, 2, 2);
    } else {
      g.fillStyle = shirt;
      g.fillRect(px + 1, py + 9 + bob + armL, 2, 5);
      g.fillStyle = skin;
      g.fillRect(px + 1, py + 14 + bob + armL, 2, 2);
    }
    if (!waiting) {
      g.fillStyle = shirt;
      g.fillRect(px + 13, py + 9 + bob + armR, 2, 5);
      g.fillStyle = skin;
      g.fillRect(px + 13, py + 14 + bob + armR, 2, 2);
    }
    // head
    g.fillStyle = skin;
    g.fillRect(px + 4, py + 1 + bob, 8, 7);
    g.fillStyle = hair;
    g.fillRect(px + 4, py + bob, 8, 3);
    g.fillRect(px + 3, py + 1 + bob, 1, 4);
    g.fillRect(px + 12, py + 1 + bob, 1, 4);
    g.fillStyle = "#1b1b1b";
    const blinkNow = Math.floor((t + h * 7) / 180) % 25 === 0;
    if (!blinkNow) {
      g.fillRect(px + 6, py + 4 + bob, 1, 1);
      g.fillRect(px + 9, py + 4 + bob, 1, 1);
    }
    if (working && Math.floor(t / 250) % 2) {
      g.fillStyle = shade(skin, -0.25);
      g.fillRect(px + 7, py + 6 + bob, 2, 1);
    }
    if (working) { // screen light on the face
      g.fillStyle = "rgba(160,200,255,0.18)";
      g.fillRect(px + 4, py + 1 + bob, 8, 7);
    }
    // desk in front
    g.fillStyle = "#8a6a4a";
    g.fillRect(px - 4, py + 15, 24, 5);
    g.fillStyle = "#6d5238";
    g.fillRect(px - 4, py + 20, 24, 4);
    g.fillStyle = "#5a4330";
    g.fillRect(px - 3, py + 24, 2, 3);
    g.fillRect(px + 17, py + 24, 2, 3);
    // laptop
    g.fillStyle = "#2a2d35";
    g.fillRect(px - 3, py + 12, 7, 5);
    g.fillStyle = working ? (Math.floor(t / 300) % 2 ? "#7dd3fc" : "#60a5fa") : "#334155";
    g.fillRect(px - 2, py + 13, 5, 3);
    // mug
    g.fillStyle = "#e5e7eb";
    g.fillRect(px + 15, py + 14, 3, 3);
    if (id === "human" && waiting) {
      g.fillStyle = `rgba(248,113,113,${0.18 + 0.12 * Math.sin(t / 180)})`;
      g.fillRect(px - 8, py - 6, 32, 36);
    }
  }

  private drawWalkers(g: CanvasRenderingContext2D, t: number) {
    const dur = 1600;
    this.walkers = this.walkers.filter((w) => t - w.t0 < dur + 400);
    for (const w of this.walkers) {
      const k = Math.min(1, (t - w.t0) / dur);
      const x = 0.4 * TILE + k * 4.2 * TILE, y = 6.2 * TILE;
      const step = Math.floor(t / 140) % 2;
      g.globalAlpha = k >= 1 ? Math.max(0, 1 - (t - w.t0 - dur) / 400) : 1;
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(x, y + 15, 10, 2);
      g.fillStyle = "#1f2937";
      g.fillRect(x + 2, y + 10, 2, 5 - (k < 1 ? step : 0));
      g.fillRect(x + 6, y + 10, 2, 5 - (k < 1 ? 1 - step : 0));
      g.fillStyle = w.color;
      g.fillRect(x + 1, y + 4, 8, 7);
      g.fillStyle = SKIN[hash(w.label) % SKIN.length];
      g.fillRect(x + 2, y - 1, 6, 5);
      g.fillStyle = HAIR[hash(w.label) % HAIR.length];
      g.fillRect(x + 2, y - 2, 6, 2);
      g.globalAlpha = 1;
    }
  }

  private drawWires(g: CanvasRenderingContext2D, t: number) {
    this.wires = this.wires.filter((w) => t - w.t0 < 750);
    for (const w of this.wires) {
      const rack = RACKS.find((r) => r.system === w.system);
      if (!rack) continue;
      const a = this.deskCenter(w.agent);
      const k = 1 - (t - w.t0) / 750;
      g.strokeStyle = w.ok ? `rgba(74,222,128,${0.8 * k})` : `rgba(248,113,113,${0.8 * k})`;
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.lineDashOffset = -t / 30;
      g.beginPath();
      g.moveTo(rack.x * TILE + 11, rack.y * TILE + 2);
      const mx = (a.x + rack.x * TILE) / 2, my = Math.min(a.y, rack.y * TILE) - 30;
      g.quadraticCurveTo(mx, my, a.x, a.y - 6);
      g.stroke();
      g.setLineDash([]);
    }
  }

  private drawFlights(g: CanvasRenderingContext2D, t: number) {
    this.flights = this.flights.filter((f) => t - f.t0 < f.dur);
    for (const f of this.flights) {
      const k = (t - f.t0) / f.dur;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = f.from.x + (f.to.x - f.from.x) * e;
      const lift = Math.sin(Math.PI * e) * 26;
      const y = f.from.y + (f.to.y - f.from.y) * e - lift;
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(Math.round(x) - 3, Math.round(f.from.y + (f.to.y - f.from.y) * e) + 6, 7, 2);
      g.fillStyle = f.color;
      g.fillRect(Math.round(x) - 3, Math.round(y) - 4, 7, 9);
      g.fillStyle = "#94a3b8";
      g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 5, 1);
      g.fillRect(Math.round(x) - 2, Math.round(y), 4, 1);
      g.fillStyle = "#5b7cfa";
      g.fillRect(Math.round(x) - 3, Math.round(y) - 4, 7, 1);
    }
  }

  // ── crisp text on top ────────────────────────────────────────────────────
  private drawOverlay(c: CanvasRenderingContext2D, t: number) {
    const s = this.scale;
    c.textBaseline = "middle";
    // room plaques
    const fs = Math.max(11, 6.4 * s);
    c.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    for (const room of ROOMS) {
      const x = this.dx(room.r.x * TILE + 4), y = this.dy(room.r.y * TILE + 7);
      const w = c.measureText(room.name).width + fs;
      c.fillStyle = "rgba(20,22,28,0.82)";
      c.beginPath();
      c.roundRect(x, y - fs * 0.75, w, fs * 1.5, fs * 0.3);
      c.fill();
      c.fillStyle = "#f5f5f5";
      c.fillText(room.name, x + fs / 2, y + 0.5);
    }
    // brain label
    c.font = `600 ${Math.max(9, 5.4 * s)}px Inter, system-ui, sans-serif`;
    c.fillStyle = "rgba(200,212,255,0.9)";
    c.textAlign = "center";
    c.fillText("Brain · context graph + case memory", this.dx((BRAIN.x + BRAIN.w / 2) * TILE), this.dy((BRAIN.y + BRAIN.h) * TILE - 9));
    // rack labels
    c.font = `${Math.max(9, 4.4 * s)}px Inter, system-ui, sans-serif`;
    c.fillStyle = "rgba(226,232,240,0.85)";
    const SHORT: Record<string, string> = { "UPI switch": "UPI", "Core banking": "Core", "Refund engine": "Refund", CRM: "CRM",
      "Wallet ledger": "Wallet", "Dispute desk": "Dispute", "Card & UPI control": "Card/UPI", Messaging: "Msg" };
    for (const r of RACKS) c.fillText(SHORT[r.system] ?? r.system, this.dx(r.x * TILE + 11), this.dy(r.y * TILE + 42));
    c.textAlign = "left";
    // name tags on hover/selected and bubbles for working agents
    c.font = `500 ${Math.max(10, 5.2 * s)}px Inter, system-ui, sans-serif`;
    for (const [id, d] of Object.entries(DESKS)) {
      const a = this.agents[id];
      if (!a) continue;
      const cx = this.dx(d.x * TILE + 8), top = this.dy(d.y * TILE - 3);
      const bub = this.bubbles[id];
      const showBubble = bub && t - bub.t < 2400;
      if (a.status === "waiting") {
        this.bubble(c, cx, top, Math.floor(t / 400) % 2 ? "! approval needed" : "!", "#f87171", "#111");
      } else if (showBubble) {
        const text = bub.text.length > 34 ? bub.text.slice(0, 33) + "…" : bub.text;
        this.bubble(c, cx, top, text, "#f8fafc", "#0f172a");
      } else if (this.hover === id || this.selected === id) {
        this.bubble(c, cx, top, `${a.emoji} ${a.name}`, "#1e293b", "#f8fafc");
      }
    }
  }

  private bubble(c: CanvasRenderingContext2D, cx: number, bottom: number, text: string, bg: string, fg: string) {
    const padX = 7 * this.dpr, h = 19 * this.dpr;
    const w = c.measureText(text).width + padX * 2;
    const x = Math.max(4, Math.min(this.canvas.width - w - 4, cx - w / 2)), y = bottom - h - 6 * this.dpr;
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(x, y, w, h, 5 * this.dpr);
    c.fill();
    c.beginPath();
    c.moveTo(cx - 4 * this.dpr, y + h);
    c.lineTo(cx + 4 * this.dpr, y + h);
    c.lineTo(cx, y + h + 5 * this.dpr);
    c.fill();
    c.fillStyle = fg;
    c.fillText(text, x + padX, y + h / 2 + 0.5);
  }
}
