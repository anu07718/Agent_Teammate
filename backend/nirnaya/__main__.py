"""Run Nirnaya: `python -m nirnaya` serves the API and the web app on http://127.0.0.1:8000."""
import argparse
import os
import sys
import threading
import time


def _exit_with(pid: int) -> None:
    """Stop this server when the process that started it (the desktop window) goes away."""
    def watch() -> None:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if handle:
                k32.WaitForSingleObject(handle, 0xFFFFFFFF)
                os._exit(0)
        while True:
            try:
                os.kill(pid, 0)
            except (ProcessLookupError, PermissionError, OSError):
                os._exit(0)
            time.sleep(1.0)
    threading.Thread(target=watch, name="exit-with", daemon=True).start()


def main() -> None:
    p = argparse.ArgumentParser(prog="nirnaya", description="Nirnaya: the support teammate that knows when to stop")
    p.add_argument("--host", default=os.environ.get("NIRNAYA_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("NIRNAYA_PORT", "8000")))
    p.add_argument("--db", help="SQLite file (default backend/data/nirnaya.db)")
    p.add_argument("--web", help="folder with the built web app (default web/dist)")
    p.add_argument("--reset", action="store_true", help="start from an empty database")
    p.add_argument("--log", help="write the server log to this file (the desktop app runs without a console)")
    p.add_argument("--exit-with", type=int, metavar="PID", help="stop when this process exits")
    args = p.parse_args()
    if args.log:
        os.makedirs(os.path.dirname(os.path.abspath(args.log)), exist_ok=True)
        sys.stdout = sys.stderr = open(args.log, "a", buffering=1, encoding="utf-8")
    if args.db:
        os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
        os.environ["NIRNAYA_DB"] = args.db
    if args.web:
        os.environ["NIRNAYA_WEB"] = args.web
    if args.reset:
        from .store import Store
        store = Store()
        path = store.path
        store.db.close()  # Windows will not delete an open file
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(path + suffix):
                os.remove(path + suffix)
    if args.exit_with:
        _exit_with(args.exit_with)
    import uvicorn
    from .api import create_app
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info", use_colors=False if args.log else None)


if __name__ == "__main__":
    main()
