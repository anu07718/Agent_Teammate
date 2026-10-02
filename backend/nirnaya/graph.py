"""Context graph: customers, accounts, transactions, merchants, cases and policies, with typed links.

Agents do not re-read everything per case; they ask the graph: who is this customer, what did they pay,
has this merchant appeared before, which policy governs this case. Identifiers are stored as tokens.
"""
from __future__ import annotations

import json
from collections import deque

from .rails import Rails
from .store import Store


class Graph:
    def __init__(self, store: Store):
        self.store = store

    def node(self, nid: str, kind: str, label: str, **props) -> None:
        self.store.execute("INSERT INTO graph_nodes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, "
                           "props=excluded.props", (nid, kind, label, json.dumps(props, default=str)))

    def edge(self, src: str, dst: str, kind: str) -> None:
        self.store.execute("INSERT OR IGNORE INTO graph_edges VALUES(?,?,?)", (src, dst, kind))

    def build_from(self, rails: Rails, tokenise) -> None:
        for p, label in [("failed_upi", "Failed UPI: reverse by T+1, ₹100/day after"),
                         ("refund", "Merchant refund: T+5 working days"),
                         ("dispute", "Disputes: resolve within 30 days"),
                         ("unauthorized", "Unauthorised: block first, provisional credit on approval")]:
            self.node(f"policy:{p}", "policy", label)
        for c in rails.customers():
            cid = f"customer:{c['id']}"
            self.node(cid, "customer", c["id"], segment=c["segment"], prior_disputes=c["prior_disputes"])
            acct = f"account:{tokenise(c['account'])}"
            self.node(acct, "account", tokenise(c["account"]))
            self.edge(cid, acct, "owns")
            if c.get("vpa"):
                vpa = f"vpa:{tokenise(c['vpa'])}"
                self.node(vpa, "vpa", tokenise(c["vpa"]))
                self.edge(cid, vpa, "owns")
            for t in rails.txns_for(c["id"]):
                tid = f"txn:{t['id']}"
                self.node(tid, "txn", f"{t['id']} · ₹{t['amount']:,.0f}", amount=t["amount"], utr=t["utr"],
                          npci=t["npci_status"])
                self.edge(acct, tid, "paid")
                merchant = t["merchant"]
                mid = f"merchant:{tokenise(merchant) if '@' in merchant else merchant}"
                self.node(mid, "merchant", tokenise(merchant) if "@" in merchant else merchant)
                self.edge(tid, mid, "to")

    def rebuild(self, rails: Rails, tokenise) -> None:
        """After data is imported or removed: the customers and payments as they are now. Cases and
        memories stay, and keep their links to whatever still exists."""
        kinds = ("customer", "account", "vpa", "txn", "merchant")
        self.store.execute(f"DELETE FROM graph_nodes WHERE kind IN ({','.join('?' * len(kinds))})", kinds)
        self.build_from(rails, tokenise)
        self.store.execute("DELETE FROM graph_edges WHERE src NOT IN (SELECT id FROM graph_nodes) "
                           "OR dst NOT IN (SELECT id FROM graph_nodes)", ())

    def link_case(self, case_id: str, intent: str, txn_id: str | None, customer_id: str) -> None:
        self.node(f"case:{case_id}", "case", case_id, intent=intent)
        self.edge(f"case:{case_id}", f"customer:{customer_id}", "raised_by")
        if txn_id:
            self.edge(f"case:{case_id}", f"txn:{txn_id}", "about")
        policy = {"failed_debit": "failed_upi", "refund_status": "refund", "wrong_beneficiary": "dispute",
                  "unauthorized": "unauthorized", "duplicate_charge": "refund"}.get(intent)
        if policy:
            self.edge(f"case:{case_id}", f"policy:{policy}", "governed_by")

    def neighbors(self, nid: str) -> dict:
        out = [dict(r) for r in self.store.query("SELECT * FROM graph_edges WHERE src=? OR dst=?", (nid, nid))]
        ids = {nid} | {e["src"] for e in out} | {e["dst"] for e in out}
        return {"nodes": self.nodes(ids), "edges": out}

    def nodes(self, ids: set[str] | None = None) -> list[dict]:
        rows = self.store.query("SELECT * FROM graph_nodes")
        return [{**dict(r), "props": json.loads(r["props"])} for r in rows if ids is None or r["id"] in ids]

    def edges(self) -> list[dict]:
        return [dict(r) for r in self.store.query("SELECT * FROM graph_edges")]

    def search(self, q: str, limit: int = 20) -> list[dict]:
        ql = q.lower()
        return [n for n in self.nodes() if ql in n["id"].lower() or ql in n["label"].lower()][:limit]

    def trace_path(self, a: str, b: str, max_depth: int = 6) -> list[str]:
        adj: dict[str, set[str]] = {}
        for e in self.edges():
            adj.setdefault(e["src"], set()).add(e["dst"])
            adj.setdefault(e["dst"], set()).add(e["src"])
        prev, q = {a: None}, deque([a])
        while q:
            cur = q.popleft()
            if cur == b:
                path = []
                while cur:
                    path.append(cur)
                    cur = prev[cur]
                return path[::-1]
            if len(prev) > 5000:
                break
            for n in adj.get(cur, ()):
                if n not in prev:
                    prev[n] = cur
                    q.append(n)
        return []

    def merchant_seen_before(self, customer_id: str, merchant_label: str, txn_id: str) -> bool:
        """True if this customer has paid this merchant in another transaction."""
        rows = self.store.query(
            "SELECT e1.dst AS txn FROM graph_edges e0 JOIN graph_edges e1 ON e0.dst = e1.src "
            "JOIN graph_edges e2 ON e1.dst = e2.src WHERE e0.src=? AND e0.kind='owns' AND e1.kind='paid' "
            "AND e2.kind='to' AND e2.dst=?", (f"customer:{customer_id}", f"merchant:{merchant_label}"))
        return any(r["txn"] != f"txn:{txn_id}" for r in rows)
