# -*- coding: utf-8 -*-

import sys
import unittest
from pathlib import Path

COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from change_history import build_change_history  # noqa: E402


def listing(listing_id, **overrides):
    source = listing_id.split(":", 1)[0]
    value = {
        "id": listing_id,
        "source": source,
        "mergedListingIds": [listing_id],
        "dong": "신가동",
        "name": "테스트 상가",
        "deposit": 500,
        "rent": 50,
        "floor": 1,
        "areaM2": 40.0,
        "desc": "무권리 · 기본 설명",
        "roadAddress": "신가삼효로 20-18",
        "jibunAddress": "신가동 976-6",
        "lat": "35.181",
        "lon": "126.82",
        "locationConfidence": "high",
        "locationPrecision": "building",
        "firstSeen": "2026-07-01",
        "link": f"https://example.test/{listing_id}",
    }
    value.update(overrides)
    return value


class ChangeHistoryTests(unittest.TestCase):
    def compare(self, previous, current):
        return build_change_history(
            {"updatedAt": "2026-08-01T12:00:00+09:00", "listings": previous},
            current,
            "2026-08-02T12:00:00+09:00",
        )

    def test_empty_previous_is_baseline_not_all_new(self):
        history, identities = build_change_history(
            None, [listing("naver:1")], "2026-08-02T12:00:00+09:00"
        )
        self.assertTrue(history["baseline"])
        self.assertEqual(history["events"], [])
        self.assertEqual(identities, {})

    def test_merged_id_overlap_preserves_identity_and_detects_changes(self):
        previous = listing("naver:1", mergedListingIds=["naver:1", "daangn:2"])
        current = listing(
            "daangn:2",
            mergedListingIds=["daangn:2", "naver:3"],
            rent=45,
            desc="무권리 · 설명 변경",
        )
        history, identities = self.compare([previous], [current])
        self.assertEqual(history["counts"]["priceChanged"], 1)
        self.assertEqual(history["counts"]["descriptionChanged"], 1)
        self.assertEqual(history["counts"]["new"], 0)
        self.assertIs(identities["daangn:2"], previous)

    def test_new_and_deleted_are_reported(self):
        history, _ = self.compare(
            [listing("naver:1")],
            [listing(
                "daangn:2",
                roadAddress="다른길 1",
                jibunAddress="신가동 1",
                lat="35.19",
                lon="126.84",
            )],
        )
        self.assertEqual(history["counts"]["new"], 1)
        self.assertEqual(history["counts"]["deleted"], 1)
        self.assertEqual(history["counts"]["relisted"], 0)

    def test_unique_same_building_and_unit_is_high_confidence_relist(self):
        previous = listing("daangn:10")
        current = listing("daangn:11", rent=48)
        history, identities = self.compare([previous], [current])
        self.assertEqual(history["counts"]["relisted"], 1)
        self.assertEqual(history["counts"]["new"], 0)
        self.assertEqual(history["counts"]["deleted"], 0)
        self.assertEqual(history["events"][0]["confidence"], "high")
        self.assertIs(identities["daangn:11"], previous)

    def test_relist_also_reports_price_and_description_changes(self):
        previous = listing("daangn:10")
        current = listing(
            "daangn:11",
            rent=48,
            desc="무권리 · 설명 변경",
        )

        history, _ = self.compare([previous], [current])

        self.assertEqual(history["counts"]["relisted"], 1)
        self.assertEqual(history["counts"]["priceChanged"], 1)
        self.assertEqual(history["counts"]["descriptionChanged"], 1)
        self.assertEqual(
            {event["type"] for event in history["events"]},
            {"relisted", "price_changed", "description_changed"},
        )

    def test_ambiguous_relist_candidates_remain_new_and_deleted(self):
        previous = [listing("daangn:10"), listing("naver:20")]
        current = [listing("daangn:11")]
        history, _ = self.compare(previous, current)
        self.assertEqual(history["counts"]["relisted"], 0)
        self.assertEqual(history["counts"]["new"], 1)
        self.assertEqual(history["counts"]["deleted"], 2)

    def test_one_previous_with_two_relist_candidates_is_also_ambiguous(self):
        previous = [listing("daangn:10")]
        current = [listing("daangn:11"), listing("naver:20")]

        history, _ = self.compare(previous, current)

        self.assertEqual(history["counts"]["relisted"], 0)
        self.assertEqual(history["counts"]["new"], 2)
        self.assertEqual(history["counts"]["deleted"], 1)

    def test_event_cap_keeps_full_counts_and_marks_truncation(self):
        previous = [listing(f"naver:{index}") for index in range(1, 502)]
        current = [listing(f"naver:{index}", rent=49) for index in range(1, 502)]

        history, identities = self.compare(previous, current)

        self.assertEqual(history["counts"]["priceChanged"], 501)
        self.assertEqual(len(history["events"]), 500)
        self.assertTrue(history["truncated"])
        self.assertEqual(len(identities), 501)

    def test_high_confidence_coordinates_can_match_without_address(self):
        previous = listing("daangn:10", roadAddress=None, jibunAddress=None)
        current = listing(
            "daangn:11",
            roadAddress=None,
            jibunAddress=None,
            lat="35.18105",
            lon="126.82005",
        )
        history, _ = self.compare([previous], [current])
        self.assertEqual(history["counts"]["relisted"], 1)

    def test_low_confidence_coordinates_never_infer_relist(self):
        previous = listing(
            "daangn:10", roadAddress=None, jibunAddress=None,
            locationConfidence="low", locationPrecision="approximate",
        )
        current = listing(
            "daangn:11", roadAddress=None, jibunAddress=None,
            locationConfidence="low", locationPrecision="approximate",
        )
        history, _ = self.compare([previous], [current])
        self.assertEqual(history["counts"]["relisted"], 0)

    def test_different_floor_or_area_is_not_relist(self):
        for override in (
            {"floor": 2},
            {"floor": None},
            {"areaM2": 43.0},
            {"areaM2": None},
        ):
            with self.subTest(override=override):
                history, _ = self.compare(
                    [listing("daangn:10")], [listing("daangn:11", **override)]
                )
                self.assertEqual(history["counts"]["relisted"], 0)


if __name__ == "__main__":
    unittest.main()
