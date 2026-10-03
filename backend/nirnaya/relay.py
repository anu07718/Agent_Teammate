"""Shared workspaces: other people join yours with a code, see what your agents are doing and work with them,
from the website, the phone app or the Windows app, wherever they are.

Your server hosts the workspace. It keeps one outbound connection to a Firebase Realtime Database (the free
Spark plan; no card), so it works from a laptop behind a home router: nobody has to reach your computer.
Under /w/<code> in that database:

  host               {name, ts}: who hosts it and a heartbeat every 15 s (offline: true when the server stops)
  req/<rid>          a request from a member's app: {c: member, m: method, p: /api/... path, h, b | x, za}
                     (za: the app can unpack compressed answers)
  res/<member>/<rid> the answer: {s: status, t: content type, b (text) | x (base64) | z (zlib + base64)}
  ev/s<0-15>         the live events, batched every 250 ms into a ring of 16 slots: {n, b | z}
  members/<member>   each member's presence: {name, view, focus, via, ts}, refreshed every 20 s

Each request is answered by calling this server's own API in-process, so a member's app works exactly as it
does here, with the same checks. A few things only the host may do (change keys and channel settings, the
workspace itself) answer 403. The code is the password: 10 characters from 31 letters and digits, about 49
bits, so it cannot be guessed; share it only with your team, and make a new one to shut people out.

Only the Python standard library: keep-alive HTTP for writes, the REST streaming API (server-sent events) to
listen. The database's rules are in firebase/database.rules.json.
"""
from __future__ import annotations

import asyncio
import base64
import http.client
import json
import logging
import queue
import re
import secrets
import ssl
import threading
import time
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

log = logging.getLogger("nirnaya.relay")
KEY = "workspace"
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L
CODE_LEN = 10
SLOTS = 16
STALE_S = 60          # a request older than this is dropped (its app has given up)
MEMBER_GONE_S = 70    # a member who has not refreshed their presence for this long has left
# what only the host may do; everything else in /api/ works for members exactly as for the host
DENY = [
    ("*", r"^/api/workspace"), ("*", r"^/api/events"), ("PUT", r"^/api/llm$"), ("PUT", r"^/api/channels$"),
    ("*", r"^/api/channels/(whatsapp|waha)/webhook"), ("*", r"^/api/channels/voice/twilio/"),
    ("*", r"^/api/channels/email/inbound"), ("POST", r"^/api/channels/hook$"), ("POST", r"^/api/team/me$"),
    ("PUT", r"^/api/pg$"), ("*", r"^/api/pg/razorpay/webhook"),
]


def new_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))


def norm_code(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def show_code(code: str) -> str:
    return f"{code[:5]}-{code[5:]}" if len(code) == CODE_LEN else code


def check_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not re.match(r"^https?://[^\s/?#]+", url):
        raise ValueError("The database address starts with https://, e.g. https://your-project-default-rtdb.firebaseio.com")
    return url


def encode_body(raw: bytes, ctype: str, compress: bool) -> dict:
    """Text stays text; big answers are compressed (the free plan counts every byte downloaded)."""
    if compress and len(raw) > 1024:
        return {"z": base64.b64encode(zlib.compress(raw, 6)).decode()}
    textual = not ctype or ctype.startswith("text/") or "json" in ctype or "xml" in ctype or "javascript" in ctype
    if textual:
        try:
            return {"b": raw.decode("utf-8")}
        except UnicodeDecodeError:
            pass
    return {"x": base64.b64encode(raw).decode()}


def decode_body(d: dict) -> bytes:
    if d.get("z"):
        return zlib.decompress(base64.b64decode(d["z"]))
    if d.get("x"):
        return base64.b64decode(d["x"])
    b = d.get("b")
    return b.encode() if isinstance(b, str) else b"" if b is None else json.dumps(b).encode()


class RelayError(Exception):
    pass


class Firebase:
    """The Realtime Database REST API: JSON in and out, and server-sent events to listen."""

    def __init__(self, url: str, timeout: float = 20.0):
        u = urllib.parse.urlsplit(check_url(url))
        self.url = url.rstrip("/")
        self.https = u.scheme == "https"
        self.host = u.hostname or ""
        self.port = u.port or (443 if self.https else 80)
        self.prefix = u.path.rstrip("/")
        self.query = dict(urllib.parse.parse_qsl(u.query))   # ns=… for the emulator, auth=… for a secret
        self.timeout = timeout
        self._local = threading.local()

    def path(self, p: str, **extra) -> str:
        q = {**self.query, **extra}
        return f"{self.prefix}/{p.strip('/')}.json" + (f"?{urllib.parse.urlencode(q)}" if q else "")

    def _connect(self, timeout: float) -> http.client.HTTPConnection:
        proxy = None
        if not urllib.request.proxy_bypass(self.host):
            proxy = urllib.request.getproxies().get("https" if self.https else "http")
        ctx = ssl.create_default_context() if self.https else None
        if proxy:
            pu = urllib.parse.urlsplit(proxy if "://" in proxy else f"http://{proxy}")
            if self.https:
                c = http.client.HTTPSConnection(pu.hostname, pu.port or 80, timeout=timeout, context=ctx)
                c.set_tunnel(self.host, self.port)
                return c
            return http.client.HTTPConnection(pu.hostname, pu.port or 80, timeout=timeout)
        if self.https:
            return http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=ctx)
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(self, method: str, p: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body, separators=(",", ":"), default=str).encode()
        for attempt in (1, 2):
            conn = getattr(self._local, "conn", None)
            if conn is None:
                conn = self._local.conn = self._connect(self.timeout)
            try:
                conn.request(method, self.path(p), body=data, headers={"Content-Type": "application/json",
                                                                        "Connection": "keep-alive"})
                r = conn.getresponse()
                raw = r.read()
            except (OSError, http.client.HTTPException) as e:
                conn.close()
                self._local.conn = None
                if attempt == 2:
                    raise RelayError(f"cannot reach the database: {e}")
                continue
            if r.status in (401, 403):
                raise RelayError("the database refused it: its rules are still Firebase's locked default. Copy "
                                 "Nirnaya's rules (the button below, or firebase/database.rules.json), then in "
                                 "Realtime Database → Rules replace everything with them and press Publish")
            if r.status == 404:
                raise RelayError("no database at that address: copy it from Realtime Database → Data in Firebase")
            if r.status >= 400:
                raise RelayError(f"the database answered {r.status}: {raw[:200].decode('utf-8', 'replace')}")
            return json.loads(raw) if raw else None
        return None

    def get(self, p: str) -> Any:
        return self.request("GET", p)

    def put(self, p: str, v: Any) -> Any:
        return self.request("PUT", p, v)

    def patch(self, p: str, v: dict) -> Any:
        return self.request("PATCH", p, v)

    def delete(self, p: str) -> Any:
        return self.request("DELETE", p)

    def stream(self, p: str, on_event: Callable[[str, str, Any], None], stop: threading.Event,
               on_state: Callable[[bool, str | None], None] | None = None) -> None:
        """Listen to a path until `stop` is set, reconnecting with backoff. on_event(kind, path, data) for every
        put and patch; on_state(connected, error) as the connection comes and goes."""
        backoff = 1.0
        host, port, target = self.host, self.port, self.path(p)
        while not stop.is_set():
            conn = None
            try:
                if (host, port) == (self.host, self.port):
                    conn = self._connect(75.0)        # Firebase sends a keep-alive every 30 s
                else:                                 # after a redirect to another database server
                    conn = (http.client.HTTPSConnection if self.https else http.client.HTTPConnection)(host, port, timeout=75.0)
                conn.request("GET", target, headers={"Accept": "text/event-stream"})
                r = conn.getresponse()
                if r.status in (301, 302, 307, 308) and r.getheader("Location"):
                    lu = urllib.parse.urlsplit(r.getheader("Location"))
                    host, port = lu.hostname or host, lu.port or (443 if self.https else 80)
                    target = lu.path + (f"?{lu.query}" if lu.query else "")
                    conn.close()
                    continue
                if r.status != 200:
                    raise RelayError(f"listening was refused ({r.status}): check the database rules")
                if on_state:
                    on_state(True, None)
                backoff = 1.0
                kind = None
                while not stop.is_set():
                    line = r.readline()
                    if not line:
                        raise RelayError("the stream ended")
                    line = line.decode("utf-8", "replace").rstrip("\r\n")
                    if line.startswith("event:"):
                        kind = line[6:].strip()
                    elif line.startswith("data:"):
                        if kind in ("put", "patch"):
                            msg = json.loads(line[5:].strip() or "null")
                            try:
                                on_event(kind, msg.get("path", "/"), msg.get("data"))
                            except Exception:
                                log.exception("relay: a listener failed")
                        elif kind in ("cancel", "auth_revoked"):
                            raise RelayError("the database stopped the stream: check its rules")
                    elif not line:
                        kind = None
            except (OSError, http.client.HTTPException, RelayError, ValueError) as e:
                if on_state and not stop.is_set():
                    on_state(False, str(e))
                stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
                host, port, target = self.host, self.port, self.path(p)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except OSError:
                        pass


def merge(tree: dict, path: str, data: Any, kind: str) -> dict:
    """Apply a streamed put/patch at `path` to a local copy of the tree."""
    parts = [x for x in path.split("/") if x]
    if not parts:
        if kind == "put":
            return data if isinstance(data, dict) else {}
        return {**tree, **(data or {})}
    node = tree
    for k in parts[:-1]:
        nxt = node.get(k)
        if not isinstance(nxt, dict):
            nxt = node[k] = {}
        node = nxt
    last = parts[-1]
    if kind == "patch":
        cur = node.get(last) if isinstance(node.get(last), dict) else {}
        node[last] = {**cur, **(data or {})}
    elif data is None:
        node.pop(last, None)
    else:
        node[last] = data
    return tree


async def call_app(app, method: str, target: str, headers: dict[str, str], body: bytes) -> tuple[int, str, bytes]:
    """Call this server's own API in-process, as an HTTP request would."""
    path, _, query = target.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": urllib.parse.unquote(path), "raw_path": path.encode(),
        "query_string": query.encode(), "root_path": "",
        "headers": [(k.lower().encode("latin-1"), str(v).encode("latin-1", "replace")) for k, v in headers.items()],
        "client": ("127.0.0.1", 0), "server": ("127.0.0.1", 80),
    }
    sent = False
    done = asyncio.Event()

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}

    status, ctype, chunks = 500, "", []

    async def send(msg):
        nonlocal status, ctype
        if msg["type"] == "http.response.start":
            status = msg["status"]
            for k, v in msg.get("headers") or []:
                if k.lower() == b"content-type":
                    ctype = v.decode("latin-1")
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body") or b"")
            if not msg.get("more_body"):
                done.set()

    await app(scope, receive, send)
    done.set()
    return status, ctype, b"".join(chunks)


class Relay:
    def __init__(self, app, store_fn: Callable, bus_fn: Callable, team_fn: Callable, key_fn: Callable[[], str]):
        self.app = app
        self.S, self.B, self.T, self.K = store_fn, bus_fn, team_fn, key_fn
        self.loop: asyncio.AbstractEventLoop | None = None
        self.fb: Firebase | None = None
        self.code: str | None = None
        self.name = ""
        self.since = 0.0
        self.connected = False
        self.error: str | None = None
        self.served = 0
        self.members: dict[str, dict] = {}
        self._seen: dict[str, float] = {}
        self._stop: threading.Event | None = None
        self._q: queue.Queue = queue.Queue(maxsize=5000)
        self._pool: ThreadPoolExecutor | None = None
        self._handled: dict[str, float] = {}
        self._hooked = None
        self._offset_ms = 0.0     # server time minus ours, from the heartbeat

    # ── settings ────────────────────────────────────────────────────────────
    def saved(self) -> dict:
        return self.S().kv_get(KEY) or {}

    def relay_url(self) -> str:
        import os
        return (os.environ.get("NIRNAYA_RELAY_URL") or self.saved().get("url") or "").rstrip("/")

    def status(self) -> dict:
        import os
        hosting = None
        if self.code:
            hosting = {"code": self.code, "display": show_code(self.code), "name": self.name, "since": self.since,
                       "connected": self.connected, "error": self.error, "served": self.served,
                       "members": sorted(({"client": k, **{f: v.get(f) for f in ("name", "view", "focus", "via")}}
                                          for k, v in self.members.items()), key=lambda m: m["name"] or "")}
        return {"relay_url": self.relay_url(), "url_locked": bool(os.environ.get("NIRNAYA_RELAY_URL")), "hosting": hosting}

    # ── lifecycle ───────────────────────────────────────────────────────────
    def hook(self, bus) -> None:
        if self._hooked is bus:
            return
        self._hooked = bus
        bus.listen(self._on_bus)

    async def resume(self) -> None:
        """After a restart, host the same workspace again, so members keep their code."""
        self.loop = asyncio.get_running_loop()
        s = self.saved()
        if s.get("code") and self.relay_url():
            try:
                await asyncio.to_thread(self._start, self.relay_url(), s["code"], s.get("name") or "Workspace",
                                        s.get("since") or time.time(), True)
            except RelayError as e:
                self.error = str(e)
                log.warning("relay: could not resume %s: %s", s.get("code"), e)

    async def create(self, url: str | None, name: str | None, by: str | None) -> dict:
        self.loop = asyncio.get_running_loop()
        url = check_url(url or self.relay_url())
        name = (re.sub(r"[\x00-\x1f<>]", "", name or "").strip() or f"{by or 'My'} workspace")[:60]
        await asyncio.to_thread(probe, url)
        old = self.code
        await asyncio.to_thread(self._stop_threads, old is not None)
        await asyncio.to_thread(self._start, url, new_code(), name, time.time(), False)
        return self.status()

    async def stop(self) -> dict:
        await asyncio.to_thread(self._stop_threads, True)
        s = self.saved()
        s.pop("code", None)
        self.S().kv_set(KEY, s)
        self.code = None
        return self.status()

    async def shutdown(self) -> None:
        """The server is stopping: say the host is offline, keep the code for next time."""
        if self.code and self.fb:
            try:
                await asyncio.wait_for(asyncio.to_thread(self.fb.patch, f"w/{self.code}/host", {"offline": True}), 3)
            except Exception:
                pass
        await asyncio.to_thread(self._stop_threads, False)

    def _start(self, url: str, code: str, name: str, since: float, resuming: bool) -> None:
        fb = Firebase(url)
        host = {"name": name, "ts": {".sv": "timestamp"}, "since": int(since * 1000), "offline": False, "v": 1}
        got = fb.patch(f"w/{code}/host", host) if resuming else fb.put(f"w/{code}/host", host)
        if isinstance(got, dict) and isinstance(got.get("ts"), (int, float)):
            self._offset_ms = got["ts"] - time.time() * 1000
        self.fb, self.code, self.name, self.since = fb, code, name, since
        self.S().kv_set(KEY, {**self.saved(), "url": url, "code": code, "name": name, "since": since})
        self.error, self.served, self.members, self._seen, self._handled = None, 0, {}, {}, {}
        self._stop = threading.Event()
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="relay-req")
        stop = self._stop
        for target, args in ((fb.stream, (f"w/{code}/req", self._on_req, stop, self._on_state)),
                             (fb.stream, (f"w/{code}/members", self._on_members, stop)),
                             (self._pump, (stop,))):
            threading.Thread(target=target, args=args, daemon=True, name=f"relay-{code[:4]}").start()
        log.info("relay: hosting workspace %s at %s", show_code(code), url)

    def _stop_threads(self, delete: bool) -> None:
        if self._stop:
            self._stop.set()
        if self._pool:
            self._pool.shutdown(wait=False, cancel_futures=True)
        if delete and self.code and self.fb:
            try:
                self.fb.delete(f"w/{self.code}")
            except RelayError as e:
                log.info("relay: could not delete %s: %s", self.code, e)
        for client in list(self.members):
            self._drop_member(client)
        self.connected = False
        self._stop = self._pool = None

    def _on_state(self, connected: bool, error: str | None) -> None:
        self.connected, self.error = connected, error

    # ── requests from members ───────────────────────────────────────────────
    def _on_req(self, kind: str, path: str, data: Any) -> None:
        parts = [x for x in path.split("/") if x]
        if not parts:
            items = data.items() if isinstance(data, dict) else []
        elif len(parts) == 1:
            items = [(parts[0], data)]
        else:
            return
        for rid, r in items:
            if not isinstance(r, dict) or rid in self._handled or not self._pool:
                continue
            self._handled[rid] = time.time()
            try:
                self._pool.submit(self._serve, rid, r)
            except RuntimeError:
                return
        cutoff = time.time() - 300
        for rid, ts in list(self._handled.items()):
            if ts < cutoff:
                self._handled.pop(rid, None)

    def _serve(self, rid: str, r: dict) -> None:
        try:
            self._answer(rid, r)
        except Exception as e:  # never let one request take the relay down
            log.exception("relay: request %s failed", rid)
            self.error = str(e)

    def _answer(self, rid: str, r: dict) -> None:
        code, fb = self.code, self.fb
        if not code or not fb or not self.loop:
            return
        client = re.sub(r"[^A-Za-z0-9_-]", "", str(r.get("c") or ""))[:64]
        ts = r.get("ts")
        if not client or (isinstance(ts, (int, float)) and (time.time() * 1000 + self._offset_ms) - ts > STALE_S * 1000):
            fb.delete(f"w/{code}/req/{rid}")      # nobody to answer, or its app gave up long ago
            return
        method = str(r.get("m") or "GET").upper()
        target = str(r.get("p") or "")
        path = target.split("?", 1)[0]
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE") or not path.startswith("/api/"):
            status, ctype, body = 400, "application/json", b'{"detail":"not an API request"}'
        elif any((m in ("*", method)) and re.search(rx, path) for m, rx in DENY):
            status, ctype, body = 403, "application/json", json.dumps(
                {"detail": "Only the workspace's host can do this, on their own computer."}).encode()
        else:
            headers = {"host": "127.0.0.1", "x-nirnaya-relay": "1", "x-nirnaya-member": str(r.get("who") or "")[:40]}
            ct = (r.get("h") or {}).get("ct") if isinstance(r.get("h"), dict) else None
            if ct:
                headers["content-type"] = str(ct)[:200]
            if self.K():
                headers["x-nirnaya-key"] = self.K()
            try:
                raw = decode_body(r)
                fut = asyncio.run_coroutine_threadsafe(call_app(self.app, method, target, headers, raw), self.loop)
                status, ctype, body = fut.result(timeout=55)
            except Exception as e:  # the API itself failed: say so, as a 500 would
                log.exception("relay: %s %s failed", method, target)
                status, ctype, body = 500, "application/json", json.dumps({"detail": f"the host could not do it: {e}"}).encode()
        out = {"s": status, "t": ctype, **encode_body(body, ctype, bool(r.get("za")))}
        try:
            fb.patch(f"w/{code}", {f"res/{client}/{rid}": out, f"req/{rid}": None})
            self.served += 1
        except RelayError as e:
            self.error = str(e)

    # ── live events and the heartbeat ───────────────────────────────────────
    def _on_bus(self, ev: dict) -> None:
        if self.code:
            try:
                self._q.put_nowait(ev)
            except queue.Full:
                pass

    def _pump(self, stop: threading.Event) -> None:
        n, beat, sweep = 0, 0.0, 0.0
        while not stop.is_set():
            batch = []
            try:
                batch.append(self._q.get(timeout=0.25))
                while len(batch) < 200:
                    batch.append(self._q.get_nowait())
            except queue.Empty:
                pass
            code, fb = self.code, self.fb
            if stop.is_set() or not code or not fb:
                break
            try:
                if batch:
                    n += 1
                    raw = json.dumps(batch, separators=(",", ":"), default=str).encode()
                    fb.put(f"w/{code}/ev/s{n % SLOTS}", {"n": n, "t0": int(time.time() * 1000), **encode_body(raw, "application/json", True)})
                now = time.time()
                if now - beat > 15:
                    beat = now
                    got = fb.patch(f"w/{code}/host", {"ts": {".sv": "timestamp"}, "offline": False,
                                                       "members": len(self.members)})
                    if isinstance(got, dict) and isinstance(got.get("ts"), (int, float)):
                        self._offset_ms = got["ts"] - now * 1000
                if now - sweep > 10:
                    sweep = now
                    for client, seen in list(self._seen.items()):
                        if now - seen > MEMBER_GONE_S:
                            self._drop_member(client)
                            try:
                                fb.delete(f"w/{code}/members/{client}")
                            except RelayError:
                                pass
            except RelayError as e:
                self.error = str(e)
                stop.wait(2)

    # ── who is in the workspace ─────────────────────────────────────────────
    def _on_members(self, kind: str, path: str, data: Any) -> None:
        tree = merge({k: dict(v) for k, v in self.members.items()}, path, data, kind)
        now = time.time()
        for client, m in tree.items():
            if not isinstance(m, dict) or not m.get("name"):
                continue
            old = self.members.get(client)
            if old != m:
                self._seen[client] = now
            self.members[client] = m
            self.T().remote(f"r-{client}", m.get("name"), m.get("view"), m.get("focus"), m.get("via") or "web")
        for client in [c for c in self.members if c not in tree]:
            self._drop_member(client)

    def _drop_member(self, client: str) -> None:
        self.members.pop(client, None)
        self._seen.pop(client, None)
        try:
            self.T().remote_gone(f"r-{client}")
        except Exception:
            pass


def probe(url: str) -> dict:
    """Is the database set up right? A test entry can be written and removed, and (the rules doing their
    job) nobody can list the workspaces: a database left open in "test mode" would show every code."""
    fb = Firebase(url, timeout=10)
    code = new_code()
    fb.put(f"w/{code}/host", {"name": "test", "ts": {".sv": "timestamp"}})
    fb.delete(f"w/{code}")
    try:
        fb.get("w")
    except RelayError:
        return {"ok": True}
    raise RelayError("this database is open to everyone, so anyone could see every workspace: in Firebase, "
                     "Realtime Database → Rules, paste the rules from firebase/database.rules.json and publish")

