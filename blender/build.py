# Собирает устанавливаемый архив: python3 blender/build.py
# Результат — blender/dist/yandex_gis-<версия>.zip. Подходит и для
# Blender 4.2+ (Install from Disk), и для 3.6–4.1 (Preferences → Add-ons → Install).

import os
import re
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "yandex_gis")

version = re.search(r'^version = "([^"]+)"',
                    open(os.path.join(SRC, "blender_manifest.toml"), encoding="utf-8").read(),
                    re.M).group(1)
os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
out = os.path.join(HERE, "dist", "yandex_gis-%s.zip" % version)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith(".pyc"):
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.join("yandex_gis", os.path.relpath(full, SRC)))
print(out)
