# -*- coding: utf-8 -*-
"""매물 조건 경계값 회귀 테스트."""

import sys
import unittest
from pathlib import Path


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from rules import (  # noqa: E402
    PREMIUM_NONE,
    PREMIUM_PRESENT,
    PREMIUM_UNKNOWN,
    audit_premium_classifications,
    evaluate,
    explicit_no_premium_evidence,
    explicit_premium_amount_evidence,
    is_no_premium_amount,
    premium_status_from_amount,
)
from collect import normalize as normalize_naver  # noqa: E402


CRITERIA = {
    "depositMin": 500,
    "depositMax": 1000,
    "rentMax": 60,
    "floorMin": -1,
    "floorMax": 2,
    "requireNoPremium": True,
}


class EvaluateTests(unittest.TestCase):
    def evaluate(self, deposit=500, rent=60, floor=-1, no_premium=True):
        return evaluate(deposit, rent, floor, no_premium, CRITERIA)

    def test_all_conditions_produce_full_match(self):
        checks, level = self.evaluate()

        self.assertEqual(
            checks,
            {"deposit": True, "rent": True, "floor": True, "premium": True},
        )
        self.assertEqual(level, "full")

    def test_deposit_boundaries_are_inclusive(self):
        for value in (500, 1000):
            with self.subTest(value=value):
                self.assertTrue(self.evaluate(deposit=value)[0]["deposit"])

        for value in (499, 1001, None):
            with self.subTest(value=value):
                self.assertFalse(self.evaluate(deposit=value)[0]["deposit"])

    def test_rent_sixty_is_included_but_above_is_excluded(self):
        self.assertTrue(self.evaluate(rent=59)[0]["rent"])
        self.assertTrue(self.evaluate(rent=60)[0]["rent"])
        self.assertFalse(self.evaluate(rent=61)[0]["rent"])
        self.assertFalse(self.evaluate(rent=None)[0]["rent"])

    def test_legacy_exclusive_rent_limit_is_still_supported(self):
        legacy = {**CRITERIA, "rentMaxExclusive": 60}
        del legacy["rentMax"]
        self.assertTrue(evaluate(500, 59, -1, True, legacy)[0]["rent"])
        self.assertFalse(evaluate(500, 60, -1, True, legacy)[0]["rent"])

    def test_floor_boundaries_are_inclusive(self):
        for value in (-1, 0, 1, 2):
            with self.subTest(value=value):
                self.assertTrue(self.evaluate(floor=value)[0]["floor"])

        for value in (-2, 3, None):
            with self.subTest(value=value):
                self.assertFalse(self.evaluate(floor=value)[0]["floor"])

    def test_no_premium_is_required(self):
        self.assertTrue(self.evaluate(no_premium=True)[0]["premium"])
        self.assertFalse(self.evaluate(no_premium=False)[0]["premium"])
        self.assertFalse(self.evaluate(no_premium=None)[0]["premium"])

    def test_daangn_no_premium_amount_is_strict(self):
        for value in (0, 0.0, "0"):
            with self.subTest(value=value):
                self.assertTrue(is_no_premium_amount(value))

        for value in (None, -1, 0.5, 1, "1", 10, "", "unknown", True):
            with self.subTest(value=value):
                self.assertFalse(is_no_premium_amount(value))

    def test_structured_premium_status_keeps_zero_positive_and_missing_distinct(self):
        self.assertEqual(premium_status_from_amount(0), PREMIUM_NONE)
        self.assertEqual(premium_status_from_amount(1), PREMIUM_PRESENT)
        self.assertEqual(premium_status_from_amount(10), PREMIUM_PRESENT)
        self.assertEqual(premium_status_from_amount(None), PREMIUM_UNKNOWN)

    def test_explicit_positive_premium_amounts_are_parsed_conservatively(self):
        self.assertEqual(
            explicit_premium_amount_evidence("권리금 1만원")["amount"], 1
        )
        self.assertEqual(
            explicit_premium_amount_evidence("권리금은 1.5억")["amount"], 15000
        )
        self.assertIsNone(explicit_premium_amount_evidence("권리금 0만원"))
        self.assertEqual(
            explicit_premium_amount_evidence("권리금 10만원, 권리금 500만원")["amount"],
            500,
        )

    def test_premium_audit_catches_positive_and_unsupported_no_premium(self):
        rows = [
            {
                "id": "daangn:2970853",
                "mergedListingIds": ["daangn:2970853", "naver:1"],
                "premiumMoney": 1,
                "premiumStatus": "none",
                "noPremium": True,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
            {
                "id": "naver:2",
                "premiumMoney": None,
                "premiumStatus": "none",
                "noPremium": True,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
        ]

        audit = audit_premium_classifications(rows)

        self.assertEqual(audit["positiveMisclassified"], 1)
        # 두 행 모두 noPremium=True인데 허용된 0원/명시 문구 근거가 없다.
        self.assertEqual(audit["noPremiumWithoutEvidence"], 2)
        self.assertEqual(audit["regressionListingSelected"], 1)
        self.assertGreaterEqual(audit["classificationInconsistent"], 2)
        self.assertGreaterEqual(audit["selectedWithoutNoPremiumProof"], 2)
        self.assertGreater(audit["totalViolations"], 3)

    def test_premium_audit_accepts_structured_zero_and_explicit_text_evidence(self):
        rows = [
            {
                "id": "daangn:10",
                "premiumMoney": 0,
                "premiumStatus": "none",
                "noPremium": True,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
            {
                "id": "naver:10",
                "desc": "권리금 없음",
                "premiumMoney": None,
                "premiumStatus": "none",
                "premiumEvidence": {
                    "source": "naver_list_description",
                    "field": "articleFeatureDesc",
                    "matchedText": "권리금 없음",
                    "contextText": "권리금 없음",
                    "articleUrl": "https://new.land.naver.com/offices?articleNo=10",
                },
                "noPremium": True,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
        ]

        self.assertEqual(audit_premium_classifications(rows)["totalViolations"], 0)

    def test_premium_audit_rejects_selected_unknown_and_contradictory_zero(self):
        rows = [
            {
                "id": "naver:20",
                "premiumMoney": None,
                "premiumStatus": "unknown",
                "noPremium": False,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
            {
                "id": "daangn:20",
                "premiumMoney": 0,
                "premiumStatus": "present",
                "noPremium": False,
                "checks": {"premium": True},
                "matchLevel": "full",
            },
        ]
        audit = audit_premium_classifications(rows)
        self.assertEqual(audit["selectedWithoutNoPremiumProof"], 2)
        self.assertEqual(audit["classificationInconsistent"], 2)
        self.assertGreater(audit["totalViolations"], 0)

    def test_arbitrary_evidence_is_not_accepted(self):
        row = {
            "id": "naver:30",
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {"source": "location"},
            "noPremium": True,
            "checks": {"premium": True},
            "matchLevel": "full",
        }
        audit = audit_premium_classifications([row])
        self.assertEqual(audit["noPremiumWithoutEvidence"], 1)
        self.assertGreater(audit["totalViolations"], 0)

    def test_explicit_no_premium_rejects_same_clause_contradictions(self):
        self.assertEqual(explicit_no_premium_evidence("권리금 없음"), "권리금 없음")
        for text in (
            "무권리 매물은 아닙니다",
            "무권리라고 볼 수 없음",
            "권리금 없음은 거짓",
            "권리금 없음?",
            "권리금 없음 여부 미확인",
            "아님: 무권리",
            "무권리인가요?",
            "무권리 맞나요?",
            "무권리인지 문의",
            "무권리 여부는 확인 필요",
            "권리금 없음 맞나요?",
            "권리금 없음으로 확인 필요",
            "권리금 없을까요?",
            "무권리 매물 맞죠?",
        ):
            with self.subTest(text=text):
                self.assertIsNone(explicit_no_premium_evidence(text))
        self.assertEqual(
            explicit_no_premium_evidence("권리금은 없습니다"),
            "권리금은 없습니다",
        )

    def test_premium_audit_binds_evidence_to_the_actual_source_field(self):
        forged_text = {
            "id": "naver:31",
            "desc": "권리금 500만원",
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {
                "source": "naver_list_description",
                "field": "articleFeatureDesc",
                "matchedText": "무권리",
            },
            "noPremium": True,
            "checks": {"premium": True},
            "matchLevel": "full",
        }
        forged_structured = {
            "id": "daangn:31",
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {
                "source": "daangn_structured_data",
                "field": "premiumMoney",
                "value": 0,
            },
            "noPremium": True,
            "checks": {"premium": True},
            "matchLevel": "full",
        }
        audit = audit_premium_classifications([forged_text, forged_structured])
        self.assertEqual(audit["noPremiumWithoutEvidence"], 2)
        self.assertGreater(audit["totalViolations"], 0)

    def test_premium_audit_rejects_malformed_merged_regression_ids(self):
        row = {
            "id": "naver:40",
            "mergedListingIds": "daangn:2970853",
            "desc": "무권리",
            "premiumMoney": 0,
            "premiumStatus": "none",
            "noPremium": True,
            "checks": {"premium": True},
            "matchLevel": "full",
        }
        audit = audit_premium_classifications([row])
        self.assertEqual(audit["regressionListingSelected"], 1)
        self.assertEqual(audit["classificationInconsistent"], 1)
        self.assertGreater(audit["totalViolations"], 0)

    def test_daangn_text_evidence_must_bind_to_listing_id_and_display(self):
        base = {
            "id": "daangn:41",
            "mergedListingIds": ["daangn:41"],
            "premiumMoney": None,
            "premiumStatus": "none",
            "premiumEvidence": {
                "source": "daangn_public_detail",
                "field": "content",
                "matchedText": "무권리",
                "contextText": "무권리",
                "articleUrl": "https://realty.daangn.com/articles/41",
            },
            "noPremium": True,
            "checks": {"premium": True},
            "matchLevel": "full",
        }
        self.assertEqual(
            audit_premium_classifications([{**base, "desc": "무권리"}])["totalViolations"],
            0,
        )
        wrong_desc = audit_premium_classifications(
            [{**base, "desc": "권리금 500만원"}]
        )
        self.assertGreater(wrong_desc["totalViolations"], 0)
        wrong_url = {
            **base,
            "desc": "무권리",
            "premiumEvidence": {
                **base["premiumEvidence"],
                "articleUrl": "https://realty.daangn.com/articles/999",
            },
        }
        self.assertGreater(audit_premium_classifications([wrong_url])["totalViolations"], 0)

    def test_naver_normalization_uses_the_same_strict_text_rule(self):
        base = {
            "articleNo": "123",
            "dealOrWarrantPrc": "500",
            "rentPrc": "60",
            "floorInfo": "1/2",
            "area2": 30,
        }
        accepted = normalize_naver(
            {**base, "articleFeatureDesc": "권리금 없음"}, "신가동", CRITERIA
        )
        rejected = normalize_naver(
            {**base, "articleFeatureDesc": "무권리 매물은 아닙니다"},
            "신가동",
            CRITERIA,
        )
        self.assertEqual(accepted["premiumStatus"], PREMIUM_NONE)
        self.assertTrue(accepted["checks"]["premium"])
        self.assertEqual(rejected["premiumStatus"], PREMIUM_UNKNOWN)
        self.assertFalse(rejected["checks"]["premium"])

    def test_naver_explicit_positive_amount_wins_over_no_premium_phrase(self):
        item = normalize_naver(
            {
                "articleNo": "124",
                "dealOrWarrantPrc": "500",
                "rentPrc": "60",
                "floorInfo": "1/2",
                "area2": 30,
                "articleFeatureDesc": "무권리 안내와 달리 권리금 1만원",
            },
            "신가동",
            CRITERIA,
        )
        self.assertEqual(item["premiumMoney"], 1)
        self.assertEqual(item["premiumStatus"], PREMIUM_PRESENT)
        self.assertFalse(item["checks"]["premium"])
        self.assertEqual(item["matchLevel"], "near")
        self.assertIn("권리금 1만원", item["desc"])
        self.assertNotIn("무권리", item["desc"])

    def test_match_levels_count_the_four_active_conditions(self):
        self.assertEqual(self.evaluate(no_premium=False)[1], "near")
        self.assertEqual(self.evaluate(deposit=499, no_premium=False)[1], "low")

    def test_area_and_parking_are_not_evaluate_inputs(self):
        # 평수와 주차 값은 함수 인자에 없으며 매칭 등급에 영향을 줄 수 없다.
        self.assertEqual(len(self.evaluate()[0]), 4)


if __name__ == "__main__":
    unittest.main()
