# Источники тайлов и загрузка с дисковым кэшем. Без bpy.

import os
import random
import urllib.error
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


class Source:
    """url — шаблон с {x} {y} {z} (+ {scale} {lang} {s}).
    ellipsoidal=True — EPSG:3395 (Яндекс), False — EPSG:3857 (все остальные)."""

    def __init__(self, key, name, url, ellipsoidal, max_zoom, scale=1,
                 overlay=None, referer=None, subdomains=""):
        self.key = key
        self.name = name
        self.url = url
        self.ellipsoidal = ellipsoidal
        self.max_zoom = max_zoom
        self.scale = scale
        self.overlay = overlay      # Source, накладывается сверху по альфе
        self.referer = referer
        self.subdomains = subdomains

    @property
    def tile_px(self):
        return 256 * self.scale

    def tile_url(self, x, y, z, lang="ru_RU"):
        return self.url.format(x=x, y=y, z=z, scale=self.scale, lang=lang,
                               s=random.choice(self.subdomains) if self.subdomains else "")


YA_REFERER = "https://yandex.ru/maps/"
YA_MAP = ("https://core-renderer-tiles.maps.yandex.net/tiles"
          "?l=map&x={x}&y={y}&z={z}&scale={scale}&lang={lang}")
YA_SKL = ("https://core-renderer-tiles.maps.yandex.net/tiles"
          "?l=skl&x={x}&y={y}&z={z}&scale={scale}&lang={lang}")
YA_SAT = "https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang={lang}"

TERRARIUM = Source("TERRARIUM", "AWS Terrain Tiles",
                   "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
                   ellipsoidal=False, max_zoom=15)


def basemap_source(key, prefs):
    """Собирает Source по ключу из UI. prefs — настройки аддона (или None)."""
    scale = 2 if prefs is not None and prefs.retina else 1
    if key == "YA_MAP":
        return Source(key, "Яндекс Схема", YA_MAP, True, 21, scale, referer=YA_REFERER)
    if key == "YA_SAT":
        return Source(key, "Яндекс Спутник", YA_SAT, True, 20, referer=YA_REFERER)
    if key == "YA_HYBRID":
        skl = Source("YA_SKL", "Яндекс подписи", YA_SKL, True, 21, 1, referer=YA_REFERER)
        return Source(key, "Яндекс Гибрид", YA_SAT, True, 20, referer=YA_REFERER, overlay=skl)
    if key == "OSM":
        return Source(key, "OpenStreetMap", "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                      False, 19)
    if key == "CUSTOM":
        if prefs is None or not prefs.custom_url:
            raise ValueError("Шаблон своего источника не задан в настройках аддона")
        return Source(key, "Свой источник", prefs.custom_url, prefs.custom_ellipsoidal,
                      prefs.custom_max_zoom, referer=prefs.custom_referer or None,
                      subdomains=prefs.custom_subdomains)
    raise ValueError("Неизвестный источник: %s" % key)


def _ext_for(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


class Downloader:
    def __init__(self, cache_dir, user_agent=DEFAULT_UA, threads=8, lang="ru_RU", timeout=20):
        self.cache_dir = cache_dir
        self.user_agent = user_agent or DEFAULT_UA
        self.threads = max(1, threads)
        self.lang = lang
        self.timeout = timeout

    def _tile_dir(self, source, z):
        key = source.key if source.key != "CUSTOM" else "CUSTOM_%08x" % zlib.crc32(source.url.encode())
        return os.path.join(self.cache_dir, "%s@%d" % (key, source.scale), str(z))

    def _cached(self, d, x, y):
        for ext in (".png", ".jpg", ".webp", ".none"):
            p = os.path.join(d, "%d_%d%s" % (x, y, ext))
            if os.path.exists(p):
                return p
        return None

    def fetch_one(self, source, x, y, z):
        """Путь к файлу тайла или None, если тайла нет (404 / пустышка)."""
        n = 2 ** z
        if y < 0 or y >= n:
            return None
        x %= n  # перенос через 180-й меридиан
        d = self._tile_dir(source, z)
        hit = self._cached(d, x, y)
        if hit:
            return None if hit.endswith(".none") else hit

        req = urllib.request.Request(source.tile_url(x, y, z, self.lang))
        req.add_header("User-Agent", self.user_agent)
        if source.referer:
            req.add_header("Referer", source.referer)
        data = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code in (404, 204):
                    break
                if attempt == 2:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt == 2:
                    raise

        os.makedirs(d, exist_ok=True)
        ext = _ext_for(data) if data else None
        if not ext:
            # Запоминаем отсутствие тайла, чтобы не долбить сервер повторно
            open(os.path.join(d, "%d_%d.none" % (x, y)), "wb").close()
            return None
        path = os.path.join(d, "%d_%d%s" % (x, y, ext))
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return path

    def fetch(self, source, z, coords, progress=None):
        """coords — список (x, y). Возвращает {(x, y): path|None}.
        Ошибки сети собираются, а не роняют всю загрузку."""
        result, errors = {}, []
        with ThreadPoolExecutor(self.threads) as pool:
            futures = {pool.submit(self.fetch_one, source, x, y, z): (x, y) for x, y in coords}
            for i, (fut, xy) in enumerate(futures.items()):
                try:
                    result[xy] = fut.result()
                except Exception as e:  # noqa: BLE001 — показываем пользователю
                    result[xy] = None
                    errors.append(str(e))
                if progress:
                    progress(i + 1, len(futures))
        if errors and len(errors) == len(coords):
            raise RuntimeError("Не удалось скачать ни одного тайла: %s" % errors[0])
        return result, errors
