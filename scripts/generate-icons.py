"""Generate launcher assets from the existing rmdex logo (requires Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android" / "app" / "src" / "main" / "res"
SOURCE = ROOT / "src" / "assets" / "rmdex-logo.jpg"
logo = Image.open(SOURCE).convert("RGB")


def square(size: int, scale: float = 1) -> Image.Image:
    image = Image.new("RGBA", (size, size), "white")
    edge = round(size * scale)
    image.paste(logo.resize((edge, edge), Image.Resampling.LANCZOS), ((size - edge) // 2, (size - edge) // 2))
    return image


for density, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    directory = RES / f"mipmap-{density}"
    directory.mkdir(parents=True, exist_ok=True)
    icon = square(size)
    icon.save(directory / "ic_launcher.png")
    mask = Image.new("L", (size * 4, size * 4))
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    rounded = icon.copy()
    rounded.putalpha(mask.resize((size, size), Image.Resampling.LANCZOS))
    rounded.save(directory / "ic_launcher_round.png")
    square(round(size * 2.25), 0.72).save(directory / "ic_launcher_foreground.png")

windows = square(1024)
mask = Image.new("L", (1024, 1024))
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 1023, 1023), radius=205, fill=255)
windows.putalpha(mask)
windows.save(ROOT / "pc" / "windows" / "rmdex.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
