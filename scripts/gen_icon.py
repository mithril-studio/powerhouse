"""Generate Powerhouse app icons: black filled mark with white glow, no dots/arcs."""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

def make_icon(size: int) -> Image.Image:
    s = size

    # ── background ───────────────────────────────────────────────────────────
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(img)
    r = round(s * 0.219)            # ~22% corner radius (macOS style)
    bg_color = (10, 11, 16, 255)    # #0a0b10 – very dark navy-black
    bg_draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=bg_color)

    # ── logo mark: two overlapping solid circles (no holes) ──────────────────
    # Proportions derived from the Tauri logo silhouette, centered on the tile.
    # Circle 1 – upper-left offset
    cr = round(s * 0.235)           # circle radius ≈ 23.5% of tile
    # centres placed so the pair sits centred, overlapping by ~40% of radius
    offset = round(s * 0.115)       # distance each centre shifts from tile centre
    cx1 = round(s * 0.5) - offset
    cy1 = round(s * 0.5) - offset
    # Circle 2 – lower-right offset
    cx2 = round(s * 0.5) + offset
    cy2 = round(s * 0.5) + offset

    # ── glow layer: white blurred silhouette behind the mark ─────────────────
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gc = (210, 215, 255, 220)       # cool-white glow tint
    gd.ellipse([cx1 - cr, cy1 - cr, cx1 + cr, cy1 + cr], fill=gc)
    gd.ellipse([cx2 - cr, cy2 - cr, cx2 + cr, cy2 + cr], fill=gc)
    blur_r = max(2, round(s * 0.075))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=blur_r))

    # ── mark layer: pure-black filled circles on transparent ─────────────────
    mark = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    md = ImageDraw.Draw(mark)
    mc = (0, 0, 0, 255)
    md.ellipse([cx1 - cr, cy1 - cr, cx1 + cr, cy1 + cr], fill=mc)
    md.ellipse([cx2 - cr, cy2 - cr, cx2 + cr, cy2 + cr], fill=mc)

    # ── composite ────────────────────────────────────────────────────────────
    result = Image.alpha_composite(img, glow)
    result = Image.alpha_composite(result, mark)

    # Clip to rounded rectangle so the transparent corners are clean.
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    result.putalpha(mask)

    return result


def save_rgba(img: Image.Image, path: str, size=None) -> None:
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG")


# ── generate master at 1024 ──────────────────────────────────────────────────
master = make_icon(1024)

sizes = {
    "icon.png":                1024,
    "128x128.png":              128,
    "128x128@2x.png":           256,
    "32x32.png":                 32,
    "Square30x30Logo.png":       30,
    "Square44x44Logo.png":       44,
    "Square71x71Logo.png":       71,
    "Square89x89Logo.png":       89,
    "Square107x107Logo.png":    107,
    "Square142x142Logo.png":    142,
    "Square150x150Logo.png":    150,
    "Square284x284Logo.png":    284,
    "Square310x310Logo.png":    310,
    "StoreLogo.png":             50,
}

os.makedirs(ICON_DIR, exist_ok=True)

for filename, px in sizes.items():
    path = os.path.join(ICON_DIR, filename)
    save_rgba(master, path, px)
    print(f"  {filename:35s} {px}px")

# ── icns (macOS) ─────────────────────────────────────────────────────────────
try:
    import subprocess, tempfile, shutil

    tmpdir = tempfile.mkdtemp()
    iconset = os.path.join(tmpdir, "icon.iconset")
    os.makedirs(iconset)

    icns_sizes = [16, 32, 64, 128, 256, 512, 1024]
    for px in icns_sizes:
        img = master.resize((px, px), Image.LANCZOS)
        img.save(os.path.join(iconset, f"icon_{px}x{px}.png"))
        if px <= 512:
            img2 = master.resize((px * 2, px * 2), Image.LANCZOS)
            img2.save(os.path.join(iconset, f"icon_{px}x{px}@2x.png"))

    icns_path = os.path.join(ICON_DIR, "icon.icns")
    result = subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", icns_path],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"  {'icon.icns':35s} (macOS bundle)")
    else:
        print(f"  icon.icns FAILED: {result.stderr.decode()}")
    shutil.rmtree(tmpdir)
except Exception as e:
    print(f"  icon.icns skipped: {e}")

# ── ico (Windows) ────────────────────────────────────────────────────────────
try:
    ico_path = os.path.join(ICON_DIR, "icon.ico")
    frames = [master.resize((px, px), Image.LANCZOS).convert("RGBA")
              for px in [16, 24, 32, 48, 64, 128, 256]]
    frames[0].save(ico_path, format="ICO", sizes=[(f.width, f.height) for f in frames],
                   append_images=frames[1:])
    print(f"  {'icon.ico':35s} (Windows)")
except Exception as e:
    print(f"  icon.ico skipped: {e}")

print("\nDone.")
