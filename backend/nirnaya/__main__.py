"""Run Nirnaya: `python -m nirnaya` serves the API and the web app on http://127.0.0.1:8000."""
import argparse
import os


def main() -> None:
    p = argparse.ArgumentParser(prog="nirnaya", description="Nirnaya: the support teammate that knows when to stop")
    p.add_argument("--host", default=os.environ.get("NIRNAYA_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("NIRNAYA_PORT", "8000")))
    p.add_argument("--db", help="SQLite file (default backend/data/nirnaya.db)")
    p.add_argument("--reset", action="store_true", help="start from an empty database")
    args = p.parse_args()
    if args.db:
        os.environ["NIRNAYA_DB"] = args.db
    if args.reset:
        from .store import Store
        path = Store().path
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(path + suffix):
                os.remove(path + suffix)
    import uvicorn
    from .api import create_app
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
