"""Create deliberately non-independent images for a CLI plumbing smoke test."""

import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/make_evaluation_smoke.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    fixtures = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "generated"
    cases = []
    for hero, category, variant, position in [
        ("synthetic-blue", "game", "card", (51, 73)),
        ("synthetic-amber", "splash", "splash", (91, 107)),
    ]:
        # These are pasted straight from reference art. They test file loading,
        # localization, and reporting, but not generalization to new captures.
        with Image.open(fixtures / f"{hero}-{variant}.png") as source:
            canvas = Image.new("RGB", (780, 640), (12, 22, 38))
            canvas.paste(source.convert("RGB"), position)
        filename = f"{hero}-{category}.png"
        canvas.save(output / filename)
        cases.append({"id": filename.removesuffix(".png"), "category": category,
                      "expectedHeroId": hero, "path": filename})

    randomizer = random.Random(2031)
    unknown = Image.new("RGB", (780, 640), (220, 225, 230))
    draw = ImageDraw.Draw(unknown)
    for _ in range(60):
        x, y = randomizer.randrange(780), randomizer.randrange(640)
        color = tuple(randomizer.randrange(70, 215) for _ in range(3))
        draw.ellipse((x, y, x + 12, y + 12), fill=color)
    unknown.save(output / "unknown-dots.png")
    cases.append({"id": "unknown-dots", "category": "unknown",
                  "path": "unknown-dots.png"})
    manifest = {"schemaVersion": 1, "datasetKind": "synthetic-smoke",
                "seasonId": "synthetic-test-only", "patch": "test-0", "cases": cases}
    (output / "cases.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(output / "cases.json")


if __name__ == "__main__":
    main()
