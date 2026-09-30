// A small force layout (repulsion, springs, a pull to the middle) for the Brain's graph. Deterministic:
// the same graph always lands the same way, so the etched board and the full-screen view agree.

export interface Laid { x: number; y: number }

export function layout(n: number, links: [number, number][], iterations = 320): Laid[] {
  if (!n) return [];
  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const deg = new Float64Array(n);
  for (const [a, b] of links) { deg[a]++; deg[b]++; }
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963, r = 8 + 60 * Math.sqrt((i + 1) / n);
    x[i] = Math.cos(a) * r;
    y[i] = Math.sin(a) * r;
  }
  const k = 9;
  for (let it = 0; it < iterations; it++) {
    const temp = 7 * (1 - it / iterations) + 0.25;
    vx.fill(0);
    vy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[i] - x[j], dy = y[i] - y[j];
        const d2 = dx * dx + dy * dy + 0.01;
        const f = (k * k) / d2;
        vx[i] += dx * f; vy[i] += dy * f; vx[j] -= dx * f; vy[j] -= dy * f;
      }
    }
    for (const [i, j] of links) {
      const dx = x[i] - x[j], dy = y[i] - y[j];
      const d = Math.hypot(dx, dy) + 0.01, f = (d / k) * 0.9;
      vx[i] -= (dx / d) * f; vy[i] -= (dy / d) * f; vx[j] += (dx / d) * f; vy[j] += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      const g = 0.03 + 0.01 * Math.min(1, deg[i] / 12); // a firm pull to the middle keeps separate clusters close
      vx[i] -= x[i] * g;
      vy[i] -= y[i] * g;
      const v = Math.hypot(vx[i], vy[i]) || 1, s = Math.min(v, temp) / v;
      x[i] += vx[i] * s;
      y[i] += vy[i] * s;
    }
  }
  let R = 0;
  for (let i = 0; i < n; i++) R = Math.max(R, Math.hypot(x[i], y[i]));
  R = R || 1;
  return Array.from({ length: n }, (_, i) => ({ x: x[i] / R, y: y[i] / R }));
}
