# -*- coding: utf-8 -*-
"""생활권 필터의 거리·근거·캐시·fail-closed 회귀 테스트."""

import json
import math
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from nearby import (  # noqa: E402
    NEARBY_RADIUS_M,
    _split_bbox,
    filter_by_nearby_facilities,
    prefetch_nearby_facilities,
)


NOW = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)


def listing(**overrides):
    item = {"id": "naver:1", "lat": "35.1800000", "lon": "126.8200000"}
    item.update(overrides)
    return item


def node(osm_id, lat, lon, **tags):
    return {"type": "node", "id": osm_id, "lat": lat, "lon": lon, "tags": tags}


class NearbyFacilityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_path = str(Path(self.temp_dir.name) / "nearby.json")
        self.settings = {
            "enabled": True,
            "nearbyRadiusM": NEARBY_RADIUS_M,
            "cachePath": self.cache_path,
            "cacheTtlHours": 24,
            "overpassEndpoints": ["https://example.test/overpass"],
            "requestsPerEndpoint": 1,
            "overpassTileDelaySeconds": 0,
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_keeps_listing_and_preserves_nearest_evidence(self):
        payload = {
            "elements": [
                node(11, 35.1810, 126.8200, amenity="school", name="빛고을초등학교"),
                node(
                    12,
                    35.1820,
                    126.8200,
                    landuse="residential",
                    residential="apartments",
                    name="햇살아파트",
                ),
            ]
        }
        calls = []

        def fetcher(endpoint, query, timeout):
            calls.append((endpoint, query, timeout))
            return payload

        kept, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=fetcher, now=NOW
        )

        self.assertEqual(stats["kept"], 1)
        self.assertEqual(stats["dataStatus"], "network")
        self.assertEqual(len(calls), 1)
        self.assertIn('amenity"~"^(school|college|university)$', calls[0][1])
        self.assertIn('residential"="apartments', calls[0][1])
        self.assertNotIn('building"="apartments', calls[0][1])
        self.assertIn(".boundary_features out body geom", calls[0][1])
        self.assertEqual(kept[0]["nearbyFacilities"][0]["kind"], "elementary_school")
        self.assertLessEqual(
            kept[0]["nearbyFacilities"][0]["distanceM"], NEARBY_RADIUS_M
        )
        self.assertEqual(kept[0]["nearbyFacilities"][0]["source"], "openstreetmap")
        self.assertEqual(kept[0]["nearbyFacilities"][0]["tags"], {"amenity": "school"})
        self.assertEqual(
            kept[0]["nearbyFacilities"][0]["bbox"],
            [35.181, 126.82, 35.181, 126.82],
        )
        self.assertEqual(kept[0]["nearbyFacilities"][0]["geometry"], [])
        self.assertTrue(kept[0]["nearbyFacilityCheck"]["withinRadius"])

    def test_prefetch_populates_cache_before_listing_filter(self):
        school = node(13, 35.1810, 126.8200, amenity="school", name="사전조회초등학교")
        settings = {
            **self.settings,
            "prefetchBbox": [35.17, 126.81, 35.19, 126.83],
        }
        calls = []

        def fetcher(*_args):
            calls.append(True)
            return {"elements": [school]}

        stats = prefetch_nearby_facilities(settings, fetcher=fetcher, now=NOW)
        self.assertEqual(stats["dataStatus"], "network")
        self.assertEqual(stats["facilityCount"], 1)
        self.assertEqual(len(calls), 1)
        self.assertLess(stats["coverageBbox"][0], settings["prefetchBbox"][0])
        self.assertLess(stats["coverageBbox"][1], settings["prefetchBbox"][1])
        self.assertGreater(stats["coverageBbox"][2], settings["prefetchBbox"][2])
        self.assertGreater(stats["coverageBbox"][3], settings["prefetchBbox"][3])

        kept, filter_stats = filter_by_nearby_facilities(
            [listing()],
            settings,
            fetcher=lambda *_: self.fail("사전 조회 캐시를 사용해야 합니다"),
            now=NOW,
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(filter_stats["dataStatus"], "cache")

    def test_excludes_listing_without_facility_in_radius(self):
        far_school = node(20, 35.1900, 126.8200, amenity="school", name="먼중학교")
        kept, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [far_school]}, now=NOW
        )

        self.assertEqual(kept, [])
        self.assertEqual(stats["excludedNoFacility"], 1)

    def test_boundary_is_inclusive(self):
        # 같은 경도에서 haversine 기준 정확히 500m와 500m 초과 지점을 함께 검증한다.
        boundary_lat = 35.1800 + math.degrees(NEARBY_RADIUS_M / 6_371_000.0)
        outside_lat = 35.1800 + math.degrees((NEARBY_RADIUS_M + 0.01) / 6_371_000.0)
        payload = {"elements": [
            node(30, boundary_lat, 126.8200, amenity="school", name="경계고등학교"),
            node(31, outside_lat, 126.8200, amenity="university", name="경계밖대학교"),
        ]}
        kept, _ = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: payload, now=NOW
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(kept[0]["nearbyFacilities"]), 1)
        self.assertEqual(kept[0]["nearbyFacilities"][0]["osmId"], 30)
        self.assertEqual(kept[0]["nearbyFacilities"][0]["distanceM"], 500)

    def test_apartment_polygon_uses_boundary_distance(self):
        apartment = {
            "type": "way",
            "id": 40,
            "tags": {
                "landuse": "residential",
                "residential": "apartments",
                "name": "가까운아파트",
            },
            "geometry": [
                {"lat": 35.1802, "lon": 126.8198},
                {"lat": 35.1802, "lon": 126.8202},
                {"lat": 35.1798, "lon": 126.8202},
                {"lat": 35.1798, "lon": 126.8198},
                {"lat": 35.1802, "lon": 126.8198},
            ],
        }
        kept, _ = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [apartment]}, now=NOW
        )
        evidence = kept[0]["nearbyFacilities"][0]
        self.assertEqual(evidence["distanceM"], 0)
        self.assertEqual(evidence["kind"], "apartment_complex")
        self.assertEqual(evidence["bbox"], [35.1798, 126.8198, 35.1802, 126.8202])
        self.assertEqual(
            evidence["geometry"],
            [[
                [35.1802, 126.8198],
                [35.1802, 126.8202],
                [35.1798, 126.8202],
                [35.1798, 126.8198],
                [35.1802, 126.8198],
            ]],
        )

    def test_school_relation_preserves_every_geometry_ring_and_bbox(self):
        school = {
            "type": "relation",
            "id": 41,
            "tags": {"amenity": "school", "name": "관계형초등학교"},
            "members": [
                {
                    "type": "way",
                    "ref": 4101,
                    "role": "outer",
                    "geometry": [
                        {"lat": 35.1803, "lon": 126.8197},
                        {"lat": 35.1803, "lon": 126.8203},
                        {"lat": 35.1797, "lon": 126.8203},
                        {"lat": 35.1797, "lon": 126.8197},
                        {"lat": 35.1803, "lon": 126.8197},
                    ],
                },
                {
                    "type": "way",
                    "ref": 4102,
                    "role": "inner",
                    "geometry": [
                        {"lat": 35.1801, "lon": 126.8199},
                        {"lat": 35.1801, "lon": 126.8201},
                        {"lat": 35.1799, "lon": 126.8201},
                        {"lat": 35.1799, "lon": 126.8199},
                        {"lat": 35.1801, "lon": 126.8199},
                    ],
                },
            ],
        }

        kept, _ = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [school]}, now=NOW
        )

        evidence = kept[0]["nearbyFacilities"][0]
        self.assertEqual(evidence["osmType"], "relation")
        self.assertEqual(evidence["bbox"], [35.1797, 126.8197, 35.1803, 126.8203])
        self.assertEqual(len(evidence["geometry"]), 2)
        self.assertEqual(
            evidence["geometry"][1],
            [
                [35.1801, 126.8199],
                [35.1801, 126.8201],
                [35.1799, 126.8201],
                [35.1799, 126.8199],
                [35.1801, 126.8199],
            ],
        )

    def test_relation_member_segments_are_stitched_into_closed_polygon(self):
        apartment = {
            "type": "relation",
            "id": 42,
            "tags": {
                "landuse": "residential",
                "residential": "apartments",
                "name": "분할경계아파트",
            },
            "members": [
                {"role": "outer", "geometry": [
                    {"lat": 35.1798, "lon": 126.8198},
                    {"lat": 35.1802, "lon": 126.8198},
                ]},
                {"role": "outer", "geometry": [
                    {"lat": 35.1802, "lon": 126.8202},
                    {"lat": 35.1798, "lon": 126.8202},
                ]},
                {"role": "outer", "geometry": [
                    {"lat": 35.1802, "lon": 126.8198},
                    {"lat": 35.1802, "lon": 126.8202},
                ]},
                {"role": "outer", "geometry": [
                    {"lat": 35.1798, "lon": 126.8202},
                    {"lat": 35.1798, "lon": 126.8198},
                ]},
            ],
        }

        kept, _ = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [apartment]}, now=NOW
        )

        ring = kept[0]["nearbyFacilities"][0]["geometry"][0]
        self.assertEqual(len(ring), 5)
        self.assertEqual(ring[0], ring[-1])

    def test_missing_and_approximate_coordinates_fail_closed_without_network(self):
        calls = []
        items = [
            listing(id="missing", lat=None),
            listing(id="approx", locationPrecision="approximate", locationConfidence="low"),
        ]
        kept, stats = filter_by_nearby_facilities(
            items, self.settings, fetcher=lambda *_: calls.append(True), now=NOW
        )

        self.assertEqual(kept, [])
        self.assertEqual(calls, [])
        self.assertEqual(stats["excludedMissingCoordinate"], 1)
        self.assertEqual(stats["excludedUnreliableCoordinate"], 1)

    def test_api_failure_without_cache_excludes_everything(self):
        def fail(*_args):
            raise OSError("offline")

        kept, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=fail, now=NOW
        )
        self.assertEqual(kept, [])
        self.assertEqual(stats["dataStatus"], "unavailable")
        self.assertEqual(stats["excludedUnavailable"], 1)

    def test_empty_catalog_is_treated_as_unavailable(self):
        kept, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": []}, now=NOW
        )

        self.assertEqual(kept, [])
        self.assertEqual(stats["dataStatus"], "unavailable")
        self.assertEqual(stats["excludedUnavailable"], 1)

    def test_large_bbox_is_split_and_duplicate_pois_are_merged(self):
        school = node(21, 35.1010, 126.8200, amenity="school", name="분할초등학교")
        calls = []

        def fetcher(_endpoint, query, _timeout):
            calls.append(query)
            return {"elements": [school]}

        kept, stats = filter_by_nearby_facilities(
            [
                listing(id="naver:1", lat="35.1000"),
                listing(id="naver:2", lat="35.2300"),
            ],
            self.settings,
            fetcher=fetcher,
            now=NOW,
        )

        self.assertGreater(len(calls), 1)
        self.assertEqual(stats["dataStatus"], "network")
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(kept[0]["nearbyFacilities"]), 1)

    def test_bbox_split_tiles_cover_original_bounds(self):
        bbox = (35.10, 126.70, 35.23, 126.86)
        tiles = _split_bbox(bbox, 0.04)
        self.assertGreater(len(tiles), 1)
        self.assertLessEqual(min(tile[0] for tile in tiles), bbox[0])
        self.assertLessEqual(min(tile[1] for tile in tiles), bbox[1])
        self.assertGreaterEqual(max(tile[2] for tile in tiles), bbox[2])
        self.assertGreaterEqual(max(tile[3] for tile in tiles), bbox[3])
        self.assertTrue(all(tile[2] - tile[0] <= 0.0400001 for tile in tiles))
        self.assertTrue(all(tile[3] - tile[1] <= 0.0400001 for tile in tiles))

    def test_excessive_tile_count_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "너무 큽니다"):
            filter_by_nearby_facilities(
                [
                    listing(id="naver:1", lat="33.1", lon="124.1"),
                    listing(id="naver:2", lat="39.4", lon="131.9"),
                ],
                {**self.settings, "overpassMaxTiles": 4},
                fetcher=lambda *_: {"elements": []},
                now=NOW,
            )

    def test_fresh_cache_avoids_network(self):
        school = node(50, 35.1810, 126.8200, amenity="school", name="캐시초등학교")
        first, _ = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [school]}, now=NOW
        )
        self.assertEqual(len(first), 1)

        def should_not_run(*_args):
            raise AssertionError("fresh cache should avoid network")

        second, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=should_not_run, now=NOW + timedelta(hours=23)
        )
        self.assertEqual(len(second), 1)
        self.assertEqual(stats["dataStatus"], "cache")

    def test_cache_refreshes_after_24_hours(self):
        school = node(51, 35.1810, 126.8200, amenity="school", name="일일캐시초등학교")
        filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [school]}, now=NOW
        )
        calls = []

        def fetcher(*_args):
            calls.append(True)
            return {"elements": [school]}

        kept, stats = filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=fetcher,
            now=NOW + timedelta(hours=24, seconds=1),
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(stats["dataStatus"], "network")
        self.assertEqual(len(calls), 1)

    def test_stale_covering_cache_is_fallback_after_api_failure(self):
        school = node(60, 35.1810, 126.8200, amenity="school", name="오래된중학교")
        filter_by_nearby_facilities(
            [listing()], self.settings, fetcher=lambda *_: {"elements": [school]}, now=NOW
        )
        stale_settings = {**self.settings, "cacheTtlHours": 1}

        def fail(*_args):
            raise OSError("offline")

        kept, stats = filter_by_nearby_facilities(
            [listing()], stale_settings, fetcher=fail, now=NOW + timedelta(days=1)
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(stats["dataStatus"], "stale_cache")

    def test_cache_does_not_store_listing_identifiers(self):
        school = node(70, 35.1810, 126.8200, amenity="university", name="광산대학교")
        filter_by_nearby_facilities(
            [listing(id="private-listing-id")], self.settings,
            fetcher=lambda *_: {"elements": [school]}, now=NOW
        )
        cache_text = Path(self.cache_path).read_text(encoding="utf-8")
        self.assertNotIn("private-listing-id", cache_text)
        self.assertIn("광산대학교", cache_text)
        self.assertEqual(json.loads(cache_text)["schemaVersion"], 2)

    def test_radius_must_be_500(self):
        for radius in (499, 501, 800):
            with self.subTest(radius=radius):
                with self.assertRaises(ValueError):
                    filter_by_nearby_facilities([], {**self.settings, "nearbyRadiusM": radius})


if __name__ == "__main__":
    unittest.main()
