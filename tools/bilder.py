#!/usr/bin/env python3
"""Fotos für die Website vorbereiten.

Erzeugt aus einem Foto zwei WebP-Dateien (800 px und 1600 px breit),
dreht das Bild richtig herum und entfernt alle Metadaten (z. B. GPS).

    pip install pillow
    python3 tools/bilder.py foto.jpg public/assets/img/news/mein-beitrag/foto

Ergebnis:
    public/assets/img/news/mein-beitrag/foto-800.webp
    public/assets/img/news/mein-beitrag/foto-1600.webp

Im Markdown dann einfach den 1600er-Pfad verwenden:
    ![Beschreibung](/assets/img/news/mein-beitrag/foto-1600.webp)
Die 800er-Version wird beim Bauen automatisch als kleinere Variante eingebunden.
"""
import sys
from pathlib import Path

from PIL import Image, ImageOps

WIDTHS = (800, 1600)
QUALITY = 80


def convert(src: Path, dest_base: Path) -> None:
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    dest_base.parent.mkdir(parents=True, exist_ok=True)
    for width in WIDTHS:
        if img.width < width and width != WIDTHS[0]:
            # Nicht hochskalieren: größte Variante = Originalgröße
            out = img
        elif img.width > width:
            height = round(img.height * width / img.width)
            out = img.resize((width, height), Image.LANCZOS)
        else:
            out = img
        target = dest_base.with_name(f"{dest_base.name}-{width}.webp")
        out.save(target, "WEBP", quality=QUALITY, method=6)
        print(f"{target}  {out.width}x{out.height}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    convert(Path(sys.argv[1]), Path(sys.argv[2]))
