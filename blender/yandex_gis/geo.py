# Чистая математика без bpy: проекции, тайловая сетка, разбор ссылок.
# Модуль можно импортировать и тестировать вне Blender.

import math
from urllib.parse import urlparse, parse_qs, unquote

# Эллипсоид WGS84
A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
E = math.sqrt(E2)
EP2 = E2 / (1 - E2)

TILE = 256
HALF = math.pi * A  # половина ширины мира в метрах Меркатора
MAX_LAT_3857 = 85.0511287798066
MAX_LAT_3395 = 85.0840590501104


# --- Меркатор ---------------------------------------------------------------
# У Яндекса эллипсоидальный Меркатор (EPSG:3395), у OSM/Google/Terrarium —
# сферический (EPSG:3857). Разница по вертикали на широте Москвы ~20 км,
# поэтому смешивать их без пересчёта нельзя.

def merc_forward(lat, lon, ellipsoidal):
    lat_max = MAX_LAT_3395 if ellipsoidal else MAX_LAT_3857
    phi = math.radians(max(-lat_max, min(lat_max, lat)))
    x = A * math.radians(lon)
    if ellipsoidal:
        es = E * math.sin(phi)
        y = A * math.log(math.tan(math.pi / 4 + phi / 2) * ((1 - es) / (1 + es)) ** (E / 2))
    else:
        y = A * math.log(math.tan(math.pi / 4 + phi / 2))
    return x, y


def merc_inverse(x, y, ellipsoidal):
    lon = math.degrees(x / A)
    t = math.exp(-y / A)
    phi = math.pi / 2 - 2 * math.atan(t)
    if ellipsoidal:
        for _ in range(15):
            es = E * math.sin(phi)
            nxt = math.pi / 2 - 2 * math.atan(t * ((1 - es) / (1 + es)) ** (E / 2))
            if abs(nxt - phi) < 1e-12:
                phi = nxt
                break
            phi = nxt
    return math.degrees(phi), lon


def world_px(zoom, tile=TILE):
    """Размер мира в пикселях на данном зуме."""
    return tile * (2 ** zoom)


def latlon_to_px(lat, lon, zoom, ellipsoidal, tile=TILE):
    """Глобальные пиксельные координаты (x вправо, y вниз)."""
    x, y = merc_forward(lat, lon, ellipsoidal)
    size = world_px(zoom, tile)
    return (x + HALF) / (2 * HALF) * size, (HALF - y) / (2 * HALF) * size


def px_to_latlon(px, py, zoom, ellipsoidal, tile=TILE):
    size = world_px(zoom, tile)
    x = px / size * 2 * HALF - HALF
    y = HALF - py / size * 2 * HALF
    return merc_inverse(x, y, ellipsoidal)


def meters_per_px(lat, zoom, ellipsoidal, tile=TILE):
    """Истинный размер пикселя на местности (м) на широте lat."""
    phi = math.radians(lat)
    k = math.cos(phi)
    if ellipsoidal:
        k /= math.sqrt(1 - E2 * math.sin(phi) ** 2)
    return 2 * HALF / world_px(zoom, tile) * k


# --- Локальная поперечная проекция Меркатора ---------------------------------
# Система координат сцены: TM на WGS84 с осевым меридианом в начале координат
# сцены, (0, 0) — точка привязки, единица — настоящий метр. В отличие от
# веб-Меркатора масштаб не искажён, поэтому размеры зданий в Blender честные.

def _meridian_arc(phi):
    e4, e6 = E2 * E2, E2 * E2 * E2
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
                - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
                - (35 * e6 / 3072) * math.sin(6 * phi))


class LocalTM:
    def __init__(self, lat0, lon0):
        self.lat0 = lat0
        self.lon0 = lon0
        self._m0 = _meridian_arc(math.radians(lat0))

    def forward(self, lat, lon):
        phi = math.radians(lat)
        lam = math.radians(lon - self.lon0)
        s, c = math.sin(phi), math.cos(phi)
        n = A / math.sqrt(1 - E2 * s * s)
        t = math.tan(phi) ** 2
        cc = EP2 * c * c
        a = lam * c
        x = n * (a + (1 - t + cc) * a ** 3 / 6
                 + (5 - 18 * t + t * t + 72 * cc - 58 * EP2) * a ** 5 / 120)
        y = (_meridian_arc(phi) - self._m0
             + n * math.tan(phi) * (a * a / 2 + (5 - t + 9 * cc + 4 * cc * cc) * a ** 4 / 24
                                    + (61 - 58 * t + t * t + 600 * cc - 330 * EP2) * a ** 6 / 720))
        return x, y

    def inverse(self, x, y):
        m = self._m0 + y
        mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256))
        sq = math.sqrt(1 - E2)
        e1 = (1 - sq) / (1 + sq)
        phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
                + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
                + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
                + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
        s, c = math.sin(phi1), math.cos(phi1)
        c1 = EP2 * c * c
        t1 = math.tan(phi1) ** 2
        n1 = A / math.sqrt(1 - E2 * s * s)
        r1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5
        d = x / n1
        phi = phi1 - (n1 * math.tan(phi1) / r1) * (
            d * d / 2
            - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4 / 24
            + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6 / 720)
        lam = (d - (1 + 2 * t1 + c1) * d ** 3 / 6
               + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5 / 120) / c
        return math.degrees(phi), self.lon0 + math.degrees(lam)


# --- Разбор ссылок ------------------------------------------------------------

def parse_map_link(text):
    """Достаёт (lat, lon, zoom|None) из ссылки Яндекс Карт или строки координат.

    Понимает:
      https://yandex.ru/maps/?ll=37.617635%2C55.755814&z=16
      https://yandex.ru/maps/-/...?...&pt=37.6,55.7   (метка)
      https://yandex.ru/maps/?whatshere[point]=37.6,55.7&whatshere[zoom]=17
      "55.755814, 37.617635"   (как копирует Яндекс: широта, долгота)
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("Пустая строка")

    if "://" not in text and "?" not in text:
        parts = [p for p in text.replace(";", ",").replace(" ", ",").split(",") if p]
        if len(parts) != 2:
            raise ValueError("Ожидались две координаты: «широта, долгота»")
        lat, lon = float(parts[0]), float(parts[1])
        _check(lat, lon)
        return lat, lon, None

    q = parse_qs(urlparse(text).query)

    def first(*keys):
        for k in keys:
            if k in q and q[k]:
                return unquote(q[k][0])
        return None

    zoom = first("z", "whatshere[zoom]")
    zoom = int(round(float(zoom))) if zoom else None

    # ll — центр экрана, pt/whatshere — метка; метку предпочитаем, она точнее
    for key in ("whatshere[point]", "pt", "ll"):
        val = first(key)
        if val:
            lon_s, lat_s = val.split("~")[0].split(",")[:2]
            lat, lon = float(lat_s), float(lon_s)
            _check(lat, lon)
            return lat, lon, zoom
    raise ValueError("В ссылке нет координат (ll=, pt= или whatshere[point]=)")


def _check(lat, lon):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Координаты вне диапазона: %s, %s" % (lat, lon))
