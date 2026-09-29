import { Power, Upload } from "lucide-react";
import { useState } from "react";
import { api, apiBase, setApiBase } from "../api";
import { Badge, Button, Card, KV, Mono } from "../components/ui";
import { connect, toast, useUI } from "../store";

export function SettingsView() {
  const integ = useUI((s) => s.app?.integrations);
  const [server, setServer] = useState(apiBase());
  const [parsed, setParsed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const on = (b: boolean | undefined, yes = "on", no = "off") => <Badge tone={b ? "good" : "muted"}>{b ? yes : no}</Badge>;
  const mcpUrl = `${apiBase() || window.location.origin}/mcp`;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-2">
        <Card title="Server">
          <p className="mb-2 text-[12.5px] text-muted">Leave empty when this page is served by Nirnaya itself. The phone and desktop apps point this at your Nirnaya server.</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setApiBase(server); connect(api.eventsUrl()); toast("Server updated", "good"); }}>
            <input aria-label="Server URL" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://nirnaya.example.com"
              className="h-8 flex-1 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
            <Button type="submit">Save</Button>
          </form>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                const r = await api.restart();
                toast(`Restarted from checkpoints: ${r.resumed.length} resumed, ${r.parked.length} still parked`, "good");
              } finally { setBusy(false); }
            }}><Power size={13} /> Simulate a crash and restart</Button>
          </div>
          <p className="mt-2 text-[11.5px] text-faint">Drops everything in memory and resumes from the checkpoint store. Parked approvals survive and still apply to exactly what was sealed.</p>
        </Card>
        <Card title="Integrations">
          {integ ? (
            <KV rows={[
              ["Language model", <span>{on(integ.llm.enabled)} <Mono>{integ.llm.model}</Mono>{integ.llm.error ? <span className="text-escalate"> {integ.llm.error}</span> : null}</span>],
              ["", <span className="text-[11.5px] text-faint">Optional. Refines understanding and drafts replies from tokenised text; the Promise Guard still checks every word. Set ANTHROPIC_API_KEY on the server.</span>],
              ["Error monitoring", <span>{on(integ.monitoring.enabled)} {integ.monitoring.provider} · set SENTRY_DSN</span>],
              ["PDF evidence", <span>{on(integ.documents.mineru, "MinerU", "MinerU not installed")} {on(integ.documents.pypdf, "pypdf", "no pypdf")}</span>],
              ["Screenshot OCR", on(integ.documents.tesseract, "Tesseract", "not installed")],
              ["Office export", on(integ.officecli, "OfficeCLI validates and renders", "openpyxl")],
              ["MCP server", <Mono>{mcpUrl} · {integ.mcp.tools} tools</Mono>],
            ]} />
          ) : "—"}
        </Card>
        <Card title="Use Nirnaya from another agent (MCP)" className="lg:col-span-2">
          <p className="mb-2 text-[12.5px] text-muted">Any MCP client, such as a bank's existing chatbot, can submit cases, read their status, query the graph and memory, or ask the Confidence Layer to score an action it is about to take. Money-moving tools are not exposed: they only run inside Nirnaya, behind the Seal.</p>
          <pre className="overflow-x-auto rounded-md bg-panel-2 p-3 text-[11.5px]">{JSON.stringify({ mcpServers: { nirnaya: { type: "http", url: mcpUrl } } }, null, 2)}</pre>
        </Card>
        <Card title="Parse an evidence document" className="lg:col-span-2">
          <p className="mb-2 text-[12.5px] text-muted">A bank statement PDF, a merchant email or a screenshot of the failed payment. The text is tokenised before anyone reads it, then mined for UTRs, amounts and dates.</p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] hover:bg-panel-2">
            <Upload size={13} /> Choose a file
            <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.eml,.csv" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { setParsed(await api.parseEvidence(f)); } catch (err) { toast((err as Error).message, "bad"); }
            }} />
          </label>
          {parsed && (
            <div className="mt-3 space-y-2 text-[12px]">
              {parsed.ok ? (
                <>
                  <div>Parsed with <Badge tone="accent">{parsed.engine}</Badge> · {parsed.chars} characters · {parsed.pii.length} identifier(s) tokenised · UTRs: {parsed.utrs.join(", ") || "none"}</div>
                  <Mono className="block">{JSON.stringify(parsed.entities)}</Mono>
                  <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-2 text-[11px]">{parsed.text}</pre>
                </>
              ) : <div className="text-escalate">{parsed.reason}</div>}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
