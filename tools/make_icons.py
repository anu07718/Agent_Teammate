"""Draw the Nirnaya mark (the "N" from web/public/favicon.svg) as the desktop and phone icons.

    python tools/make_icons.py          # needs Pillow; writes exe/assets and apk/android res icons
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BLUE, WHITE = (91, 124, 250, 255), (255, 255, 255, 255)
N = [(9, 23), (9, 9), (23, 23), (23, 9)]  # the favicon's path on its 32×32 grid


def mark(size: int, *, rounded: bool = True, pad: float = 0.0, background: bool = True) -> Image.Image:
    """The mark at `size` px. `pad` shrinks the N toward the middle (Android's adaptive-icon safe zone)."""
    big = size * 8
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if background:
        if rounded:
            d.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 8 // 32, fill=BLUE)
        else:
            d.rectangle((0, 0, big - 1, big - 1), fill=BLUE)
    scale = big / 32 * (1 - pad)
    off = big * pad / 2
    pts = [(x * scale + off, y * scale + off) for x, y in N]
    w = round(3.2 * scale)
    d.line(pts, fill=WHITE, width=w, joint="curve")
    for x, y in pts:  # round caps and joins
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


def desktop() -> None:
    out = ROOT / "exe"
    (out / "assets").mkdir(parents=True, exist_ok=True)
    (out / "resources" / "icons").mkdir(parents=True, exist_ok=True)
    mark(256).save(out / "resources" / "icons" / "appIcon.png")
    mark(256).save(out / "assets" / "nirnaya.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    # the installer's side picture (164×314) and header (150×57), as 24-bit BMPs for NSIS
    side = Image.new("RGB", (164, 314), BLUE[:3])
    side.paste(mark(112, background=False), (26, 90), mark(112, background=False))
    side.save(out / "assets" / "installer-side.bmp")
    head = Image.new("RGB", (150, 57), (255, 255, 255))
    head.paste(mark(41), (100, 8), mark(41))
    head.save(out / "assets" / "installer-header.bmp")


DENSITY = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def phone() -> None:
    res = ROOT / "apk" / "android" / "app" / "src" / "main" / "res"
    if not res.exists():
        print("apk/android not generated yet; skipping phone icons")
        return
    for name, k in DENSITY.items():
        d = res / f"mipmap-{name}"
        d.mkdir(exist_ok=True)
        mark(round(48 * k)).save(d / "ic_launcher.png")
        round_icon = mark(round(48 * k), rounded=False)
        m = Image.new("L", round_icon.size, 0)
        ImageDraw.Draw(m).ellipse((0, 0, round_icon.size[0] - 1, round_icon.size[1] - 1), fill=255)
        round_icon.putalpha(m)
        round_icon.save(d / "ic_launcher_round.png")
        # adaptive icon: 108dp layers, the mark kept inside the middle 66dp
        mark(round(108 * k), background=False, pad=0.42).save(d / "ic_launcher_foreground.png")
    # launch screens: the mark in the middle of a white screen, at each size Capacitor ships
    for f in res.glob("drawable*/splash.png"):
        w, h = Image.open(f).size
        side = round(min(w, h) * 0.22)
        splash = Image.new("RGB", (w, h), (255, 255, 255))
        splash.paste(mark(side), ((w - side) // 2, (h - side) // 2), mark(side))
        splash.save(f)
    (res / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#5B7CFA</color>\n</resources>\n')


if __name__ == "__main__":
    desktop()
    phone()
    print("icons written")
