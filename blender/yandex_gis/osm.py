# Здания из OpenStreetMap через Overpass API. Без bpy.

import json
import re
import urllib.parse
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"


def query_buildings(s, w, n, e, user_agent, url=OVERPASS, timeout=120):
    bbox = "%.7f,%.7f,%.7f,%.7f" % (s, w, n, e)
    q = ('[out:json][timeout:%d];('
         'way["building"](%s);'
         'relation["building"]["type"="multipolygon"](%s);'
         ');out geom;' % (timeout, bbox, bbox))
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout + 30) as r:
        return json.loads(r.read().decode("utf-8"))


def _num(val):
    if not val:
        return None
    m = re.match(r"\s*(-?\d+(?:[.,]\d+)?)", str(val))
    return float(m.group(1).replace(",", ".")) if m else None


def building_height(tags, level_h, default_levels):
    """(низ, верх) в метрах по тегам OSM."""
    h = _num(tags.get("height")) or _num(tags.get("building:height"))
    levels = _num(tags.get("building:levels"))
    if h is None:
        h = (levels if levels is not None else default_levels) * level_h
        roof = _num(tags.get("roof:levels"))
        if roof:
            h += roof * level_h
    base = _num(tags.get("min_height"))
    if base is None:
        min_level = _num(tags.get("building:min_level"))
        base = min_level * level_h if min_level else 0.0
    return base, max(h, base + 0.5)


def _join_rings(segments):
    """Склеивает куски внешнего контура мультиполигона в замкнутые кольца."""
    rings, open_ = [], [list(s) for s in segments if len(s) > 1]
    while open_:
        ring = open_.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, seg in enumerate(open_):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = seg[:0:-1] + ring
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def footprints(osm_json):
    """[(tags, [(lat, lon), ...])] — внешние контуры без повтора первой точки.
    Внутренние дворы-колодцы мультиполигонов пока пропускаются."""
    out = []
    for el in osm_json.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "way" and "geometry" in el:
            pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                out.append((tags, pts[:-1]))
        elif el["type"] == "relation":
            segs = [[(p["lat"], p["lon"]) for p in m["geometry"]]
                    for m in el.get("members", [])
                    if m.get("role") == "outer" and m.get("geometry")]
            for ring in _join_rings(segs):
                out.append((tags, ring[:-1]))
    return out
