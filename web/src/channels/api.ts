// The Channels API: real email, WhatsApp, phone calls, the call page, and webhooks for n8n.
import { apiReq } from "../api";
import { by } from "../team";

export type ChannelId = "email" | "whatsapp" | "voice" | "hook";
export interface ChannelStatus { ok: boolean | null; error: string | null; last: number | null; received: number; sent: number; failed: number; last_poll?: number }
export interface Msg { dir: "in" | "out"; text: string; ts: number; case_id?: string; kind?: string; status?: string; error?: string; msg_id?: string; by?: string }
export interface ConvSummary {
  id: string; channel: string; address: string; name: string; customer_id: string | null; customer: string | null;
  case_ids: string[]; updated_at: number; count: number; last: Msg | null; subject: string; ended: boolean;
}
export interface Conv extends ConvSummary { messages: Msg[] }
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
  webStart: (customer_id: string | null) => send<{ session: string; greeting: string }>("POST", "/api/channels/web/start", { customer_id }),
  webTurn: (session: string, text: string, mode: "voice" | "text") =>
    send<{ reply: string; end: boolean; case_id: string | null; status?: string; route?: string }>("POST", "/api/channels/web/turn", { session, text, mode }),
  webEnd: (session: string) => send<{ ok: boolean }>("POST", "/api/channels/web/end", { session }),
};

export const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", voice: "Phone", web: "Call page", hook: "Webhook" };
export const CHANNEL_ICON: Record<string, string> = { email: "✉", whatsapp: "🟢", voice: "📞", web: "🎙", hook: "🔗" };
