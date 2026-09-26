import json
import math
import os
import time
import urllib.parse
import urllib.request

import bpy
import numpy as np
from mathutils import Vector

from . import geo, mosaic, osm, tiles
from .props import prefs as get_prefs


# --- Общие помощники ------------------------------------------------------------

def online_ok(op):
    # Blender 4.2+: уважаем галочку «Allow Online Access»
    if getattr(bpy.app, "online_access", True):
        return True
    op.report({"ERROR"}, "Интернет запрещён: Preferences → System → Network → Allow Online Access")
    return False


def downloader(context):
    p = get_prefs(context)
    if p is None:
        return tiles.Downloader(os.path.join(bpy.app.tempdir or ".", "yandexgis_cache"))
    return tiles.Downloader(p.cache_path(), p.user_agent, p.threads, p.lang)


def user_agent(context):
    p = get_prefs(context)
    return p.user_agent if p else tiles.DEFAULT_UA


def local_tm(scene):
    g = scene.yagis
    return geo.LocalTM(g.origin_lat, g.origin_lon)


def set_origin(scene, lat, lon):
    g = scene.yagis
    g.origin_lat, g.origin_lon, g.origin_set = lat, lon, True


class Progress:
    def __init__(self, context):
        self.wm = context.window_manager
        self.wm.progress_begin(0, 1000)
        self.base, self.span = 0.0, 1.0

    def stage(self, base, span):
        self.base, self.span = base, span

    def __call__(self, done, total):
        self.wm.progress_update(int(1000 * (self.base + self.span * done / max(total, 1))))

    def end(self):
        self.wm.progress_end()


def area_rect(context):
    """Прямоугольник области в координатах сцены (x0, y0, x1, y1).
    Если привязки нет, её задаёт точка из панели."""
    scene = context.scene
    g = scene.yagis
    if g.area_mode == "OBJECT":
        obj = context.active_object
        if obj is None:
            raise ValueError("Нет активного объекта")
        if not g.origin_set:
            raise ValueError("Сцена не привязана к координатам — сначала загрузите подложку вокруг точки")
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        xs, ys = [c.x for c in corners], [c.y for c in corners]
        return min(xs), min(ys), max(xs), max(ys)
    if not g.origin_set:
        set_origin(scene, g.lat, g.lon)
    cx, cy = local_tm(scene).forward(g.lat, g.lon)
    return cx - g.size_x / 2, cy - g.size_y / 2, cx + g.size_x / 2, cy + g.size_y / 2


def rect_latlon_bounds(tm, rect, steps=8):
    """Охват прямоугольника сцены в градусах (граница TM в Меркаторе чуть изогнута)."""
    x0, y0, x1, y1 = rect
    pts = []
    for i in range(steps + 1):
        t = i / steps
        for x, y in ((x0 + (x1 - x0) * t, y0), (x0 + (x1 - x0) * t, y1),
                     (x0, y0 + (y1 - y0) * t), (x1, y0 + (y1 - y0) * t)):
            pts.append(tm.inverse(x, y))
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)


def image_dir():
    if bpy.data.filepath:
        return os.path.join(os.path.dirname(bpy.data.filepath), "yandexgis"), True
    return os.path.join(bpy.app.tempdir or ".", "yandexgis"), False


def make_material(name, image):
    mat = bpy.data.materials.new(name)
    if not getattr(mat, "use_nodes", True):
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) \
            or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    for key, val in (("Roughness", 1.0), ("Specular IOR Level", 0.0), ("Specular", 0.0)):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = val
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.extension = "EXTEND"
    tex.location = (bsdf.location.x - 350, bsdf.location.y)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def grid_mesh(name, rect, nx, ny, z_func=None):
    """Регулярная сетка в плоскости сцены. Возвращает (mesh, координаты вершин Nx2)."""
    x0, y0, x1, y1 = rect
    xs = np.linspace(x0, x1, nx + 1)
    ys = np.linspace(y0, y1, ny + 1)
    gx, gy = np.meshgrid(xs, ys)
    xy = np.stack([gx.ravel(), gy.ravel()], axis=1)
    z = z_func(xy) if z_func else np.zeros(len(xy))
    verts = np.column_stack([xy, z]).astype(np.float32)

    faces = []
    w = nx + 1
    for j in range(ny):
        for i in range(nx):
            a = j * w + i
            faces.append((a, a + 1, a + 1 + w, a + w))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], faces)
    me.update()
    return me, xy


def set_uv(me, uv_per_vertex):
    layer = me.uv_layers.new(name="YandexGIS")
    vidx = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", vidx)
    layer.data.foreach_set("uv", uv_per_vertex[vidx].astype(np.float32).ravel())


def load_terrain(context, lat_min, lon_min, lat_max, lon_max, prog=None):
    g = context.scene.yagis
    terr, missing, errors = mosaic.Terrain.load(
        downloader(context), tiles.TERRARIUM, g.terrain_zoom,
        lat_min, lon_min, lat_max, lon_max, prog)
    return terr, missing + len(errors)


def terrain_z(terrain, tm, xy):
    ll = [tm.inverse(x, y) for x, y in xy]
    return terrain.sample([p[0] for p in ll], [p[1] for p in ll])


# --- Операторы: привязка и поиск ----------------------------------------------------

class YAGIS_OT_from_link(bpy.types.Operator):
    """Взять точку и зум из ссылки Яндекс Карт (поле или буфер обмена)"""
    bl_idname = "yagis.from_link"
    bl_label = "Из ссылки"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        g = context.scene.yagis
        text = g.link.strip() or context.window_manager.clipboard.strip()
        try:
            lat, lon, zoom = geo.parse_map_link(text)
        except (ValueError, IndexError) as e:
            self.report({"ERROR"}, "Не разобрать ссылку: %s" % e)
            return {"CANCELLED"}
        g.lat, g.lon = lat, lon
        if zoom:
            g.zoom = max(1, min(21, zoom))
        self.report({"INFO"}, "Точка: %.6f, %.6f%s" % (lat, lon, ", зум %d" % zoom if zoom else ""))
        return {"FINISHED"}


class YAGIS_OT_search(bpy.types.Operator):
    """Найти место по адресу: Геокодер Яндекса (если задан ключ) или Nominatim"""
    bl_idname = "yagis.search"
    bl_label = "Найти"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        g = context.scene.yagis
        if not g.search.strip():
            self.report({"ERROR"}, "Введите адрес")
            return {"CANCELLED"}
        if not online_ok(self):
            return {"CANCELLED"}
        p = get_prefs(context)
        try:
            if p and p.ya_geocoder_key:
                url = "https://geocode-maps.yandex.ru/1.x/?" + urllib.parse.urlencode({
                    "apikey": p.ya_geocoder_key, "geocode": g.search, "format": "json",
                    "results": 1, "lang": p.lang})
                data = self._get(url, context)
                members = data["response"]["GeoObjectCollection"]["featureMember"]
                if not members:
                    raise LookupError
                obj = members[0]["GeoObject"]
                lon, lat = map(float, obj["Point"]["pos"].split())
                label = obj.get("metaDataProperty", {}).get("GeocoderMetaData", {}).get("text", "")
            else:
                url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
                    "q": g.search, "format": "json", "limit": 1, "accept-language": "ru"})
                data = self._get(url, context, ua="YandexGIS-Blender/0.1")
                if not data:
                    raise LookupError
                lat, lon, label = float(data[0]["lat"]), float(data[0]["lon"]), data[0]["display_name"]
        except LookupError:
            self.report({"WARNING"}, "Ничего не найдено")
            return {"CANCELLED"}
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, "Ошибка поиска: %s" % e)
            return {"CANCELLED"}
        g.lat, g.lon = lat, lon
        self.report({"INFO"}, label[:200])
        return {"FINISHED"}

    @staticmethod
    def _get(url, context, ua=None):
        req = urllib.request.Request(url, headers={"User-Agent": ua or user_agent(context)})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))


class YAGIS_OT_open_browser(bpy.types.Operator):
    """Открыть точку в Яндекс Картах. Найдите нужное место, скопируйте ссылку и нажмите «Из ссылки»"""
    bl_idname = "yagis.open_browser"
    bl_label = "Открыть в Яндекс Картах"

    def execute(self, context):
        g = context.scene.yagis
        l = "sat" if g.source in {"YA_SAT"} else "sat,skl" if g.source == "YA_HYBRID" else "map"
        url = "https://yandex.ru/maps/?ll=%.6f%%2C%.6f&z=%d&l=%s" % (g.lon, g.lat, g.zoom, l)
        bpy.ops.wm.url_open(url=url)
        return {"FINISHED"}


class YAGIS_OT_cursor_to_point(bpy.types.Operator):
    """Точка = положение 3D-курсора"""
    bl_idname = "yagis.cursor_to_point"
    bl_label = "Из 3D-курсора"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return context.scene.yagis.origin_set

    def execute(self, context):
        c = context.scene.cursor.location
        g = context.scene.yagis
        g.lat, g.lon = local_tm(context.scene).inverse(c.x, c.y)
        return {"FINISHED"}


class YAGIS_OT_point_to_cursor(bpy.types.Operator):
    """Поставить 3D-курсор в точку"""
    bl_idname = "yagis.point_to_cursor"
    bl_label = "В 3D-курсор"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return context.scene.yagis.origin_set

    def execute(self, context):
        g = context.scene.yagis
        x, y = local_tm(context.scene).forward(g.lat, g.lon)
        context.scene.cursor.location = (x, y, context.scene.cursor.location.z)
        return {"FINISHED"}


class YAGIS_OT_set_origin(bpy.types.Operator):
    """Сделать точку началом координат сцены"""
    bl_idname = "yagis.set_origin"
    bl_label = "Привязать сцену к точке"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        g = context.scene.yagis
        set_origin(context.scene, g.lat, g.lon)
        return {"FINISHED"}


class YAGIS_OT_reset_origin(bpy.types.Operator):
    """Сбросить привязку сцены (уже загруженные объекты останутся на месте)"""
    bl_idname = "yagis.reset_origin"
    bl_label = "Сбросить привязку"
    bl_options = {"REGISTER", "UNDO"}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        context.scene.yagis.origin_set = False
        return {"FINISHED"}


# --- Подложка ---------------------------------------------------------------------

class YAGIS_OT_basemap(bpy.types.Operator):
    """Скачать тайлы, склеить в текстуру и создать плоскость с правильной привязкой"""
    bl_idname = "yagis.basemap"
    bl_label = "Загрузить подложку"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        if not online_ok(self):
            return {"CANCELLED"}
        prog = Progress(context)
        try:
            return self._run(context, prog)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        finally:
            prog.end()

    def _run(self, context, prog):
        scene, g, p = context.scene, context.scene.yagis, get_prefs(context)
        src = tiles.basemap_source(g.source, p)
        rect = area_rect(context)
        tm = local_tm(scene)
        width, height = rect[2] - rect[0], rect[3] - rect[1]
        lat_min, lon_min, lat_max, lon_max = rect_latlon_bounds(tm, rect)
        lat_c = (lat_min + lat_max) / 2

        # Разбиение сетки: под рельеф — по разрешению рельефа, иначе редкая сетка,
        # которой хватает, чтобы скомпенсировать разницу Меркатора и TM.
        longest = max(width, height)
        if g.subdiv:
            seg = g.subdiv
        elif g.with_terrain:
            seg = int(math.ceil(longest / geo.meters_per_px(lat_c, g.terrain_zoom, False)))
            seg = max(8, min(512, seg))
        else:
            seg = max(8, min(128, int(math.ceil(longest / 250))))
        nx = max(1, int(round(seg * width / longest)))
        ny = max(1, int(round(seg * height / longest)))

        me, xy = grid_mesh("YaMap", rect, nx, ny)
        ll = [tm.inverse(x, y) for x, y in xy]

        # Подбираем зум так, чтобы текстура уложилась в лимит
        max_px = p.max_px if p else 8192
        zoom = min(g.zoom, src.max_zoom)
        while True:
            pxy = np.array([geo.latlon_to_px(la, lo, zoom, src.ellipsoidal, src.tile_px)
                            for la, lo in ll])
            px0, py0 = np.floor(pxy.min(axis=0)).astype(int)
            px1, py1 = np.ceil(pxy.max(axis=0)).astype(int)
            if max(px1 - px0, py1 - py0) <= max_px or zoom <= 1:
                break
            zoom -= 1
        if zoom < g.zoom:
            self.report({"WARNING"}, "Зум понижен до %d (лимит текстуры или слоя)" % zoom)

        # Текстура
        stages = 3 if src.overlay else 2
        prog.stage(0, 1 / stages)
        dl = downloader(context)
        img, missing, errors = mosaic.build(dl, src, zoom, px0, py0, px1, py1, prog)
        if src.overlay:
            prog.stage(1 / stages, 1 / stages)
            over, m2, e2 = mosaic.build(dl, src.overlay, zoom, px0, py0, px1, py1, prog)
            img = mosaic.alpha_over(img, over)
            errors += e2
        mosaic.fill_missing(img)

        folder, beside_blend = image_dir()
        os.makedirs(folder, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        fname = "%s_z%d_%s.png" % (src.key, zoom, stamp)
        path = os.path.join(folder, fname)
        mosaic.write_png(path, img[..., :3])
        image = bpy.data.images.load(path)
        if beside_blend:
            image.filepath = bpy.path.relpath(path)
        else:
            image.pack()

        # UV: вершина → пиксель мозаики
        W, H = px1 - px0, py1 - py0
        uv = np.column_stack([(pxy[:, 0] - px0) / W, 1 - (pxy[:, 1] - py0) / H])
        set_uv(me, uv)

        # Рельеф
        if g.with_terrain:
            prog.stage((stages - 1) / stages, 1 / stages)
            terr, bad = load_terrain(context, lat_min, lon_min, lat_max, lon_max, prog)
            z = terr.sample([a for a, _ in ll], [b for _, b in ll])
            co = np.empty(len(me.vertices) * 3, np.float32)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            co[:, 2] = z
            me.vertices.foreach_set("co", co.ravel())
            me.update()
            if bad:
                self.report({"WARNING"}, "Рельеф: нет %d тайлов, там высота 0" % bad)

        name = "%s z%d" % (src.name, zoom)
        me.name = name
        me.materials.append(make_material(name, image))
        obj = bpy.data.objects.new(name, me)
        obj["yagis_source"] = src.key
        obj["yagis_zoom"] = zoom
        obj["yagis_bbox"] = [lat_min, lon_min, lat_max, lon_max]
        context.collection.objects.link(obj)
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        mpp = geo.meters_per_px(lat_c, zoom, src.ellipsoidal, src.tile_px)
        msg = "%s: %d×%d px, %.2f м/пикс" % (name, W, H, mpp)
        if missing or errors:
            msg += "; пропущено тайлов: %d" % (missing + len(errors))
            if errors:
                msg += " (%s)" % errors[0][:120]
        self.report({"WARNING"} if missing or errors else {"INFO"}, msg)
        return {"FINISHED"}


# --- Рельеф для произвольных мешей -------------------------------------------------

class YAGIS_OT_drape(bpy.types.Operator):
    """Опустить вершины выбранных мешей на рельеф (высота над уровнем моря, м)"""
    bl_idname = "yagis.drape"
    bl_label = "Положить на рельеф"
    bl_options = {"REGISTER", "UNDO"}

    offset: bpy.props.FloatProperty(name="Смещение", default=0.0, unit="LENGTH")

    @classmethod
    def poll(cls, context):
        return context.scene.yagis.origin_set and any(
            o.type == "MESH" for o in context.selected_objects)

    def execute(self, context):
        if not online_ok(self):
            return {"CANCELLED"}
        if context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        tm = local_tm(context.scene)
        objs = [o for o in context.selected_objects if o.type == "MESH"]
        world = {}
        for o in objs:
            co = np.empty(len(o.data.vertices) * 3, np.float32)
            o.data.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            m = np.array(o.matrix_world)
            world[o] = co @ m[:3, :3].T + m[:3, 3]
        allxy = np.concatenate([w[:, :2] for w in world.values()])
        rect = (*allxy.min(axis=0), *allxy.max(axis=0))
        lat_min, lon_min, lat_max, lon_max = rect_latlon_bounds(tm, rect, steps=2)
        prog = Progress(context)
        try:
            terr, bad = load_terrain(context, lat_min, lon_min, lat_max, lon_max, prog)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        finally:
            prog.end()
        for o, w in world.items():
            w[:, 2] = terrain_z(terr, tm, w[:, :2]) + self.offset
            inv = np.array(o.matrix_world.inverted())
            local = w @ inv[:3, :3].T + inv[:3, 3]
            o.data.vertices.foreach_set("co", local.astype(np.float32).ravel())
            o.data.update()
        if bad:
            self.report({"WARNING"}, "Нет %d тайлов рельефа" % bad)
        return {"FINISHED"}


# --- Здания OSM ------------------------------------------------------------------

class YAGIS_OT_buildings(bpy.types.Operator):
    """Скачать контуры зданий из OpenStreetMap и выдавить по высоте/этажности"""
    bl_idname = "yagis.buildings"
    bl_label = "Здания OSM"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        if not online_ok(self):
            return {"CANCELLED"}
        g = context.scene.yagis
        try:
            rect = area_rect(context)
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        tm = local_tm(context.scene)
        s, w, n, e = rect_latlon_bounds(tm, rect)
        prog = Progress(context)
        try:
            data = osm.query_buildings(s, w, n, e, user_agent(context))
            prog(1, 3)
            items = osm.footprints(data)
            terr = None
            if g.bld_on_terrain:
                prog.stage(1 / 3, 2 / 3)
                terr, _ = load_terrain(context, s, w, n, e, prog)
        except Exception as ex:  # noqa: BLE001
            self.report({"ERROR"}, "Overpass/рельеф: %s" % ex)
            return {"CANCELLED"}
        finally:
            prog.end()
        if not items:
            self.report({"WARNING"}, "В области нет зданий")
            return {"CANCELLED"}

        verts, faces, heights = [], [], []
        for tags, ring in items:
            xy = np.array([tm.forward(la, lo) for la, lo in ring])
            # CCW, чтобы нормали смотрели наружу
            area = 0.5 * np.sum(xy[:, 0] * np.roll(xy[:, 1], -1) - np.roll(xy[:, 0], -1) * xy[:, 1])
            if abs(area) < 1.0:
                continue
            if area < 0:
                xy = xy[::-1]
            base, top = osm.building_height(tags, g.bld_level_h, g.bld_default_levels)
            ground = 0.0
            if terr is not None:
                ground = float(np.min(terr.sample([la for la, _ in ring], [lo for _, lo in ring])))
            k, i0 = len(xy), len(verts)
            verts += [(x, y, ground + base) for x, y in xy]
            verts += [(x, y, ground + top) for x, y in xy]
            faces.append(tuple(range(i0 + k - 1, i0 - 1, -1)))        # низ
            faces.append(tuple(range(i0 + k, i0 + 2 * k)))             # крыша
            for i in range(k):
                j = (i + 1) % k
                faces.append((i0 + i, i0 + j, i0 + k + j, i0 + k + i))
            heights.append(top - base)

        if not heights:
            self.report({"WARNING"}, "В области нет зданий")
            return {"CANCELLED"}
        me = bpy.data.meshes.new("OSM здания")
        me.from_pydata(verts, [], faces)
        me.validate()
        me.update()
        obj = bpy.data.objects.new("OSM здания", me)
        context.collection.objects.link(obj)
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        self.report({"INFO"}, "Зданий: %d, средняя высота %.1f м" % (len(heights), np.mean(heights)))
        return {"FINISHED"}


classes = (
    YAGIS_OT_from_link, YAGIS_OT_search, YAGIS_OT_open_browser,
    YAGIS_OT_cursor_to_point, YAGIS_OT_point_to_cursor,
    YAGIS_OT_set_origin, YAGIS_OT_reset_origin,
    YAGIS_OT_basemap, YAGIS_OT_drape, YAGIS_OT_buildings,
)


def register():
    for c in classes:
        bpy.utils.register_class(c)


def unregister():
    for c in reversed(classes):
        bpy.utils.unregister_class(c)
