// Pieces of the top bar that the office and the workspace share, so both bars look and behave the same.
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { CONN_ICON } from "../office/bits";
import { setTheme, useUI, EMPTY } from "../store";
import { cx } from "./ui";

/** the time, ticking; a steady width, so the bar never shifts by a pixel each second */
export function Clock({ className }: { className?: string }) {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const h = setInterval(() => setT(new Date()), 1000); return () => clearInterval(h); }, []);
  return <span className={cx("o-clock", className)}>{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).toLowerCase()}</span>;
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
  "Dispute desk": "disputes", "Card & UPI control": "controls", Messaging: "messaging", "Razorpay (test)": "razorpay",
};

/** the systems Nirnaya is connected to, as the office shows them: a tile each, lit while a tool is called */
export function ConnTiles({ className }: { className?: string }) {
  const tools = useUI((s) => s.app?.tools ?? EMPTY);
  const pg = useUI((s) => !!s.app?.integrations?.pg?.ready);
  const pulses = useUI((s) => s.pulses);
  // the Razorpay tile shows only once test keys are saved
  const systems = [...new Set(tools.map((t) => t.system))].filter((s) => KEY_OF[s] && (KEY_OF[s] !== "razorpay" || pg));
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

export interface LlmSummary { enabled: boolean; provider?: string | null; label?: string | null; short?: string | null; model?: string | null; error?: string | null }

/** which free language model the agents reason with, or that they run on rules alone */
export function ReasonsWith({ llm, className, tileClass }: { llm?: LlmSummary | null; className?: string; tileClass?: string }) {
  const on = !!llm?.enabled;
  const title = on ? `${llm?.label}${llm?.model ? ` · ${llm.model}` : ""}: refines understanding and drafts replies (free tier). Change it in Settings.`
    : "Rules only. Add a free model (Groq, Gemini, OpenRouter, Mistral or Ollama) in Settings.";
  const I = CONN_ICON.model.icon;
  return (
    <>
      <span className={cx("o-lab o-caps", className)} title={title} data-testid="reasons-with">
        <span className="o-dot" style={{ background: on ? "var(--o-green)" : "var(--o-faint)" }} />{on ? `REASONS WITH ${(llm?.short ?? "").toUpperCase()}` : "RULES ONLY"}
      </span>
      <span className={cx("o-tile", tileClass)} title={title} style={{ opacity: on ? 1 : 0.45 }}>
        <I color={CONN_ICON.model.color} strokeWidth={2.2} />
      </span>
    </>
  );
}
