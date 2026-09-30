"""The flags the desktop app starts the server with: --db/--web/--log, and --exit-with its window."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def health(port: int):
    try:
        return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1))
    except OSError:
        return None


def test_server_follows_its_window(tmp_path):
    window = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    port = free_port()
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>desktop web</title>")
    server = subprocess.Popen(
        [sys.executable, "-m", "nirnaya", "--port", str(port), "--db", str(tmp_path / "data" / "n.db"),
         "--web", str(web), "--log", str(tmp_path / "logs" / "n.log"), "--exit-with", str(window.pid)],
        cwd=BACKEND, env={**os.environ, "NIRNAYA_LLM": "off"})
    try:
        t0 = time.time()
        while time.time() - t0 < 30 and not health(port):
            assert server.poll() is None, (tmp_path / "logs" / "n.log").read_text()
            time.sleep(0.2)
        assert health(port)["ok"]
        page = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read().decode()
        assert "desktop web" in page  # --web is what gets served
        assert (tmp_path / "data" / "n.db").exists()  # --db folders are made
        assert "Uvicorn running" in (tmp_path / "logs" / "n.log").read_text()  # --log gets the output

        window.kill()
        window.wait()
        server.wait(timeout=10)  # --exit-with: gone once the window is
    finally:
        window.kill()
        server.kill()
