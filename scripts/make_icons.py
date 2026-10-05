"""Generate the three PNG icons from the app's simple star mark."""

from math import cos, pi, sin
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"


def make_icon(size: int, filename: str) -> None:
    scale = 4
    side = size * scale
    image = Image.new("RGB", (side, side), "#111b2b")
    draw = ImageDraw.Draw(image)
    center = side / 2
    points = []
    for index in range(8):
        angle = -pi / 2 + index * pi / 4
        radius = side * (0.355 if index % 2 == 0 else 0.105)
        points.append((center + cos(angle) * radius, center + sin(angle) * radius))
    draw.polygon(points, fill="#e5bd70")
    radius = side * 0.057
    draw.ellipse((center - radius, center - radius, center + radius, center + radius), fill="#111b2b")
    image.resize((size, size), Image.Resampling.LANCZOS).save(OUT / filename, optimize=True)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    make_icon(180, "apple-touch-icon.png")
