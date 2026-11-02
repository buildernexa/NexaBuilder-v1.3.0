#!/usr/bin/env python3
"""Generate standard and adaptive Android launcher icons from a supplied image."""
from __future__ import annotations
import argparse
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

LIME = (212, 255, 0, 255)
INK = (23, 23, 23, 255)
WHITE = (255, 255, 255, 255)
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def fail(msg: str) -> None:
    print(f"NEXABUILDER_ICON_ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def default_mark() -> Image.Image:
    im = Image.new("RGBA", (1024, 1024), LIME)
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle((44, 44, 980, 980), radius=120, outline=INK, width=42)
    # Bold geometric N, with a clear silhouette at small launcher sizes.
    draw.polygon([(235, 750), (235, 274), (355, 274), (675, 574), (675, 274), (790, 274), (790, 750), (676, 750), (350, 446), (350, 750)], fill=WHITE, outline=INK)
    return im


def load_source(path: Path | None) -> Image.Image:
    if path is None:
        return default_mark()
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
        fail("File ikon tidak ditemukan atau melebihi 2 MB.")
    try:
        with Image.open(path) as source:
            source.load()
            image = source.convert("RGBA")
    except Exception as error:
        fail(f"Format ikon tidak dapat dibaca: {error}")
    if image.width < 32 or image.height < 32 or image.width > 8192 or image.height > 8192:
        fail("Resolusi ikon harus berada antara 32 dan 8192 piksel.")
    background = Image.new("RGBA", image.size, LIME)
    background.alpha_composite(image)
    return ImageOps.fit(background.convert("RGBA"), (1024, 1024), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--android-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    res = args.android_dir / "app" / "src" / "main" / "res"
    if not res.is_dir(): fail("Folder resource Android tidak ditemukan.")
    base = load_source(args.source)

    # Legacy icons used by older launchers.
    for density, size in DENSITIES.items():
        target = res / f"mipmap-{density}"
        target.mkdir(parents=True, exist_ok=True)
        legacy = base.resize((size, size), Image.Resampling.LANCZOS)
        legacy.save(target / "ic_launcher.png", optimize=True)
        legacy.save(target / "ic_launcher_round.png", optimize=True)

        # Adaptive foreground uses a safe central region so Android's mask won't clip the mark.
        adaptive_size = ADAPTIVE_SIZES[density]
        safe_edge = int(adaptive_size * 0.68)
        foreground_mark = ImageOps.contain(base, (safe_edge, safe_edge), method=Image.Resampling.LANCZOS)
        foreground = Image.new("RGBA", (adaptive_size, adaptive_size), (0, 0, 0, 0))
        foreground.alpha_composite(foreground_mark, ((adaptive_size - foreground_mark.width) // 2, (adaptive_size - foreground_mark.height) // 2))
        foreground.save(target / "ic_launcher_foreground.png", optimize=True)

    adaptive_dir = res / "mipmap-anydpi-v26"
    adaptive_dir.mkdir(parents=True, exist_ok=True)
    adaptive_xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
'''
    (adaptive_dir / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (adaptive_dir / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")
    values_dir = res / "values"
    values_dir.mkdir(parents=True, exist_ok=True)
    (values_dir / "ic_launcher_background.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<resources><color name="ic_launcher_background">#D4FF00</color></resources>
''', encoding="utf-8")
    print("NEXABUILDER_ICON_READY: launcher icons and adaptive icon resources generated.")


if __name__ == "__main__":
    main()
