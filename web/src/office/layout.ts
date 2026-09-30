// Where everything sits in the office: six department pods in a ring around the Brain, desks inside
// each pod, and the colours each department wears. Positions are given in screen terms (right, up)
// and converted to the ground plane, so the ring reads as a ring from the isometric camera.

export type PodId = "intake" | "resolution" | "verification" | "decision" | "commit" | "oversight";
export const POD_IDS: PodId[] = ["intake", "resolution", "verification", "decision", "commit", "oversight"];

export interface PodStyle {
  name: string;
  chip: string;   // the department's colour: dots, wires, avatars
  floor: string;  // the pod's floor
  ink: string;    // text on a light chip
}

export const POD_STYLE: Record<PodId | "brain", PodStyle> = {
  intake: { name: "INTAKE", chip: "#4fcf9f", floor: "#e5f4ec", ink: "#157656" },
  resolution: { name: "RESOLUTION", chip: "#e6cf6e", floor: "#f6efd3", ink: "#86700f" },
  verification: { name: "VERIFICATION", chip: "#78c0ec", floor: "#e2f0f9", ink: "#1f6b94" },
  decision: { name: "DECISION", chip: "#b192df", floor: "#eee7f8", ink: "#65419c" },
  commit: { name: "COMMIT & REPLY", chip: "#8b98ef", floor: "#e7eafb", ink: "#4652bd" },
  oversight: { name: "OVERSIGHT", chip: "#ea8b86", floor: "#fae6e3", ink: "#b24c47" },
  brain: { name: "THE BRAIN", chip: "#bcd1b6", floor: "#e6eee1", ink: "#46704e" },
};

// screen-space centres of the pods (x right, y up), in world units at zoom 1
const SCREEN: Record<PodId | "brain", [number, number]> = {
  brain: [0, 0],
  intake: [0, 27.5],
  resolution: [31.5, 13.5],
  verification: [31.5, -13.5],
  decision: [0, -27.5],
  commit: [-31.5, -13.5],
  oversight: [-31.5, 13.5],
};
// the camera looks down from (1, 0.95, 1): ground distances toward the back of the screen are foreshortened
export const ELEV_SIN = 0.95 / Math.hypot(Math.SQRT2, 0.95);
const R2 = Math.SQRT1_2;
/** screen-right and screen-up on the ground plane */
export const SR: [number, number] = [R2, -R2];
export const SU: [number, number] = [-R2, -R2];

export function toGround(right: number, up: number): [number, number] {
  const b = up / ELEV_SIN;
  return [right * SR[0] + b * SU[0], right * SR[1] + b * SU[1]];
}

export const POD_SIZE = 18;
export const BRAIN_SIZE = 15;

export function podCentre(id: PodId | "brain"): [number, number] {
  const [x, y] = SCREEN[id];
  return toGround(x, y);
}

/** desk slots inside a pod, in (right, toward-camera) pod units: the lead at the back, then rows of two */
const SLOTS: [number, number][] = [[0, -5.2], [-4.4, 0.4], [4.4, 0.4], [0, 5.6]];

export function seat(pod: PodId, i: number): [number, number] {
  const [cx, cz] = podCentre(pod);
  const [u, v] = SLOTS[Math.min(i, SLOTS.length - 1)];
  // v runs toward the camera (screen down): the opposite of screen-up on the ground
  return [cx + u * SR[0] - v * SU[0], cz + u * SR[1] - v * SU[1]];
}

// what each desk looks like: hair and skin, varied across the office
export const LOOKS: Record<string, { hair: string; skin: string; shirt?: string }> = {
  triage: { hair: "#2b2320", skin: "#e2b08a" }, sentry: { hair: "#101010", skin: "#c68c5d" },
  pii: { hair: "#5a3419", skin: "#f0c9a3" }, upi: { hair: "#1b1b24", skin: "#d9a57a" },
  refund: { hair: "#6e3a14", skin: "#f3d2b0" }, fraud: { hair: "#0c0c0c", skin: "#8f5d38" },
  kyc: { hair: "#3a2616", skin: "#e8b98e" }, evidence: { hair: "#22262e", skin: "#f0c7a0" },
  shadow: { hair: "#4a2a10", skin: "#d49a6c" }, recheck: { hair: "#141414", skin: "#b67a4d" },
  router: { hair: "#2d1a0a", skin: "#e6b58a" }, calibrator: { hair: "#7a4a1f", skin: "#f5d5b0" },
  seal: { hair: "#101820", skin: "#c4895a" }, commit: { hair: "#1f1f1f", skin: "#e0a878" },
  guard: { hair: "#552200", skin: "#f0c9a0" }, responder: { hair: "#33221a", skin: "#d9a97e" },
  human: { hair: "#2a1a0e", skin: "#e8b98e" }, trail: { hair: "#0d0d0d", skin: "#9c6b43" },
  drift: { hair: "#3d2814", skin: "#f0c9a0" },
};

export const STEP_ICON: Record<string, string> = {
  intake: "🛡️", understand: "🧭", evidence: "🔎", plan: "📝", calibrate: "📐", shadow: "🪞",
  route: "🔀", commit: "✅", respond: "💬", learn: "📜",
};
