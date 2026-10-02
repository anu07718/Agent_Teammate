// Pieces of the top bar that the office and the workspace share, so both bars look and behave the same.
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { CONN_ICON } from "../office/bits";
import { setTheme, useUI, EMPTY } from "../store";
import { cx } from "./ui";

export function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const h = setInterval(() => setT(new Date()), 1000); return () => clearInterval(h); }, []);
  return <span className="o-clock">{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).toLowerCase()}</span>;
}

/** light (paper) or dark (near-black), for the office and the workspace alike; D in the office too */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useUI((s) => s.theme);
  const dark = theme === "dark";
  return (
    <button className={cx("o-tile o-theme", className)} aria-label="Toggle theme" title={dark ? "light theme (D in the office)" : "dark theme (D in the office)"}
      onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}

const KEY_OF: Record<string, string> = {
  "UPI switch": "upi", "Core banking": "bank", "Refund engine": "refunds", CRM: "crm", "Wallet ledger": "wallet",
  "Dispute desk": "disputes", "Card & UPI control": "controls", Messaging: "messaging",
};

/** the systems Nirnaya is connected to, as the office shows them: a tile each, lit while a tool is called */
export function ConnTiles({ className }: { className?: string }) {
  const tools = useUI((s) => s.app?.tools ?? EMPTY);
  const pulses = useUI((s) => s.pulses);
  const systems = [...new Set(tools.map((t) => t.system))].filter((s) => KEY_OF[s]);
  const now = Date.now();
  return (
    <div className={cx("o-conn", className)} aria-label="Connected systems">
      <span className="o-lab o-caps"><span className="o-dot" />CONNECTED TO</span>
      {systems.map((s) => {
        const p = pulses[s];
        const open = tools.some((t) => t.system === s && t.breaker === "open");
        const hot = p && now - p.ts < 1200;
        const I = CONN_ICON[KEY_OF[s]].icon;
        return (
          <span key={s + (p?.ts ?? 0)} data-conn={KEY_OF[s]} className={cx("o-tile", open && "off", hot && "hot")} title={`${s} · ${open ? "circuit open after 3 failures" : "connected"}`}>
            <I color={CONN_ICON[KEY_OF[s]].color} strokeWidth={2.2} />
          </span>
        );
      })}
    </div>
  );
}
