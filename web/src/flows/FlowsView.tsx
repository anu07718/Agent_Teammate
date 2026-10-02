// Flows: how the agents are working right now (Live), and workflows the team draws for them (Builder).
import { Activity, Workflow } from "lucide-react";
import { useState } from "react";
import { cx } from "../components/ui";
import { Builder } from "./Builder";
import { Live } from "./Live";
import "./flows.css";

export function FlowsView() {
  const [tab, setTab] = useState<"live" | "builder">(() => (sessionStorage.getItem("nirnaya.flows.tab") as "live" | "builder") || "live");
  const [open, setOpen] = useState<string | null>(() => sessionStorage.getItem("nirnaya.flows.open"));
  const go = (t: "live" | "builder") => { setTab(t); try { sessionStorage.setItem("nirnaya.flows.tab", t); } catch { /* storage off */ } };
  const openFlow = (id: string | null) => { setOpen(id); try { if (id) sessionStorage.setItem("nirnaya.flows.open", id); } catch { /* storage off */ } };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-end gap-1 border-b border-line bg-bg px-3" role="tablist" aria-label="Flows">
        {([["live", "Live", Activity], ["builder", "Builder", Workflow]] as const).map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => go(id)}
            className={cx("caps flex h-10 cursor-pointer items-center gap-1.5 border-b-2 px-3", tab === id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg")}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "live" ? <Live onOpenFlow={(id) => { openFlow(id); go("builder"); }} /> : <Builder open={open} setOpen={openFlow} />}
      </div>
    </div>
  );
}
