import bpy


class YAGIS_PT_base(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "YandexGIS"


class YAGIS_PT_main(YAGIS_PT_base):
    bl_label = "Место"

    def draw(self, context):
        g = context.scene.yagis
        col = self.layout.column(align=True)

        row = col.row(align=True)
        row.prop(g, "search", text="", icon="VIEWZOOM")
        row.operator("yagis.search", text="", icon="FORWARD")

        row = col.row(align=True)
        row.prop(g, "link", text="", icon="URL")
        row.operator("yagis.from_link", text="", icon="PASTEDOWN")

        col.separator()
        col.prop(g, "lat")
        col.prop(g, "lon")
        row = col.row(align=True)
        row.operator("yagis.cursor_to_point", icon="CURSOR")
        row.operator("yagis.point_to_cursor", icon="PIVOT_CURSOR")
        col.operator("yagis.open_browser", icon="WORLD")

        box = self.layout.box()
        if g.origin_set:
            box.label(text="Привязка: %.6f, %.6f" % (g.origin_lat, g.origin_lon), icon="LOCKED")
            box.operator("yagis.reset_origin", icon="UNLOCKED")
        else:
            box.label(text="Сцена не привязана", icon="UNLOCKED")
            box.operator("yagis.set_origin", icon="LOCKED")


class YAGIS_PT_area(YAGIS_PT_base):
    bl_label = "Область"
    bl_parent_id = "YAGIS_PT_main"

    def draw(self, context):
        g = context.scene.yagis
        col = self.layout.column(align=True)
        col.prop(g, "area_mode", expand=True)
        if g.area_mode == "POINT":
            col.prop(g, "size_x")
            col.prop(g, "size_y")
        else:
            obj = context.active_object
            col.label(text=obj.name if obj else "Нет активного объекта",
                      icon="OBJECT_DATA" if obj else "ERROR")


class YAGIS_PT_basemap(YAGIS_PT_base):
    bl_label = "Подложка"

    def draw(self, context):
        g = context.scene.yagis
        col = self.layout.column()
        col.prop(g, "source")
        col.prop(g, "zoom")
        col.prop(g, "subdiv")
        row = col.row(align=True)
        row.prop(g, "with_terrain")
        sub = row.row()
        sub.active = g.with_terrain
        sub.prop(g, "terrain_zoom", text="Зум")
        col.operator("yagis.basemap", icon="IMAGE_DATA")


class YAGIS_PT_terrain(YAGIS_PT_base):
    bl_label = "Рельеф и здания"

    def draw(self, context):
        g = context.scene.yagis
        col = self.layout.column()
        col.prop(g, "terrain_zoom")
        col.operator("yagis.drape", icon="MOD_SHRINKWRAP")
        col.separator()
        col.prop(g, "bld_level_h")
        col.prop(g, "bld_default_levels")
        col.prop(g, "bld_on_terrain")
        col.operator("yagis.buildings", icon="HOME")


classes = (YAGIS_PT_main, YAGIS_PT_area, YAGIS_PT_basemap, YAGIS_PT_terrain)


def register():
    for c in classes:
        bpy.utils.register_class(c)


def unregister():
    for c in reversed(classes):
        bpy.utils.unregister_class(c)
