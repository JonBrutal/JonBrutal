# Запуск: python3 -m unittest discover blender/tests
# Эталоны посчитаны pyproj (PROJ) для EPSG:3395, EPSG:3857 и tmerc/WGS84.

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "yandex_gis"))
import geo  # noqa: E402  (без bpy — импортируем модуль напрямую)
import osm  # noqa: E402

PTS = [(55.753960, 37.620393), (59.939095, 30.315868), (-33.8688, 151.2093), (0, 0)]
REF_3395 = [(4187882.9922, 7474242.0705), (3374746.9887, 8349174.0155),
            (16832542.2792, -3987387.0196), (0.0, 0.0)]
REF_3857 = [(4187882.9922, 7509591.1557), (3374746.9887, 8386190.5277),
            (16832542.2792, -4011198.6473), (0.0, 0.0)]


class TestMercator(unittest.TestCase):
    def test_forward_matches_proj(self):
        for (lat, lon), r5, r7 in zip(PTS, REF_3395, REF_3857):
            for ell, ref in ((True, r5), (False, r7)):
                x, y = geo.merc_forward(lat, lon, ell)
                self.assertAlmostEqual(x, ref[0], places=3)
                self.assertAlmostEqual(y, ref[1], places=3)

    def test_inverse_roundtrip(self):
        for lat, lon in PTS:
            for ell in (True, False):
                la, lo = geo.merc_inverse(*geo.merc_forward(lat, lon, ell), ell)
                self.assertAlmostEqual(la, lat, places=9)
                self.assertAlmostEqual(lo, lon, places=9)

    def test_pixels_roundtrip(self):
        px, py = geo.latlon_to_px(55.75396, 37.620393, 17, True)
        self.assertEqual((int(px // 256), int(py // 256)), (79233, 41090))
        la, lo = geo.px_to_latlon(px, py, 17, True)
        self.assertAlmostEqual(la, 55.75396, places=9)
        self.assertAlmostEqual(lo, 37.620393, places=9)


class TestLocalTM(unittest.TestCase):
    def test_matches_proj(self):
        tm = geo.LocalTM(55.75, 37.62)
        for (lat, lon), (rx, ry) in zip(
                [(55.80, 37.70), (55.60, 37.30), (56.2, 38.3)],
                [(5017.1672, 5569.7836), (-20171.3699, -16653.9081), (42207.3433, 50311.7525)]):
            x, y = tm.forward(lat, lon)
            self.assertAlmostEqual(x, rx, delta=0.002)
            self.assertAlmostEqual(y, ry, delta=0.002)
            la, lo = tm.inverse(x, y)
            self.assertAlmostEqual(la, lat, places=8)
            self.assertAlmostEqual(lo, lon, places=8)


class TestLinks(unittest.TestCase):
    def test_parse(self):
        cases = {
            "https://yandex.ru/maps/213/moscow/?ll=37.620393%2C55.753960&z=17": (55.75396, 37.620393, 17),
            "https://yandex.ru/maps/?pt=30.3,59.9&z=12&l=map": (59.9, 30.3, 12),
            "https://yandex.ru/maps/?whatshere%5Bpoint%5D=37.1%2C55.2&whatshere%5Bzoom%5D=16.4": (55.2, 37.1, 16),
            "55.753960, 37.620393": (55.75396, 37.620393, None),
        }
        for text, ref in cases.items():
            self.assertEqual(geo.parse_map_link(text), ref)

    def test_bad(self):
        for text in ("", "https://yandex.ru/maps/", "1, 2, 3", "95, 10"):
            with self.assertRaises(ValueError):
                geo.parse_map_link(text)


class TestOsm(unittest.TestCase):
    def test_height(self):
        self.assertEqual(osm.building_height({"height": "25 m"}, 3, 3), (0.0, 25.0))
        self.assertEqual(osm.building_height({"building:levels": "5"}, 3, 3), (0.0, 15.0))
        self.assertEqual(osm.building_height({}, 3, 2), (0.0, 6.0))
        self.assertEqual(osm.building_height({"height": "12,5", "min_height": "4"}, 3, 3), (4.0, 12.5))

    def test_join_rings(self):
        a, b, c, d = (0, 0), (0, 1), (1, 1), (1, 0)
        rings = osm._join_rings([[a, b, c], [a, d, c]])
        self.assertEqual(len(rings), 1)
        self.assertEqual(len(rings[0]), 5)
        self.assertEqual(rings[0][0], rings[0][-1])


if __name__ == "__main__":
    unittest.main()
