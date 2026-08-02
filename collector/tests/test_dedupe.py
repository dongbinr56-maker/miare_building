# -*- coding: utf-8 -*-
"""중복 병합 후 조건 등급 회귀 테스트."""

import sys
import unittest
from pathlib import Path


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from dedupe import merge_duplicates  # noqa: E402


class DedupeMatchLevelTests(unittest.TestCase):
    def test_premium_evidence_updates_checks_and_match_level(self):
        common = {
            "dong": "신가동",
            "deposit": 500,
            "rent": 50,
            "pyeong": 8,
            "floor": 1,
            "lat": "35.1900",
            "lon": "126.8200",
        }
        without_evidence = {
            **common,
            "id": "naver:1",
            "source": "naver",
            "link": "https://example.com/naver/1",
            "desc": "상가 매물",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }
        with_evidence = {
            **common,
            "id": "daangn:1",
            "source": "daangn",
            "link": "https://realty.daangn.com/articles/1",
            "desc": "무권리",
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {
                "source": "daangn_public_detail",
                "field": "content",
                "matchedText": "무권리",
                "contextText": "무권리",
                "articleUrl": "https://realty.daangn.com/articles/1",
            },
            "noPremium": True,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": True},
            "matchLevel": "full",
        }

        merged = merge_duplicates([without_evidence, with_evidence])

        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["noPremium"])
        self.assertTrue(merged[0]["checks"]["premium"])
        self.assertEqual(merged[0]["matchLevel"], "full")
        self.assertEqual(
            merged[0]["mergedListingIds"],
            ["naver:1", "daangn:1"],
        )

    def test_positive_structured_premium_wins_over_no_premium_description(self):
        common = {
            "dong": "신가동",
            "deposit": 500,
            "rent": 50,
            "pyeong": 8,
            "floor": 1,
            "lat": "35.1900",
            "lon": "126.8200",
        }
        explicit_none = {
            **common,
            "id": "naver:100",
            "source": "naver",
            "link": "https://example.com/naver/100",
            "desc": "무권리",
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {
                "source": "naver_list_description",
                "field": "articleFeatureDesc",
                "matchedText": "무권리",
            },
            "noPremium": True,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": True},
            "matchLevel": "full",
        }
        positive = {
            **common,
            "id": "daangn:2970853",
            "source": "daangn",
            "link": "https://realty.daangn.com/articles/2970853",
            "desc": "권리금 1만원",
            "premiumMoney": 1,
            "premiumStatus": "present",
            "premiumEvidence": {
                "source": "daangn_structured_data",
                "field": "premiumMoney",
                "value": 1,
            },
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }

        merged = merge_duplicates([explicit_none, positive])

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["premiumStatus"], "present")
        self.assertEqual(merged[0]["premiumMoney"], 1)
        self.assertFalse(merged[0]["noPremium"])
        self.assertFalse(merged[0]["checks"]["premium"])
        self.assertEqual(merged[0]["matchLevel"], "near")

    def test_no_premium_evidence_wins_over_unknown_but_not_positive(self):
        common = {
            "dong": "우산동",
            "deposit": 700,
            "rent": 55,
            "pyeong": 9,
            "floor": 1,
            "lat": "35.1600",
            "lon": "126.8100",
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }
        unknown = {
            **common,
            "id": "naver:200",
            "source": "naver",
            "link": "https://example.com/naver/200",
            "premiumStatus": "unknown",
            "noPremium": False,
        }
        explicit_none = {
            **common,
            "id": "daangn:200",
            "source": "daangn",
            "link": "https://realty.daangn.com/articles/200",
            "desc": "무권리",
            "premiumStatus": "none",
            "noPremium": True,
            "premiumEvidence": {
                "source": "daangn_public_detail",
                "field": "content",
                "matchedText": "권리금 없음",
                "contextText": "권리금 없음",
                "articleUrl": "https://realty.daangn.com/articles/200",
            },
        }

        merged = merge_duplicates([unknown, explicit_none])

        self.assertEqual(merged[0]["premiumStatus"], "none")
        self.assertTrue(merged[0]["noPremium"])
        self.assertTrue(merged[0]["checks"]["premium"])
        self.assertEqual(merged[0]["matchLevel"], "full")

    def test_legacy_full_without_premium_check_is_recalculated(self):
        item = {
            "id": "daangn:300",
            "source": "daangn",
            "dong": "우산동",
            "deposit": 700,
            "rent": 55,
            "pyeong": 9,
            "floor": 1,
            "lat": "35.16",
            "lon": "126.81",
            "premiumMoney": None,
            "premiumStatus": "present",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True},
            "matchLevel": "full",
        }
        merged = merge_duplicates([item])[0]
        self.assertFalse(merged["checks"]["premium"])
        self.assertEqual(merged["premiumStatus"], "unknown")
        self.assertEqual(merged["matchLevel"], "near")

    def test_single_listing_keeps_its_original_id_for_blocking(self):
        item = {
            "id": "naver:42",
            "source": "naver",
            "dong": "송정동",
            "deposit": 500,
            "rent": 40,
            "pyeong": 9,
            "floor": 1,
            "lat": "35.139",
            "lon": "126.793",
            "link": "https://example.com/naver/42",
        }

        merged = merge_duplicates([item])

        self.assertEqual(merged[0]["mergedListingIds"], ["naver:42"])

    def test_malformed_previous_id_collection_does_not_break_merge(self):
        item = {
            "id": "daangn:99",
            "source": "daangn",
            "dong": "도산동",
            "deposit": 700,
            "rent": 45,
            "pyeong": 10,
            "floor": 1,
            "lat": "35.130",
            "lon": "126.790",
            "link": "https://example.com/daangn/99",
            "mergedListingIds": "naver:wrong-schema",
        }

        merged = merge_duplicates([item])

        self.assertEqual(merged[0]["mergedListingIds"], ["daangn:99"])

    def test_remerge_preserves_all_unique_supported_original_ids(self):
        common = {
            "dong": "우산동",
            "deposit": 800,
            "rent": 50,
            "pyeong": 12,
            "floor": 2,
            "lat": "35.1600",
            "lon": "126.8100",
        }
        previously_merged = {
            **common,
            "id": "naver:10",
            "source": "naver",
            "link": "https://example.com/naver/10",
            "mergedListingIds": ["naver:10", "daangn:20", "naver:10", "other:30"],
        }
        fresh = {
            **common,
            "id": "daangn:30",
            "source": "daangn",
            "link": "https://example.com/daangn/30",
        }

        merged = merge_duplicates([previously_merged, fresh])

        self.assertEqual(
            merged[0]["mergedListingIds"],
            ["naver:10", "daangn:20", "daangn:30"],
        )


if __name__ == "__main__":
    unittest.main()
