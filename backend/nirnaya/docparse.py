"""Evidence documents: bank statements, merchant emails, screenshots of a failed payment.

Parsers are pluggable and optional, best first: MinerU (layout-aware PDF → Markdown; its licence asks
for attribution when used in an online service), pypdf text extraction, Tesseract OCR for images.
Whatever text comes out is tokenised before anyone reads it, then mined for UTRs, amounts and dates.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .understand import extract_entities


def available() -> dict:
    try:
        import pypdf  # noqa: F401
        has_pypdf = True
    except ImportError:
        has_pypdf = False
    return {"mineru": shutil.which("mineru") is not None, "pypdf": has_pypdf,
            "tesseract": shutil.which("tesseract") is not None}


def _mineru(path: Path) -> str | None:
    with tempfile.TemporaryDirectory() as out:
        try:
            subprocess.run(["mineru", "-p", str(path), "-o", out], check=True, capture_output=True, timeout=300)
        except (subprocess.SubprocessError, OSError):
            return None
        mds = list(Path(out).rglob("*.md"))
        return "\n\n".join(m.read_text(errors="ignore") for m in mds) if mds else None


def _pypdf(path: Path) -> str | None:
    try:
        from pypdf import PdfReader
        return "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
    except Exception:
        return None


def _tesseract(path: Path) -> str | None:
    try:
        r = subprocess.run(["tesseract", str(path), "-", "--psm", "6"], check=True, capture_output=True, timeout=60)
        return r.stdout.decode(errors="ignore")
    except (subprocess.SubprocessError, OSError):
        return None


def parse(path: Path, tokenise) -> dict:
    kind = path.suffix.lower()
    have = available()
    text, engine = None, None
    if kind == ".pdf":
        if have["mineru"]:
            text, engine = _mineru(path), "mineru"
        if not text and have["pypdf"]:
            text, engine = _pypdf(path), "pypdf"
    elif kind in (".png", ".jpg", ".jpeg", ".webp") and have["tesseract"]:
        text, engine = _tesseract(path), "tesseract"
    elif kind in (".txt", ".md", ".eml", ".csv"):
        text, engine = path.read_text(errors="ignore"), "text"
    if not text:
        return {"ok": False, "engine": engine, "reason": "no parser available for this file type", "available": have}
    safe, found = tokenise(text)
    utrs = re.findall(r"\b\d{12}\b", text)
    ent = extract_entities(safe)
    return {"ok": True, "engine": engine, "chars": len(text), "text": safe[:4000], "pii": found,
            "utrs": sorted(set(utrs))[:10], "entities": ent, "attribution": "MinerU" if engine == "mineru" else None}
