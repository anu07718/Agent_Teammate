// Connector wires: from each system's tile in the top bar, a thin branch drops to a junction, and one
// dashed trunk per department runs from there to a socket on the pod. The dashes crawl so the wiring
// reads as live; a real tool call sends a bright dot down the wire into the department that made it.
import type { OfficeScene } from "./scene";
import { POD_IDS, POD_STYLE, type PodId } from "./layout";

const NS = "http://www.w3.org/2000/svg";
const PORT: Record<PodId, "top" | "bottom" | "left" | "right"> = {
  intake: "top", resolution: "top", verification: "right", decision: "left", commit: "left", oversight: "top",
};

interface Conn { key: string; depts: string[]; status: string }
interface Trunk { pod: PodId; path: SVGPathElement; branch: SVGPathElement; jdot: SVGCircleElement; sock: SVGCircleElement; offset: number }
interface Pulse { el: SVGCircleElement; paths: SVGPathElement[]; born: number; dur: number }

export class Wires {
  private trunks: Trunk[] = [];
  private pulses: Pulse[] = [];
  private tiles = new Map<string, { x: number; y: number }>();
  private conns: Conn[] = [];
  private lastMeasure = 0;
  focused: PodId | "brain" | null = null;

  constructor(private svg: SVGSVGElement) {
    for (const pod of POD_IDS) {
      const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        svg.appendChild(el);
        return el;
      };
      const chip = POD_STYLE[pod].chip;
      const branch = mk("path", { fill: "none", stroke: chip, "stroke-width": "1.2", "stroke-dasharray": "2 5", "stroke-linecap": "round" });
      const path = mk("path", { fill: "none", stroke: chip, "stroke-width": "1.6", "stroke-dasharray": "3 8", "stroke-linecap": "round" });
      const jdot = mk("circle", { r: "2", fill: chip });
      const sock = mk("circle", { r: "2.8", fill: chip });
      this.trunks.push({ pod, path, branch, jdot, sock, offset: 0 });
    }
  }

  setConnectors(conns: Conn[]) {
    this.conns = conns;
    this.lastMeasure = 0;
  }

  private measure() {
    this.tiles.clear();
    const root = this.svg.getBoundingClientRect();
    document.querySelectorAll<HTMLElement>("[data-conn]").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) this.tiles.set(el.dataset.conn!, { x: r.left + r.width / 2 - root.left, y: r.bottom - root.top });
    });
  }

  private feeds(pod: PodId) {
    return this.conns.filter((c) => c.depts.includes(pod) && c.status === "connected" && this.tiles.has(c.key));
  }

  update(scene: OfficeScene, now: number) {
    if (now - this.lastMeasure > 500) {
      this.measure();
      this.lastMeasure = now;
    }
    const zoomFade = 1 - Math.min(1, Math.max(0, (scene.view.zoom - 1.4) / 0.8));
    this.trunks.forEach((t, i) => {
      const feeds = this.feeds(t.pod);
      const visible = feeds.length > 0;
      const lit = this.focused === t.pod;
      const a = !visible ? 0 : lit ? 0.9 : (this.focused && this.focused !== "brain" ? 0.08 : 0.5) * zoomFade;
      const [px, py] = scene.corner(t.pod, PORT[t.pod], 0.2);
      const xs = feeds.map((c) => this.tiles.get(c.key)!.x);
      const jx = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : px;
      const jy = 66 + i * 7;
      const bend = PORT[t.pod] === "left" ? -60 : PORT[t.pod] === "right" ? 60 : 0;
      t.path.setAttribute("d", `M ${jx} ${jy} C ${jx} ${jy + (py - jy) * 0.5}, ${px + bend} ${py - (py - jy) * 0.35}, ${px} ${py}`);
      t.branch.setAttribute("d", feeds.map((c) => {
        const p = this.tiles.get(c.key)!;
        return `M ${p.x} ${p.y + 2} C ${p.x} ${(p.y + jy) / 2}, ${jx} ${(p.y + jy) / 2}, ${jx} ${jy}`;
      }).join(" "));
      t.offset -= lit ? 0.35 : 0.15;
      t.path.setAttribute("stroke-dashoffset", String(t.offset));
      t.path.setAttribute("stroke-opacity", String(a));
      t.branch.setAttribute("stroke-opacity", String(a * 0.8));
      t.jdot.setAttribute("cx", String(jx));
      t.jdot.setAttribute("cy", String(jy));
      t.jdot.setAttribute("opacity", String(a));
      t.sock.setAttribute("cx", String(px));
      t.sock.setAttribute("cy", String(py));
      t.sock.setAttribute("opacity", String(a));
    });
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const k = (now - p.born) / p.dur;
      if (k >= 1) { p.el.remove(); p.paths[0].remove(); this.pulses.splice(i, 1); continue; }
      if (k < 0) continue;
      // along the branch for the first third, then down the trunk
      const [branch, trunk] = p.paths;
      const onBranch = k < 0.3;
      const path = onBranch ? branch : trunk;
      const kk = onBranch ? k / 0.3 : (k - 0.3) / 0.7;
      try {
        const len = path.getTotalLength();
        if (!len) continue;
        const pt = path.getPointAtLength(len * kk);
        p.el.setAttribute("cx", String(pt.x));
        p.el.setAttribute("cy", String(pt.y));
        p.el.setAttribute("opacity", String(k > 0.9 ? (1 - k) * 10 : 1));
      } catch { /* a path with no length yet */ }
    }
  }

  /** a tool on `connKey` was called for `pod`: a dot rides the wire into that department */
  pulse(connKey: string, pod: PodId) {
    const t = this.trunks.find((x) => x.pod === pod);
    const tile = this.tiles.get(connKey);
    if (!t || !tile) return;
    const branch = document.createElementNS(NS, "path");
    const d = t.path.getAttribute("d") || "";
    const m = /^M ([\d.-]+) ([\d.-]+)/.exec(d);
    if (!m) return;
    const [jx, jy] = [Number(m[1]), Number(m[2])];
    branch.setAttribute("d", `M ${tile.x} ${tile.y + 2} C ${tile.x} ${(tile.y + jy) / 2}, ${jx} ${(tile.y + jy) / 2}, ${jx} ${jy}`);
    branch.setAttribute("fill", "none");
    branch.setAttribute("stroke", "none");
    this.svg.appendChild(branch); // measurable only when attached
    const el = document.createElementNS(NS, "circle");
    el.setAttribute("r", "3.4");
    el.setAttribute("fill", POD_STYLE[pod].chip);
    el.setAttribute("stroke", "rgba(23,22,20,.55)");
    el.setAttribute("stroke-width", "1");
    this.svg.appendChild(el);
    this.pulses.push({ el, paths: [branch, t.path], born: performance.now(), dur: 1400 });
  }
}
