"""Shared workspaces through the relay database, against Google's own Firebase Realtime Database emulator
with the rules in firebase/database.rules.json (make relay-emulator; it needs Java). The tests play the
member's app with plain REST calls, exactly what the browser sends.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

import pytest

from nirnaya import relay
from nirnaya.engine import Engine
from nirnaya.store import Store

ROOT = Path(__file__).resolve().parents[2]
JAR = Path(os.environ.get("RTDB", Path.home() / ".cache/nirnaya/firebase-database-emulator-v4.11.2.jar"))
PORT = int(os.environ.get("RTDB_PORT", "9000"))
NS = "demo-nirnaya"
URL = f"http://127.0.0.1:{PORT}/?ns={NS}"


def _open(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.5).close()
        return True
    except OSError:
        return False


def rest(method, path, body=None, auth=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/{path}.json?ns={NS}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {auth}"} if auth else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


@pytest.fixture(scope="module")
def emulator():
    proc = None
    if not _open(PORT):
        if not JAR.exists() or not shutil.which("java"):
            pytest.skip("no Firebase database emulator (make relay-emulator, needs Java)")
        proc = subprocess.Popen(["java", "-jar", str(JAR), "--host", "127.0.0.1", "--port", str(PORT)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if _open(PORT):
                break
            time.sleep(0.5)
    rules = (ROOT / "firebase/database.rules.json").read_text()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/.settings/rules.json?ns={NS}", data=rules.encode(),
                                 method="PUT", headers={"Authorization": "Bearer owner"})
    urllib.request.urlopen(req, timeout=10).read()
    yield URL
    if proc:
        proc.terminate()


@pytest.fixture
def host(emulator, tmp_path, calibrator, monkeypatch):
    from fastapi.testclient import TestClient
    from nirnaya.api import create_app
    monkeypatch.delenv("NIRNAYA_RELAY_URL", raising=False)
    eng = Engine(Store(tmp_path / "host.db"), step_delay=0, calibrator=calibrator)
    with TestClient(create_app(eng, background=True)) as cl:
        cl.engine = eng
        yield cl


def until(fn, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        got = fn()
        if got:
            return got
        time.sleep(0.05)
    raise AssertionError("timed out")


def ask(code, member, method, path, body=None, za=True, ts=None):
    """What the member's app does: write a request, wait for its answer, remove the answer."""
    rid = f"t{time.time_ns()}"
    req = {"c": member, "m": method, "p": path, "who": member.title(), "ts": ts or {".sv": "timestamp"}}
    if body is not None:
        req.update(b=json.dumps(body), h={"ct": "application/json"})
    if za:
        req["za"] = 1
    assert rest("PUT", f"w/{code}/req/{rid}", req)[0] == 200
    res = until(lambda: rest("GET", f"w/{code}/res/{member}/{rid}")[1])
    rest("DELETE", f"w/{code}/res/{member}/{rid}")
    raw = zlib.decompress(base64.b64decode(res["z"])) if res.get("z") else (res.get("b") or "").encode()
    return res["s"], json.loads(raw) if raw else None, res


def events(code):
    ring = rest("GET", f"w/{code}/ev")[1] or {}
    out = []
    for slot in sorted(ring.values(), key=lambda s: s["n"]):
        raw = zlib.decompress(base64.b64decode(slot["z"])) if slot.get("z") else slot["b"].encode()
        out += json.loads(raw)
    return out


def test_create_join_and_work_with_the_hosts_agents(host):
    r = host.post("/api/workspace/create", json={"url": URL, "name": "Asha's workspace", "by": "Asha"}).json()
    code = r["hosting"]["code"]
    assert len(code) == 10 and set(code) <= set(relay.ALPHABET) and r["hosting"]["display"] == f"{code[:5]}-{code[5:]}"
    h = rest("GET", f"w/{code}/host")[1]
    assert h["name"] == "Asha's workspace" and isinstance(h["ts"], int) and h["offline"] is False
    until(lambda: host.get("/api/workspace").json()["hosting"]["connected"])

    s, state, res = ask(code, "ravi01", "GET", "/api/state")
    assert s == 200 and "agents" in state and res.get("z")            # big answers travel compressed
    s, health, res = ask(code, "ravi01", "GET", "/api/health", za=False)
    assert s == 200 and health["ok"] and "b" in res                   # small or uncompressible: plain text

    s, case, _ = ask(code, "ravi01", "POST", "/api/cases",
                     {"customer_id": "C-1002", "message": "I was charged twice ₹349 at CafeBrew yesterday", "by": "Ravi"})
    assert s == 201 and case["id"]
    until(lambda: (host.engine.store.get_case(case["id"]) or {}).get("status") == "resolved")
    mine = lambda: {e["kind"] for e in events(code) if case["id"] in (e.get("case_id"), (e.get("case") or {}).get("id"))}
    kinds = until(lambda: "case.finished" in mine() and mine())
    assert {"superstep", "decision.routed", "case.finished"} <= kinds
    assert rest("GET", f"w/{code}/req")[1] is None                     # every request was answered and removed


def test_only_the_host_changes_keys_settings_and_the_workspace(host):
    code = host.post("/api/workspace/create", json={"url": URL}).json()["hosting"]["code"]
    for method, path in [("PUT", "/api/llm"), ("PUT", "/api/channels"), ("POST", "/api/workspace/stop"),
                         ("POST", "/api/workspace/create"), ("GET", "/api/events"), ("POST", "/api/team/me")]:
        s, body, _ = ask(code, "ravi02", method, path, {})
        assert s == 403 and "host" in body["detail"], (method, path)
    assert ask(code, "ravi02", "GET", "/api/llm")[0] == 200            # reading is fine (keys are never shown)
    assert host.get("/api/workspace").json()["hosting"]["code"] == code


def test_members_show_up_in_the_hosts_team_and_leave(host):
    code = host.post("/api/workspace/create", json={"url": URL, "name": "Ops"}).json()["hosting"]["code"]
    rest("PUT", f"w/{code}/members/meera03", {"name": "Meera", "view": "approvals", "focus": None, "via": "apk",
                                               "ts": {".sv": "timestamp"}})
    people = until(lambda: [m for m in host.get("/api/workspace").json()["hosting"]["members"] if m["name"] == "Meera"])
    assert people[0]["via"] == "apk" and people[0]["view"] == "approvals"
    pres = until(lambda: [e for e in events(code) if e["kind"] == "presence" and any(p["name"] == "Meera" for p in e["people"])])
    meera = next(p for p in pres[-1]["people"] if p["name"] == "Meera")
    assert meera["remote"] and meera["client"] == "r-meera03"
    rest("DELETE", f"w/{code}/members/meera03")
    until(lambda: not host.get("/api/workspace").json()["hosting"]["members"])


def test_a_new_code_shuts_out_the_old_one_and_stop_removes_everything(host):
    old = host.post("/api/workspace/create", json={"url": URL}).json()["hosting"]["code"]
    new = host.post("/api/workspace/create", json={"url": None, "name": "again"}).json()["hosting"]["code"]
    assert new != old and rest("GET", f"w/{old}/host")[1] is None
    assert rest("PUT", f"w/{old}/req/x1", {"c": "m", "m": "GET", "p": "/api/state"})[0] in (401, 403)
    assert ask(new, "ravi04", "GET", "/api/health")[0] == 200
    assert host.post("/api/workspace/stop").json()["hosting"] is None
    assert rest("GET", f"w/{new}")[1] is None


def test_the_database_rules_keep_strangers_out(emulator):
    assert rest("GET", "w")[0] in (401, 403)                            # nobody can list workspaces
    assert rest("GET", "")[0] in (401, 403)
    assert rest("PUT", "w/NOHOST1234/req/x", {"c": "m", "m": "GET", "p": "/api/state"})[0] in (401, 403)
    assert rest("PUT", "w/bad/host", {"name": "x", "ts": 1})[0] in (401, 403)       # not a code
    assert rest("PUT", "w/ABCDE23456/host", {"name": "x", "ts": 1})[0] == 200
    assert rest("PUT", "w/ABCDE23456/req/x", {"c": "m", "m": "GET", "p": "/etc/passwd"})[0] in (401, 403)
    assert rest("PUT", "w/ABCDE23456/other", {"a": 1})[0] in (401, 403)
    assert rest("PUT", "w/ABCDE23456/members/m", {"view": "x"})[0] in (401, 403)     # needs a name
    rest("DELETE", "w/ABCDE23456")


def test_stale_requests_are_dropped_and_the_host_survives_a_restart(emulator, tmp_path, calibrator, monkeypatch):
    from fastapi.testclient import TestClient
    from nirnaya.api import create_app
    monkeypatch.setenv("NIRNAYA_ACCESS_KEY", "locked-down")          # relayed requests carry the host's own key
    db = tmp_path / "h.db"
    with TestClient(create_app(Engine(Store(db), step_delay=0, calibrator=calibrator))) as cl:
        code = cl.post("/api/workspace/create", headers={"X-Nirnaya-Key": "locked-down"},
                       json={"url": URL, "name": "Locked"}).json()["hosting"]["code"]
        until(lambda: cl.get("/api/workspace", headers={"X-Nirnaya-Key": "locked-down"}).json()["hosting"]["connected"])
        assert ask(code, "ravi05", "GET", "/api/state")[0] == 200
        rest("PUT", f"w/{code}/req/old1", {"c": "ravi05", "m": "POST", "p": "/api/cases", "ts": 1000})  # 1970
        until(lambda: rest("GET", f"w/{code}/req/old1")[1] is None)
        assert rest("GET", f"w/{code}/res/ravi05/old1")[1] is None   # dropped, never run
    assert rest("GET", f"w/{code}/host")[1]["offline"] is True          # the server stopped: members are told
    with TestClient(create_app(Engine(Store(db), step_delay=0, calibrator=calibrator))) as cl:
        assert cl.get("/api/workspace", headers={"X-Nirnaya-Key": "locked-down"}).json()["hosting"]["code"] == code
        until(lambda: rest("GET", f"w/{code}/host")[1]["offline"] is False)
        assert ask(code, "ravi05", "GET", "/api/health")[0] == 200       # same code after the restart
        cl.post("/api/workspace/stop", headers={"X-Nirnaya-Key": "locked-down"})


def test_setup_errors_say_what_to_do(host):
    r = host.post("/api/workspace/create", json={"url": "not a url"})
    assert r.status_code == 400 and "https://" in r.json()["detail"]
    for ns, rules, why in [("locked-project", {".read": False, ".write": False}, "refused"),
                           ("test-mode-project", {".read": True, ".write": True}, "open to everyone")]:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/.settings/rules.json?ns={ns}", method="PUT",
                                     data=json.dumps({"rules": rules}).encode(), headers={"Authorization": "Bearer owner"})
        urllib.request.urlopen(req, timeout=10).read()
        other = f"http://127.0.0.1:{PORT}/?ns={ns}"
        for r in (host.post("/api/workspace/check", json={"url": other}), host.post("/api/workspace/create", json={"url": other})):
            assert r.status_code == 400 and why in r.json()["detail"] and "database.rules.json" in r.json()["detail"], r.json()
    r = host.post("/api/workspace/create", json={"url": "http://127.0.0.1:9/"})
    assert r.status_code == 400 and "reach" in r.json()["detail"]
    assert host.post("/api/workspace/check", json={"url": URL}).json() == {"ok": True}
