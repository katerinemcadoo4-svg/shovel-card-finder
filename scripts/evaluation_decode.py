"""Decode one image from stdin for the Node evaluation CLI.

Requires Pillow. stdout is a 16-byte little-endian header
(original width, original height, decoded width, decoded height), followed by
RGBA bytes. No image data is sent over the network.
"""

import argparse
import io
import struct
import sys

try:
    from PIL import Image, ImageOps
except ImportError as exc:
    raise SystemExit("Pillow is required: python -m pip install Pillow") from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-dimension", type=int, required=True)
    args = parser.parse_args()
    if not 16 <= args.max_dimension <= 4096:
        raise SystemExit("max-dimension must be between 16 and 4096")

    data = sys.stdin.buffer.read(24 * 1024 * 1024 + 1)
    if len(data) > 24 * 1024 * 1024:
        raise SystemExit("image exceeds the 24 MB evaluation limit")
    try:
        with Image.open(io.BytesIO(data)) as source:
            source = ImageOps.exif_transpose(source)
            original_width, original_height = source.size
            if original_width < 16 or original_height < 16:
                raise ValueError("image is smaller than 16 pixels")
            if original_width * original_height > 80_000_000:
                raise ValueError("image exceeds 80 megapixels")
            scale = min(1.0, args.max_dimension / max(source.size))
            width = max(1, round(original_width * scale))
            height = max(1, round(original_height * scale))
            image = source.convert("RGBA")
            if scale < 1:
                image = image.resize((width, height), Image.Resampling.BILINEAR)
            sys.stdout.buffer.write(struct.pack("<IIII", original_width,
                                                original_height, width, height))
            sys.stdout.buffer.write(image.tobytes())
    except (OSError, ValueError) as exc:
        raise SystemExit(f"cannot decode image: {exc}") from exc


if __name__ == "__main__":
    main()
