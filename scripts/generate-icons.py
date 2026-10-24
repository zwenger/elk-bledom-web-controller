"""Generates the app icons as pixel art: a 32x32 grid scaled up with nearest neighbour.

Usage (needs Pillow): python3 scripts/generate-icons.py
Writes icons/favicon-32.png, icon-192.png, icon-512.png, icon-maskable-512.png and apple-touch-icon.png.
"""

from pathlib import Path

from PIL import Image

GRID = 32
ICONS = Path(__file__).resolve().parent.parent / "icons"

PALETTE = {
    "X": (122, 24, 160),  # bulb outline
    "W": (255, 255, 255),  # highlight
    "S": (150, 156, 184),  # base, light
    "s": (92, 97, 124),  # base, dark
}
BACKGROUND = (20, 14, 40)
RING = (58, 38, 104)
HALO = (52, 26, 92)
HALO_DITHER = (36, 20, 66)
SPARKLES = [(6, 9, (90, 230, 255)), (25, 7, (255, 214, 90)), (24, 22, (120, 255, 160)), (7, 21, (255, 120, 200))]

# 12x16 bulb; "H" is the glowing glass, coloured by row from light pink to deep magenta
BULB = [
    "....XXXX....",
    "..XXHHHHXX..",
    ".XHHHWWHHHX.",
    ".XHHWWHHHHX.",
    "XHHHWHHHHHHX",
    "XHHHHHHHHHHX",
    "XHHHHHHHHHHX",
    "XHHHHHHHHHHX",
    ".XHHHHHHHHX.",
    ".XHHHHHHHHX.",
    "..XHHHHHHX..",
    "...XHHHHX...",
    "...XXXXXX...",
    "...SSSSSS...",
    "...ssssss...",
    "....SSSS....",
]
GLASS_TOP = (255, 150, 255)
GLASS_BOTTOM = (200, 40, 220)
BULB_X, BULB_Y = 10, 7


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw():
    image = Image.new("RGBA", (GRID, GRID), (0, 0, 0, 0))
    px = image.load()
    center = (GRID - 1) / 2
    glow_x, glow_y = BULB_X + 5.5, BULB_Y + 5.5
    for y in range(GRID):
        for x in range(GRID):
            distance = ((x - center) ** 2 + (y - center) ** 2) ** 0.5
            if distance > GRID / 2 - 0.7:
                continue
            color = RING if distance > GRID / 2 - 1.8 else BACKGROUND
            glow = ((x - glow_x) ** 2 + (y - glow_y) ** 2) ** 0.5
            if color == BACKGROUND and glow < 9:
                color = HALO
            elif color == BACKGROUND and glow < 12 and (x + y) % 2 == 0:
                color = HALO_DITHER
            px[x, y] = (*color, 255)

    for row, line in enumerate(BULB):
        glass = mix(GLASS_TOP, GLASS_BOTTOM, row / 11)
        for col, key in enumerate(line):
            if key == ".":
                continue
            px[BULB_X + col, BULB_Y + row] = (*(glass if key == "H" else PALETTE[key]), 255)

    # Four-point sparkles
    for x, y, color in SPARKLES:
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            px[x + dx, y + dy] = (*(color if (dx, dy) == (0, 0) else mix(color, BACKGROUND, 0.45)), 255)
    return image


def scaled(image, size, canvas=None, background=None):
    """Scales to `size` with hard pixels, centred on a `canvas`-sized square (optionally filled)."""
    canvas = canvas or size
    out = Image.new("RGBA", (canvas, canvas), (*background, 255) if background else (0, 0, 0, 0))
    big = image.resize((size, size), Image.NEAREST)
    offset = (canvas - size) // 2
    out.alpha_composite(big, (offset, offset))
    return out


def main():
    icon = draw()
    scaled(icon, 32).save(ICONS / "favicon-32.png")
    scaled(icon, 192).save(ICONS / "icon-192.png")
    scaled(icon, 512).save(ICONS / "icon-512.png")
    # Maskable icons get cropped to the inner 80%: keep the circle inside it on a full background
    scaled(icon, 384, canvas=512, background=(0, 0, 0)).save(ICONS / "icon-maskable-512.png")
    # iOS fills transparency with black and rounds the corners itself
    scaled(icon, 160, canvas=180, background=(0, 0, 0)).convert("RGB").save(ICONS / "apple-touch-icon.png")


if __name__ == "__main__":
    main()
