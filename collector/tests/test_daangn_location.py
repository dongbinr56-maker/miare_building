# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from daangn import (
    _apply_detail_premium,
    _apply_linked_location,
    _enrich_locations,
    _extract_article_location,
    _extract_complex_location,
    _normalize,
    _parse_relay_store,
)


ARTICLE_ID = "3406844"
COMPLEX_ID = "17876612"
COMPLEX_RELAY_ID = "complex-relay"
BUILDING_ID = "building-relay"


def _html(store):
    encoded_store = json.dumps(store, ensure_ascii=False)
    return f'<script>window.RELAY_STORE = {json.dumps(encoded_store, ensure_ascii=False)};</script>'


class _Response:
    status_code = 200

    def __init__(self, text):
        self.text = text


class _Session:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, **_kwargs):
        self.calls.append(url)
        return _Response(self.responses[url])


class DaangnLocationTest(unittest.TestCase):
    def article_store(self):
        return {
            "article": {
                "__typename": "Article",
                "originalId": ARTICLE_ID,
                "updatedAt": "2026-08-02T04:09:49.000Z",
                "premiumMoney": None,
                "premiumMoneyDescription": None,
                "content": "상가 앞 주차 편리 · 무권리 상가 · 공방 추천",
                "floor": "1.0",
                "topFloor": "3",
                "buildingApprovalDate": "2003-02-21",
                "buildingUsage": "SINGLE_FAMILY_HOUSING",
                "availableTotalParkingSpots": 2,
                "complex": {"__ref": COMPLEX_RELAY_ID},
            },
            COMPLEX_RELAY_ID: {
                "__typename": "PropComplex",
                "id": COMPLEX_RELAY_ID,
                "originalId": COMPLEX_ID,
                "name": "신가삼효로 20-18",
                "buildings(first:10)": {"__ref": "building-connection"},
            },
            "building-connection": {
                "edges": {"__refs": ["building-edge"]},
            },
            "building-edge": {"node": {"__ref": BUILDING_ID}},
            BUILDING_ID: {
                "__typename": "PropBuilding",
                "id": BUILDING_ID,
                "roadAddress": "전남광주통합특별시 광산구 신가삼효로 20-18",
                "jibunAddress": "전남광주통합특별시 광산구 신가동 976-6",
            },
        }

    def complex_store(self):
        store = self.article_store()
        store[COMPLEX_RELAY_ID]["coordinate"] = {"__ref": "exact-coordinate"}
        store["exact-coordinate"] = {
            "__typename": "Coordinate",
            "lat": "35.1855404759744",
            "lon": "126.83450898461031",
        }
        return store

    def test_relay_store_and_linked_building_are_parsed(self):
        store = _parse_relay_store(_html(self.article_store()))
        location = _extract_article_location(store, ARTICLE_ID)

        self.assertEqual(location["complexId"], COMPLEX_ID)
        self.assertEqual(location["buildingId"], BUILDING_ID)
        self.assertEqual(location["roadAddress"], "전남광주통합특별시 광산구 신가삼효로 20-18")
        self.assertEqual(location["articleBuilding"]["approvalDate"], "2003-02-21")
        self.assertEqual(location["articleBuilding"]["parkingSpots"], 2)
        self.assertEqual(
            location["premiumEvidence"],
            {
                "field": "content",
                "matchedText": "무권리",
                "contextText": "상가 앞 주차 편리 · 무권리 상가 · 공방 추천",
            },
        )

    def test_detail_premium_evidence_promotes_match_without_complex(self):
        store = self.article_store()
        store["article"]["complex"] = None
        detail = _extract_article_location(store, ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "중개",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": False, "premium": False},
            "matchLevel": "low",
        }

        changed = _apply_detail_premium(item, detail)

        self.assertEqual(detail["status"], "no-complex")
        self.assertTrue(changed)
        self.assertTrue(item["noPremium"])
        self.assertTrue(item["checks"]["premium"])
        self.assertEqual(item["matchLevel"], "near")
        self.assertEqual(item["premiumEvidence"]["field"], "content")

    def test_missing_amount_and_non_explicit_text_do_not_pass(self):
        store = self.article_store()
        store["article"]["content"] = "권리금은 중개사에게 문의하세요"
        detail = _extract_article_location(store, ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "중개",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }

        self.assertFalse(_apply_detail_premium(item, detail))
        self.assertFalse(item["noPremium"])
        self.assertFalse(item["checks"]["premium"])

    def test_negated_no_premium_phrases_are_not_evidence(self):
        for text in (
            "무권리 매물은 아닙니다",
            "무권리라고 볼 수 없음",
            "권리금 없음은 거짓",
            "권리금 없음?",
            "권리금 없음 여부 미확인",
            "아님: 무권리",
        ):
            with self.subTest(text=text):
                store = self.article_store()
                store["article"]["content"] = text
                detail = _extract_article_location(store, ARTICLE_ID)
                self.assertIsNone(detail["premiumEvidence"])

    def test_malformed_amount_cannot_fall_back_to_description(self):
        for raw_amount in (-1, float("nan"), float("inf"), True, "oops"):
            with self.subTest(raw_amount=raw_amount):
                store = self.article_store()
                store["article"]["premiumMoney"] = raw_amount
                detail = _extract_article_location(store, ARTICLE_ID)
                item = {
                    "id": f"daangn:{ARTICLE_ID}",
                    "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
                    "desc": "무권리 · 중개",
                    "premiumMoney": raw_amount,
                    "premiumStatus": "unknown",
                    "noPremium": False,
                    "checks": {
                        "deposit": True,
                        "rent": True,
                        "floor": True,
                        "premium": False,
                    },
                    "matchLevel": "near",
                }
                self.assertFalse(_apply_detail_premium(item, detail))
                self.assertEqual(item["premiumStatus"], "unknown")
                self.assertFalse(item["checks"]["premium"])

    def test_malformed_amount_stays_unknown_through_real_normalize_pipeline(self):
        criteria = {
            "depositMin": 500,
            "depositMax": 1000,
            "rentMax": 60,
            "floorMin": -1,
            "floorMax": 2,
            "requireNoPremium": True,
        }
        for raw_amount in (-1, float("nan"), float("inf"), True, "oops", "1만원"):
            with self.subTest(raw_amount=raw_amount):
                item = _normalize(
                    {
                        "originalId": ARTICLE_ID,
                        "trades": [{"type": "MONTH", "deposit": 500, "monthlyPay": 60}],
                        "area": 30,
                        "floor": 1,
                        "topFloor": 3,
                        "premiumMoney": raw_amount,
                        "publicCoordinate": {"lat": 35.19, "lon": 126.82},
                    },
                    "신가동",
                    criteria,
                )
                detail = {
                    "premiumMoney": None,
                    "premiumEvidence": {
                        "field": "content",
                        "matchedText": "무권리",
                        "contextText": "무권리",
                    },
                }
                self.assertFalse(_apply_detail_premium(item, detail))
                self.assertEqual(item["premiumStatus"], "unknown")
                self.assertFalse(item["checks"]["premium"])

    def test_grammatical_explicit_no_premium_phrase_is_accepted(self):
        store = self.article_store()
        store["article"]["content"] = "권리금은 없습니다"
        detail = _extract_article_location(store, ARTICLE_ID)
        self.assertEqual(detail["premiumEvidence"]["matchedText"], "권리금은 없습니다")

    def test_comma_formatted_positive_amount_is_still_premium(self):
        store = self.article_store()
        store["article"]["premiumMoney"] = "1,000"
        detail = _extract_article_location(store, ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "무권리",
            "premiumMoney": "1,000",
            "premiumStatus": "present",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }
        _apply_detail_premium(item, detail)
        self.assertEqual(item["premiumMoney"], 1000)
        self.assertEqual(item["premiumStatus"], "present")
        self.assertNotIn("무권리", item["desc"])

    def test_structured_positive_amount_overrides_no_premium_detail_text(self):
        store = self.article_store()
        store["article"]["premiumMoney"] = 1
        detail = _extract_article_location(store, ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "무권리",
            "premiumMoney": 1,
            "premiumStatus": "present",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
        }

        _apply_detail_premium(item, detail)

        self.assertEqual(item["premiumStatus"], "present")
        self.assertEqual(item["premiumMoney"], 1)
        self.assertFalse(item["noPremium"])
        self.assertFalse(item["checks"]["premium"])
        self.assertEqual(item["matchLevel"], "near")
        self.assertEqual(item["premiumEvidence"]["field"], "premiumMoney")
        self.assertNotIn("무권리", item["desc"])

    def test_positive_detail_text_overrides_structured_zero(self):
        store = self.article_store()
        store["article"]["premiumMoney"] = 0
        store["article"]["content"] = "무권리라고 적혀 있으나 권리금 1만원"
        detail = _extract_article_location(store, ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "무권리",
            "premiumMoney": 0,
            "premiumStatus": "none",
            "noPremium": True,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": True},
            "matchLevel": "full",
        }
        _apply_detail_premium(item, detail)
        self.assertEqual(item["premiumMoney"], 1)
        self.assertEqual(item["premiumStatus"], "present")
        self.assertFalse(item["checks"]["premium"])
        self.assertEqual(item["matchLevel"], "near")
        self.assertIn("권리금 1만원", item["desc"])

    def test_malformed_listing_amount_and_detail_zero_remain_unknown(self):
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "desc": "무권리",
            "premiumMoney": None,
            "premiumStatus": "unknown",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": True, "premium": False},
            "matchLevel": "near",
            "_daangnPremiumMalformed": True,
        }
        _apply_detail_premium(item, {"premiumMoney": 0})
        self.assertEqual(item["premiumStatus"], "unknown")
        self.assertFalse(item["checks"]["premium"])

    def test_listing_2970853_with_one_manwon_premium_is_excluded(self):
        article = {
            "originalId": "2970853",
            "trades": [{"type": "MONTH", "deposit": 500, "monthlyPay": 60}],
            "area": 30,
            "floor": 1,
            "topFloor": 2,
            "premiumMoney": 1,
            "premiumMoneyDescription": "현재 성업중 레시피 전수",
            "content": "건강상 문제로 급매합니다",
            "publicCoordinate": {"lat": 35.1, "lon": 126.8},
        }
        criteria = {
            "depositMin": 500,
            "depositMax": 1000,
            "rentMax": 60,
            "floorMin": -1,
            "floorMax": 2,
            "requireNoPremium": True,
        }

        item = _normalize(article, "신가동", criteria)

        self.assertEqual(item["id"], "daangn:2970853")
        self.assertEqual(item["premiumStatus"], "present")
        self.assertEqual(item["premiumMoney"], 1)
        self.assertFalse(item["noPremium"])
        self.assertFalse(item["checks"]["premium"])
        self.assertNotEqual(item["matchLevel"], "full")

    def test_missing_amount_requires_explicit_no_premium_text(self):
        article = {
            "originalId": "9999999",
            "trades": [{"type": "MONTH", "deposit": 500, "monthlyPay": 60}],
            "area": 30,
            "floor": 1,
            "premiumMoney": None,
            "publicCoordinate": {"lat": 35.1, "lon": 126.8},
        }
        criteria = {
            "depositMin": 500,
            "depositMax": 1000,
            "rentMax": 60,
            "floorMin": -1,
            "floorMax": 2,
            "requireNoPremium": True,
        }

        item = _normalize(article, "신가동", criteria)

        self.assertEqual(item["premiumStatus"], "unknown")
        self.assertIsNone(item["premiumMoney"])
        self.assertFalse(item["noPremium"])
        self.assertFalse(item["checks"]["premium"])

    def test_potential_low_candidate_is_fetched_and_promoted_to_near(self):
        article_url = f"https://realty.daangn.com/articles/{ARTICLE_ID}"
        store = self.article_store()
        store["article"]["complex"] = None
        session = _Session({article_url: _html(store)})
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": article_url,
            "desc": "중개",
            "noPremium": False,
            "checks": {"deposit": True, "rent": True, "floor": False, "premium": False},
            "matchLevel": "low",
            "lat": "35.1915454",
            "lon": "126.8452770",
            "locationSource": "daangn_public_coordinate",
            "locationPrecision": "approximate",
            "locationConfidence": "low",
            "_daangnUpdatedAt": "2026-08-02T04:09:49.000Z",
            "_daangnPremiumMissing": True,
        }
        config = {
            "exactLocationLevels": ["full", "near"],
            "maxArticleDetailRequestsPerRun": 5,
            "maxComplexDetailRequestsPerRun": 5,
            "detailRequestDelaySeconds": 0,
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("daangn.CACHE_PATH", os.path.join(temp_dir, "locations.json")):
                _enrich_locations([item], session, config, lambda _msg: None)

        self.assertEqual(session.calls, [article_url])
        self.assertTrue(item["noPremium"])
        self.assertEqual(item["matchLevel"], "near")
        self.assertNotIn("_daangnPremiumMissing", item)

    def test_complex_coordinate_is_used_only_with_traceable_evidence(self):
        article_location = _extract_article_location(self.article_store(), ARTICLE_ID)
        complex_location = _extract_complex_location(self.complex_store(), COMPLEX_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "lat": "35.1915454",
            "lon": "126.8452770",
            "locationSource": "daangn_public_coordinate",
            "locationPrecision": "approximate",
            "locationConfidence": "low",
        }

        _apply_linked_location(item, article_location, complex_location)

        self.assertEqual(item["lat"], "35.1855404759744")
        self.assertEqual(item["lon"], "126.83450898461031")
        self.assertEqual(item["locationPrecision"], "building")
        self.assertEqual(item["locationConfidence"], "high")
        self.assertTrue(item["locationEvidence"]["buildingIdMatched"])
        self.assertTrue(item["locationEvidence"]["addressMatched"])
        self.assertGreater(item["locationEvidence"]["publicCoordinateDistanceM"], 500)

    def test_missing_complex_coordinate_keeps_public_coordinate(self):
        article_location = _extract_article_location(self.article_store(), ARTICLE_ID)
        item = {
            "id": f"daangn:{ARTICLE_ID}",
            "link": f"https://realty.daangn.com/articles/{ARTICLE_ID}",
            "lat": "35.1915454",
            "lon": "126.8452770",
            "locationSource": "daangn_public_coordinate",
            "locationPrecision": "approximate",
            "locationConfidence": "low",
        }

        _apply_linked_location(item, article_location, None)

        self.assertEqual(item["lat"], "35.1915454")
        self.assertEqual(item["lon"], "126.8452770")
        self.assertEqual(item["locationSource"], "daangn_public_coordinate")
        self.assertEqual(item["locationPrecision"], "approximate")
        self.assertEqual(item["roadAddress"], "전남광주통합특별시 광산구 신가삼효로 20-18")

    def test_enrichment_reuses_disk_cache_without_more_requests(self):
        article_url = f"https://realty.daangn.com/articles/{ARTICLE_ID}"
        complex_url = f"https://realty.daangn.com/complexes/{COMPLEX_ID}"
        responses = {
            article_url: _html(self.article_store()),
            complex_url: _html(self.complex_store()),
        }
        config = {
            "exactLocationLevels": ["full"],
            "maxArticleDetailRequestsPerRun": 5,
            "maxComplexDetailRequestsPerRun": 5,
            "detailRequestDelaySeconds": 0,
        }

        def item():
            return {
                "id": f"daangn:{ARTICLE_ID}",
                "link": article_url,
                "lat": "35.1915454",
                "lon": "126.8452770",
                "matchLevel": "full",
                "desc": "중개",
                "noPremium": True,
                "checks": {"deposit": True, "rent": True, "floor": True, "premium": True},
                "locationSource": "daangn_public_coordinate",
                "locationPrecision": "approximate",
                "locationConfidence": "low",
                "_daangnUpdatedAt": "2026-08-02T04:09:49.000Z",
                "_daangnPremiumMissing": False,
            }

        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = os.path.join(temp_dir, "daangn_locations.json")
            with patch("daangn.CACHE_PATH", cache_path):
                first_session = _Session(responses)
                first_item = item()
                _enrich_locations([first_item], first_session, config, lambda _msg: None)
                self.assertEqual(len(first_session.calls), 2)
                self.assertEqual(first_item["locationPrecision"], "building")
                self.assertNotIn("_daangnUpdatedAt", first_item)
                self.assertNotIn("_daangnPremiumMissing", first_item)

                second_session = _Session({})
                second_item = item()
                _enrich_locations([second_item], second_session, config, lambda _msg: None)
                self.assertEqual(second_session.calls, [])
                self.assertEqual(second_item["lat"], "35.1855404759744")


if __name__ == "__main__":
    unittest.main()
