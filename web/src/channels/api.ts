// The Channels API: real email, WhatsApp, phone calls, the call page, and webhooks for n8n.
import { apiReq } from "../api";
import { by } from "../team";

export type ChannelId = "email" | "whatsapp" | "voice" | "hook";
export interface ChannelStatus { ok: boolean | null; error: string | null; last: number | null; received: number; sent: number; failed: number; last_poll?: number }
export interface Msg { dir: "in" | "out"; text: string; ts: number; case_id?: string; kind?: string; status?: string; error?: string; msg_id?: string; by?: string;
  original?: string; lang?: string }   // a caller who spoke Hindi: their own words, and `text` is what the agents read
export interface ConvSummary {
  id: string; channel: string; address: string; name: string; customer_id: string | null; customer: string | null;
  case_ids: string[]; updated_at: number; count: number; last: Msg | null; subject: string; ended: boolean;
}
export interface Conv extends ConvSummary { messages: Msg[]; lang?: string | null; recording?: Recording | null; report?: string | null }
export interface Recording { status: "off" | "starting" | "recording" | "downloading" | "kept" | "failed" | "absent"; duration?: number; error?: string; file?: string }
export interface CallTurn { who: "caller" | "agent"; said: string; english?: string; lang: string; ts: number; via?: string }
export interface CallCase { id: string; intent: string | null; amount: number | null; status: string; route: string | null; outcome: string; how: string; reply: string | null; tokens: number }
export interface CallReportSummary {
  id: string; channel: "phone" | "call page"; direction: "in" | "out"; name: string; number: string; customer: { id: string; name: string } | null;
  started: number; duration: number | null; langs: string[]; outcome: string; summary: string; cases: string[]; turns: number; recording: Recording["status"];
}
export interface CallReport extends Omit<CallReportSummary, "cases" | "turns" | "recording"> {
  ended: number | null; turns: CallTurn[]; cases: CallCase[]; recording: Recording;
}
export interface Contact { key: string; address: string; kind: "email" | "phone" | "id"; customer_id: string; customer: string }
export interface Snapshot {
  config: Record<string, any> & { public_url: string; unknown: string; locked: string[] };
  status: Record<string, ChannelStatus>;
  webhooks: Record<string, string>;
  contacts: Contact[];
  customers: { id: string; name: string; phone: string }[];
  conversations: ConvSummary[];
}

const send = <T,>(method: string, path: string, body?: unknown) =>
  apiReq<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const capi = {
  get: () => apiReq<Snapshot>("/api/channels"),
  save: (patch: Record<string, unknown>) => send<Snapshot>("PUT", "/api/channels", patch),
  link: (address: string, customer_id: string) => send<{ key: string }>("POST", "/api/channels/contacts", { address, customer_id }),
  unlink: (address: string) => send<{ ok: boolean }>("DELETE", `/api/channels/contacts?address=${encodeURIComponent(address)}`),
  test: (channel: ChannelId, to: string, text: string) => send<any>("POST", "/api/channels/test", { channel, to, text, by: by() }),
  poll: () => send<{ read: number; started_fresh: boolean; results: any[] }>("POST", "/api/channels/email/poll"),
  conversations: () => apiReq<ConvSummary[]>("/api/channels/conversations"),
  conversation: (id: string) => apiReq<Conv>(`/api/channels/conversations/${encodeURIComponent(id)}`),
  reply: (id: string, text: string) => send<Msg>("POST", `/api/channels/reply/${encodeURIComponent(id)}`, { text, by: by() }),
  caseChannel: (caseId: string) => apiReq<Conv | null>(`/api/cases/${caseId}/channel`),
  forward: (caseId: string, to: string, note = "") => send<{ to: string }>("POST", `/api/cases/${caseId}/forward`, { to, note, by: by() }),
  call: (caseId: string, to: string, text = "") => send<{ sid: string }>("POST", `/api/cases/${caseId}/call`, { to, text, by: by() }),
  // the customer call page
  webCustomers: () => apiReq<{ id: string; name: string }[]>("/api/channels/web/customers"),
  webStart: (customer_id: string | null, lang: "en" | "hi" = "en") => send<{ session: string; greeting: string }>("POST", "/api/channels/web/start", { customer_id, lang }),
  webTurn: (session: string, text: string, mode: "voice" | "text", lang: "en" | "hi" = "en") =>
    send<{ reply: string; english?: string; end: boolean; case_id: string | null; status?: string; route?: string }>("POST", "/api/channels/web/turn", { session, text, mode, lang }),
  // call reports: what was said (with translations), the cases, the recording
  callReports: () => apiReq<CallReportSummary[]>("/api/channels/call-reports"),
  callReport: (id: string) => apiReq<CallReport>(`/api/channels/call-reports/${encodeURIComponent(id)}`),
  webEnd: (session: string) => send<{ ok: boolean }>("POST", "/api/channels/web/end", { session }),
  webRecording: (session: string, audio: Blob, seconds: number) =>
    apiReq<{ ok: boolean; bytes: number }>(`/api/channels/web/recording?session=${session}&seconds=${Math.round(seconds)}`,
      { method: "POST", body: audio, headers: { "Content-Type": audio.type.split(";")[0] || "audio/webm" } }),
};

export const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", voice: "Phone", web: "Call page", hook: "Webhook" };
export const CHANNEL_ICON: Record<string, string> = { email: "✉", whatsapp: "🟢", voice: "📞", web: "🎙", hook: "🔗" };
