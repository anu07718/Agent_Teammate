// Who is here: an avatar per person on the server, with where they are. Yours has a ring; click it to
// change your name (it goes on everything you approve, reject, ask or add).
import { useEffect, useRef, useState } from "react";
import { useUI, EMPTY } from "../store";
import { initials, me, setMyName, where, type Person } from "../team";

export function Avatar({ p, size = 24, ring = false }: { p: { name: string; color: string }; size?: number; ring?: boolean }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: p.color, fontSize: size * 0.4, lineHeight: 1, boxShadow: ring ? `0 0 0 2px var(--people-ring, #fff), 0 0 0 3.5px ${p.color}` : undefined, letterSpacing: 0 }}>
      {initials(p.name)}
    </span>
  );
}

export function People({ max = 5, size = 24, className = "" }: { max?: number; size?: number; className?: string }) {
  const people = useUI((s) => s.people ?? EMPTY) as Person[];
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me().name);
  const box = useRef<HTMLDivElement>(null);
  const mine = people.find((p) => p.client === me().client);
  const others = people.filter((p) => p.client !== me().client);
  useEffect(() => {
    if (!editing) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setEditing(false); };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [editing]);
  const self = mine ?? { name: me().name, color: "#5b7cfa" };
  return (
    <div ref={box} className={`relative flex items-center ${className}`} aria-label="Who is here" data-testid="people">
      <div className="flex items-center" style={{ gap: 0 }}>
        {others.slice(0, max).map((p, i) => (
          <span key={p.client} title={`${p.name} · ${where(p)}`} style={{ marginLeft: i ? -size * 0.25 : 0 }} data-person={p.name}>
            <Avatar p={p} size={size} />
          </span>
        ))}
        {others.length > max && <span className="ml-1 text-[11px] opacity-70" title={others.slice(max).map((p) => p.name).join(", ")}>+{others.length - max}</span>}
      </div>
      <button type="button" className="ml-1.5 flex cursor-pointer items-center gap-1.5 rounded-full" title={`You are ${self.name}: click to change your name`}
        aria-label="Your name" onClick={() => { setName(me().name); setEditing((v) => !v); }}>
        <Avatar p={self} size={size} ring />
      </button>
      {editing && (
        <form className="absolute right-0 top-[calc(100%+8px)] z-[60] w-64 rounded-lg border p-3 text-left shadow-xl"
          style={{ background: "var(--people-bg, #fff)", color: "var(--people-fg, #16181d)", borderColor: "var(--people-line, #e6e8ee)", fontFamily: "Inter, system-ui, sans-serif", textTransform: "none", letterSpacing: 0 }}
          onSubmit={(e) => { e.preventDefault(); setMyName(name); setEditing(false); }}>
          <label className="block text-[12px] font-medium" htmlFor="my-name">Your name</label>
          <p className="mb-2 mt-0.5 text-[11px] opacity-70">Your team sees it on what you approve, ask and add.</p>
          <div className="flex gap-1.5">
            <input id="my-name" autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
              className="h-8 min-w-0 flex-1 rounded-md border px-2 text-[13px] outline-none" style={{ borderColor: "var(--people-line, #e6e8ee)", background: "transparent", color: "inherit" }} />
            <button type="submit" className="h-8 cursor-pointer rounded-md px-3 text-[12px] font-semibold text-white" style={{ background: "#5b7cfa" }}>Save</button>
          </div>
          {people.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t pt-2" style={{ borderColor: "var(--people-line, #e6e8ee)" }}>
              <li className="text-[11px] font-medium uppercase tracking-wider opacity-60">Here now</li>
              {people.map((p) => (
                <li key={p.client} className="flex items-center gap-2 text-[12px]">
                  <Avatar p={p} size={20} /><span className="font-medium">{p.name}{p.client === me().client ? " (you)" : ""}</span>
                  <span className="ml-auto truncate opacity-60">{where(p)}</span>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </div>
  );
}
