// Small shared pieces of the office UI: time words, avatars, connector icons.
import { ArrowLeftRight, Landmark, MessageSquareText, Scale, ShieldBan, Sparkles, UserRound, Undo2, Wallet } from "lucide-react";
import { POD_STYLE, type PodId } from "./layout";

export function span(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d`;
  return r ? `${h} h ${r} m` : `${h} h`;
}

export function until(tsSec: number | null | undefined) {
  if (!tsSec) return "—";
  const ms = tsSec * 1000 - Date.now();
  if (ms < 30_000) return "now";
  return "in " + span(ms);
}

export const timeStr = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
export const dayTime = (ms: number) =>
  new Date(ms).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function Av({ name, pod }: { name: string; pod: PodId }) {
  const chip = POD_STYLE[pod]?.chip ?? "#ccc";
  return <span className="o-av" style={{ borderColor: chip, background: chip + "55" }}>{name[0]}</span>;
}

export const CONN_ICON: Record<string, { icon: any; color: string }> = {
  upi: { icon: ArrowLeftRight, color: "#4f46e5" },
  bank: { icon: Landmark, color: "#0f766e" },
  refunds: { icon: Undo2, color: "#c2410c" },
  crm: { icon: UserRound, color: "#7c3aed" },
  wallet: { icon: Wallet, color: "#0369a1" },
  disputes: { icon: Scale, color: "#a16207" },
  controls: { icon: ShieldBan, color: "#be123c" },
  messaging: { icon: MessageSquareText, color: "#15803d" },
  model: { icon: Sparkles, color: "#7b5bd6" },
};
