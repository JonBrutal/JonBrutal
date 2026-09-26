import os
import tempfile

import bpy
from bpy.props import (BoolProperty, EnumProperty, FloatProperty, IntProperty,
                       PointerProperty, StringProperty)

from .tiles import DEFAULT_UA

SOURCES = [
    ("YA_MAP", "Яндекс Схема", "Векторная схема Яндекс Карт (EPSG:3395)"),
    ("YA_SAT", "Яндекс Спутник", "Спутниковые снимки Яндекса (EPSG:3395)"),
    ("YA_HYBRID", "Яндекс Гибрид", "Спутник + подписи и дороги"),
    ("OSM", "OpenStreetMap", "Для сравнения (EPSG:3857)"),
    ("CUSTOM", "Свой источник", "Шаблон URL из настроек аддона"),
]


class YAGIS_Prefs(bpy.types.AddonPreferences):
    bl_idname = __package__

    cache_dir: StringProperty(name="Папка кэша", subtype="DIR_PATH",
                              description="Пусто — системная временная папка")
    lang: EnumProperty(name="Язык подписей", default="ru_RU", items=[
        ("ru_RU", "Русский", ""), ("en_US", "English", ""), ("uk_UA", "Українська", ""),
        ("tr_TR", "Türkçe", ""), ("kk_KZ", "Қазақша", "")])
    retina: BoolProperty(name="Схема в 2× разрешении", default=False,
                         description="Тайлы 512 px для слоя «Схема»: мельче шрифт, чётче линии")
    threads: IntProperty(name="Потоков загрузки", default=8, min=1, max=32)
    max_px: IntProperty(name="Макс. сторона текстуры", default=8192, min=1024, max=32768,
                        description="Если область не влезает — зум понижается автоматически")
    user_agent: StringProperty(name="User-Agent", default=DEFAULT_UA)
    ya_geocoder_key: StringProperty(name="Ключ Геокодера Яндекса", subtype="PASSWORD",
                                    description="Необязательно. Без ключа поиск идёт через Nominatim (OSM)")

    custom_url: StringProperty(name="Шаблон URL",
                               description="Например https://example.com/{z}/{x}/{y}.png. "
                                           "Доступно: {x} {y} {z} {scale} {lang} {s}")
    custom_ellipsoidal: BoolProperty(name="Эллипсоидальный Меркатор (EPSG:3395)", default=False,
                                     description="Включите для тайлов Яндекса; OSM/Google/Bing — выключено")
    custom_max_zoom: IntProperty(name="Макс. зум", default=19, min=0, max=23)
    custom_subdomains: StringProperty(name="Поддомены для {s}", default="")
    custom_referer: StringProperty(name="Referer", default="")

    def draw(self, context):
        col = self.layout.column()
        col.prop(self, "cache_dir")
        col.prop(self, "lang")
        col.prop(self, "retina")
        col.prop(self, "threads")
        col.prop(self, "max_px")
        col.prop(self, "user_agent")
        col.prop(self, "ya_geocoder_key")
        box = col.box()
        box.label(text="Свой источник тайлов")
        for name in ("custom_url", "custom_ellipsoidal", "custom_max_zoom",
                     "custom_subdomains", "custom_referer"):
            box.prop(self, name)

    def cache_path(self):
        return bpy.path.abspath(self.cache_dir) if self.cache_dir else \
            os.path.join(tempfile.gettempdir(), "yandexgis_cache")


def prefs(context=None):
    context = context or bpy.context
    addon = context.preferences.addons.get(__package__)
    return addon.preferences if addon else None


class YAGIS_Scene(bpy.types.PropertyGroup):
    # Привязка сцены: эта точка — (0, 0, 0) в Blender
    origin_set: BoolProperty(default=False)
    origin_lat: FloatProperty(name="Широта", precision=7)
    origin_lon: FloatProperty(name="Долгота", precision=7)

    # Точка интереса / центр области
    lat: FloatProperty(name="Широта", default=55.753960, min=-85, max=85, precision=7)
    lon: FloatProperty(name="Долгота", default=37.620393, min=-180, max=180, precision=7)
    link: StringProperty(name="Ссылка",
                         description="Ссылка на Яндекс Карты (с ll= или pt=) или «широта, долгота»")
    search: StringProperty(name="Поиск", description="Адрес или название места")

    area_mode: EnumProperty(name="Область", default="POINT", items=[
        ("POINT", "Вокруг точки", "Прямоугольник заданного размера с центром в точке"),
        ("OBJECT", "По объекту", "Габариты активного объекта в плане")])
    size_x: FloatProperty(name="Ширина", default=1000, min=10, max=100000, unit="LENGTH")
    size_y: FloatProperty(name="Высота", default=1000, min=10, max=100000, unit="LENGTH")

    source: EnumProperty(name="Слой", items=SOURCES, default="YA_SAT")
    zoom: IntProperty(name="Зум", default=17, min=1, max=21)
    subdiv: IntProperty(name="Разбиение", default=0, min=0, max=1024,
                        description="Сегментов по длинной стороне. 0 — автоматически")
    with_terrain: BoolProperty(name="С рельефом", default=False)
    terrain_zoom: IntProperty(name="Зум рельефа", default=13, min=5, max=15,
                              description="13 ≈ 12 м/пикс, 15 ≈ 3 м/пикс (данные SRTM ~30 м)")

    bld_level_h: FloatProperty(name="Высота этажа", default=3.0, min=1, max=10, unit="LENGTH")
    bld_default_levels: IntProperty(name="Этажей по умолчанию", default=3, min=1, max=50)
    bld_on_terrain: BoolProperty(name="Ставить на рельеф", default=False)


classes = (YAGIS_Prefs, YAGIS_Scene)


def register():
    for c in classes:
        bpy.utils.register_class(c)
    bpy.types.Scene.yagis = PointerProperty(type=YAGIS_Scene)


def unregister():
    del bpy.types.Scene.yagis
    for c in reversed(classes):
        bpy.utils.unregister_class(c)
