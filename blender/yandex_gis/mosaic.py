# Сборка мозаики из тайлов, запись PNG и выборка высот.
# Тайлы декодирует Blender (bpy.data.images.load), дальше всё на numpy.

import math
import os
import struct
import zlib

import numpy as np

from . import geo


def read_tile(path):
    """RGBA uint8, строки сверху вниз. None, если файл не читается —
    тогда он удаляется из кэша, чтобы при следующем запуске скачаться заново."""
    import bpy
    try:
        img = bpy.data.images.load(path, check_existing=False)
    except RuntimeError:
        img = None
    w = h = 0
    if img is not None:
        try:
            w, h = img.size
            if w and h:
                buf = np.empty(w * h * 4, np.float32)
                img.pixels.foreach_get(buf)
        finally:
            bpy.data.images.remove(img)
    if not (w and h):
        try:
            os.remove(path)
        except OSError:
            pass
        return None
    # Для 8-битных картинок pixels — это сырые байты / 255, без цветокоррекции
    return (buf.reshape(h, w, 4)[::-1] * 255 + 0.5).astype(np.uint8)


def _fit(arr, size):
    h, w = arr.shape[:2]
    if (h, w) == (size, size):
        return arr
    iy = (np.arange(size) * h // size)
    ix = (np.arange(size) * w // size)
    return arr[iy][:, ix]


def tile_range(px0, py0, px1, py1, tile):
    return (int(px0 // tile), int(py0 // tile),
            int(math.ceil(px1 / tile)) - 1, int(math.ceil(py1 / tile)) - 1)


def build(downloader, source, zoom, px0, py0, px1, py1, progress=None):
    """Мозаика на окно глобальных пикселей [px0, px1) × [py0, py1).
    Возвращает (RGBA uint8, число отсутствующих тайлов, список ошибок сети)."""
    t = source.tile_px
    tx0, ty0, tx1, ty1 = tile_range(px0, py0, px1, py1, t)
    coords = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    files, errors = downloader.fetch(source, zoom, coords, progress)

    out = np.zeros(((ty1 - ty0 + 1) * t, (tx1 - tx0 + 1) * t, 4), np.uint8)
    missing = 0
    for (x, y), path in files.items():
        if not path:
            missing += 1
            continue
        tile = read_tile(path)
        if tile is None:
            missing += 1
            continue
        oy, ox = (y - ty0) * t, (x - tx0) * t
        out[oy:oy + t, ox:ox + t] = _fit(tile, t)
    ox0, oy0 = px0 - tx0 * t, py0 - ty0 * t
    return out[oy0:oy0 + (py1 - py0), ox0:ox0 + (px1 - px0)], missing, errors


def alpha_over(base, over):
    a = over[..., 3:4].astype(np.float32) / 255
    rgb = over[..., :3] * a + base[..., :3] * (1 - a)
    base[..., :3] = (rgb + 0.5).astype(np.uint8)
    base[..., 3] = np.maximum(base[..., 3], over[..., 3])
    return base


def fill_missing(arr, rgb=(200, 200, 200)):
    hole = arr[..., 3] == 0
    arr[hole, :3] = rgb
    arr[..., 3] = 255
    return arr


def write_png(path, arr, level=6):
    """Минимальный PNG-энкодер: не гоняем гигапиксели через float-буфер Blender."""
    h, w, c = arr.shape
    raw = np.zeros((h, w * c + 1), np.uint8)  # нулевой байт фильтра в начале строки
    raw[:, 1:] = arr.reshape(h, w * c)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6 if c == 4 else 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw.tobytes(), level)))
        f.write(chunk(b"IEND", b""))


# --- Рельеф -------------------------------------------------------------------

class Terrain:
    """Сетка высот в пиксельных координатах источника + билинейная выборка."""

    def __init__(self, heights, px0, py0, zoom, source):
        self.h = heights
        self.px0, self.py0 = px0, py0
        self.zoom = zoom
        self.source = source

    @classmethod
    def load(cls, downloader, source, zoom, lat_min, lon_min, lat_max, lon_max, progress=None):
        ell, t = source.ellipsoidal, source.tile_px
        x0, y0 = geo.latlon_to_px(lat_max, lon_min, zoom, ell, t)
        x1, y1 = geo.latlon_to_px(lat_min, lon_max, zoom, ell, t)
        px0, py0 = int(math.floor(x0)) - 1, int(math.floor(y0)) - 1
        px1, py1 = int(math.ceil(x1)) + 2, int(math.ceil(y1)) + 2
        rgba, missing, errors = build(downloader, source, zoom, px0, py0, px1, py1, progress)
        rgb = rgba[..., :3].astype(np.float32)
        # Terrarium: высота = R·256 + G + B/256 − 32768
        heights = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
        heights[rgba[..., 3] == 0] = 0
        return cls(heights, px0, py0, zoom, source), missing, errors

    def sample(self, lats, lons):
        ell, t = self.source.ellipsoidal, self.source.tile_px
        pts = [geo.latlon_to_px(la, lo, self.zoom, ell, t) for la, lo in zip(lats, lons)]
        p = np.asarray(pts, np.float64).reshape(-1, 2)
        h, w = self.h.shape
        u = np.clip(p[:, 0] - self.px0 - 0.5, 0, w - 1.000001)
        v = np.clip(p[:, 1] - self.py0 - 0.5, 0, h - 1.000001)
        i, j = np.floor(u).astype(int), np.floor(v).astype(int)
        fu, fv = u - i, v - j
        g = self.h
        return ((g[j, i] * (1 - fu) + g[j, i + 1] * fu) * (1 - fv)
                + (g[j + 1, i] * (1 - fu) + g[j + 1, i + 1] * fu) * fv)
