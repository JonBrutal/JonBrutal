# YandexGIS — аналог BlenderGIS с подложками Яндекс Карт.
# Для Blender 4.2+ метаданные берутся из blender_manifest.toml,
# bl_info нужен для установки как обычного аддона в 3.6–4.1.

bl_info = {
    "name": "YandexGIS",
    "author": "JonBrutal",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "3D Viewport → Sidebar (N) → YandexGIS",
    "description": "Подложки Яндекс Карт с привязкой, рельеф и здания OSM",
    "category": "3D View",
}

from . import ops, props, ui  # noqa: E402

modules = (props, ops, ui)


def register():
    for m in modules:
        m.register()


def unregister():
    for m in reversed(modules):
        m.unregister()
