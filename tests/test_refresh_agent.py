import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import refresh_agent


class FakeKv:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def get_json(self, key, *, missing_ok=False):
        del missing_ok
        value = self.values.get(key)
        return json.loads(json.dumps(value)) if value is not None else None

    def put_json(self, key, value):
        self.values[key] = json.loads(json.dumps(value))

    def put_bytes(self, key, value):
        self.values[key] = bytes(value)

    def get_text(self, key, *, missing_ok=False):
        del missing_ok
        value = self.values.get(key)
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode("utf-8")
        if isinstance(value, str):
            return value
        return json.dumps(value)


def listing_data():
    updated_at = "2026-08-02T21:00:00+09:00"
    return {
        "updatedAt": updated_at,
        "criteria": dict(refresh_agent.EXPECTED_CRITERIA),
        "stats": {
            "new": 0,
            "nearby": {
                "input": 1,
                "kept": 1,
                "excludedMissingCoordinate": 0,
                "excludedUnreliableCoordinate": 0,
                "excludedNoFacility": 0,
                "excludedUnavailable": 0,
                "radiusM": refresh_agent.EXPECTED_NEARBY_RADIUS_M,
                "source": "openstreetmap_overpass",
                "dataStatus": "cache",
            },
            "premiumAudit": {
                "positiveMisclassified": 0,
                "noPremiumWithoutEvidence": 0,
                "regressionListingSelected": 0,
                "classificationInconsistent": 0,
                "selectedWithoutNoPremiumProof": 0,
                "totalViolations": 0,
            }
        },
        "regions": [],
        "changeHistory": {
            "version": 1,
            "baseline": True,
            "comparedAt": None,
            "currentAt": updated_at,
            "counts": {
                "new": 0,
                "priceChanged": 0,
                "descriptionChanged": 0,
                "deleted": 0,
                "relisted": 0,
            },
            "events": [],
        },
        "listings": [
            {
                "id": "naver:1",
                "source": "naver",
                "mergedListingIds": ["naver:1"],
                "firstSeen": "2026-08-02",
                "isNew": False,
                "deposit": 500,
                "rent": 60,
                "floor": 1,
                "premiumMoney": 0,
                "premiumStatus": "none",
                "noPremium": True,
                "checks": {
                    "deposit": True,
                    "rent": True,
                    "floor": True,
                    "premium": True,
                },
                "matchLevel": "full",
                "nearbyFacilityCheck": {
                    "withinRadius": True,
                    "radiusM": refresh_agent.EXPECTED_NEARBY_RADIUS_M,
                    "source": "openstreetmap_overpass",
                    "dataStatus": "cache",
                    "checkedAt": "2026-08-02T12:00:00Z",
                },
                "nearbyFacilities": [
                    {
                        "name": "테스트초등학교",
                        "distanceM": 500,
                    }
                ],
            }
        ],
    }


def nearby_cache_data():
    return {
        "schemaVersion": refresh_agent.NEARBY_CACHE_SCHEMA_VERSION,
        "fetchedAt": "2026-08-02T12:00:00Z",
        "coverage": {
            "south": 35.06,
            "west": 126.63,
            "north": 35.27,
            "east": 126.88,
        },
        "pois": [
            {
                "osmType": "way",
                "osmId": 123,
                "name": "테스트초등학교",
                "kind": "elementary_school",
                "lat": 35.18,
                "lon": 126.82,
                "bbox": [35.179, 126.819, 35.181, 126.821],
                "geometry": [[
                    [35.179, 126.819],
                    [35.181, 126.819],
                    [35.181, 126.821],
                    [35.179, 126.819],
                ]],
                "tags": {"amenity": "school"},
            }
        ],
    }


def write_nearby_cache(path):
    path.write_text(json.dumps(nearby_cache_data()), encoding="utf-8")


class RefreshAgentTests(unittest.TestCase):
    def test_collection_failure_detail_classifies_browser_rate_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "collector.log"
            log_path.write_text(
                "browser-rendering/devtools/browser 429 Too Many Requests: Rate limit exceeded"
            )
            with patch.object(refresh_agent, "LOG_PATH", log_path):
                self.assertIn("요청 한도", refresh_agent._collection_failure_detail(1))

    def test_collection_failure_detail_keeps_unknown_failure_actionable(self):
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "collector.log"
            log_path.write_text("unknown crash")
            with patch.object(refresh_agent, "LOG_PATH", log_path):
                self.assertIn("종료 코드 7", refresh_agent._collection_failure_detail(7))

    def test_refresh_success_message_discloses_retained_naver_data(self):
        payload = {
            "stats": {
                "providers": {
                    "naver": {"status": "retained"},
                    "daangn": {"status": "fresh"},
                },
            },
        }
        self.assertIn("직전 검증", refresh_agent._refresh_success_message(payload))

    def test_idle_state_does_not_collect(self):
        kv = FakeKv()
        with patch.object(refresh_agent, "_run_collection") as collect:
            self.assertFalse(refresh_agent.process_once(kv))
        collect.assert_not_called()

    def test_pending_state_collects_and_publishes(self):
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-1",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                }
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "listings.json"
            cache_path = Path(directory) / "nearby.json"
            path.write_text(json.dumps(listing_data()), encoding="utf-8")
            write_nearby_cache(cache_path)
            with (
                patch.object(refresh_agent, "LISTINGS_PATH", path),
                patch.object(refresh_agent, "NEARBY_CACHE_PATH", cache_path),
                patch.object(refresh_agent, "_run_collection", return_value=(True, "ok")),
            ):
                self.assertTrue(refresh_agent.process_once(kv))

        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "succeeded")
        self.assertEqual(
            kv.values[refresh_agent.META_KEY]["updatedAt"],
            listing_data()["updatedAt"],
        )
        self.assertIsInstance(kv.values[refresh_agent.LISTINGS_KEY], bytes)
        self.assertEqual(
            json.loads(kv.values[refresh_agent.NEARBY_CACHE_KEY]),
            nearby_cache_data(),
        )

    def test_failed_collector_marks_job_failed(self):
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-2",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                }
            }
        )
        with patch.object(refresh_agent, "_run_collection", return_value=(False, "exit 1")):
            self.assertTrue(refresh_agent.process_once(kv))
        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "failed")
        self.assertNotIn(refresh_agent.LISTINGS_KEY, kv.values)

    def test_failed_dispatched_collector_fails_the_workflow(self):
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-dispatched-failure",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                }
            }
        )
        with (
            patch.object(refresh_agent, "_run_collection", return_value=(False, "exit 1")),
            self.assertRaisesRegex(RuntimeError, "매물 수집에 실패"),
        ):
            refresh_agent.process_once(
                kv,
                expected_job_id="job-dispatched-failure",
            )

        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "failed")
        self.assertNotIn(refresh_agent.LISTINGS_KEY, kv.values)

    def test_expected_job_id_must_match_pending_state(self):
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "newer-job",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                }
            }
        )
        with (
            patch.object(refresh_agent, "_run_collection") as collect,
            self.assertRaisesRegex(RuntimeError, "일치하지 않습니다"),
        ):
            refresh_agent.process_once(kv, expected_job_id="dispatched-job")
        collect.assert_not_called()

    def test_expected_job_id_rejects_non_claimable_state(self):
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-3",
                    "status": "succeeded",
                    "requestedAt": "2026-08-02T12:00:00Z",
                }
            }
        )
        with self.assertRaisesRegex(RuntimeError, "실행할 수 없는 상태"):
            refresh_agent.process_once(kv, expected_job_id="job-3")

    def test_previous_private_snapshot_is_restored_before_collection(self):
        previous = listing_data()
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-4",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                },
                refresh_agent.LISTINGS_KEY: json.dumps(previous).encode("utf-8"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "listings.json"
            cache_path = Path(directory) / "nearby.json"
            write_nearby_cache(cache_path)

            def assert_seeded_then_succeed():
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), previous)
                return True, "ok"

            with (
                patch.object(refresh_agent, "LISTINGS_PATH", path),
                patch.object(refresh_agent, "NEARBY_CACHE_PATH", cache_path),
                patch.object(
                    refresh_agent,
                    "_run_collection",
                    side_effect=assert_seeded_then_succeed,
                ),
            ):
                self.assertTrue(
                    refresh_agent.process_once(kv, expected_job_id="job-4")
                )

    def test_nearby_cache_is_restored_before_collection_and_saved_afterward(self):
        cached = nearby_cache_data()
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-cache",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                },
                refresh_agent.NEARBY_CACHE_KEY: json.dumps(cached).encode("utf-8"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            listings_path = Path(directory) / "listings.json"
            cache_path = Path(directory) / "nearby.json"
            listings_path.write_text(json.dumps(listing_data()), encoding="utf-8")

            def assert_restored_then_succeed():
                self.assertEqual(
                    json.loads(cache_path.read_text(encoding="utf-8")),
                    cached,
                )
                return True, "ok"

            with (
                patch.object(refresh_agent, "LISTINGS_PATH", listings_path),
                patch.object(refresh_agent, "NEARBY_CACHE_PATH", cache_path),
                patch.object(
                    refresh_agent,
                    "_run_collection",
                    side_effect=assert_restored_then_succeed,
                ),
            ):
                self.assertTrue(refresh_agent.process_once(kv))

        self.assertEqual(
            json.loads(kv.values[refresh_agent.NEARBY_CACHE_KEY]),
            cached,
        )
        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "succeeded")

    def test_invalid_kv_cache_blocks_collection_and_preserves_listings(self):
        previous_raw = json.dumps(listing_data()).encode("utf-8")
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-invalid-cache",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                },
                refresh_agent.LISTINGS_KEY: previous_raw,
                refresh_agent.NEARBY_CACHE_KEY: b'{"schemaVersion":2,"pois":',
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(
                    refresh_agent,
                    "LISTINGS_PATH",
                    Path(directory) / "listings.json",
                ),
                patch.object(
                    refresh_agent,
                    "NEARBY_CACHE_PATH",
                    Path(directory) / "nearby.json",
                ),
                patch.object(refresh_agent, "_run_collection") as collect,
            ):
                self.assertTrue(refresh_agent.process_once(kv))

        collect.assert_not_called()
        self.assertEqual(kv.values[refresh_agent.LISTINGS_KEY], previous_raw)
        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "failed")

    def test_cache_upload_failure_never_overwrites_published_listings(self):
        previous_raw = json.dumps(listing_data()).encode("utf-8")
        kv = FakeKv(
            {
                refresh_agent.STATE_KEY: {
                    "jobId": "job-cache-write-failure",
                    "status": "pending",
                    "requestedAt": "2026-08-02T12:00:00Z",
                },
                refresh_agent.LISTINGS_KEY: previous_raw,
            }
        )
        original_put_bytes = kv.put_bytes

        def fail_cache_only(key, value):
            if key == refresh_agent.NEARBY_CACHE_KEY:
                raise RuntimeError("cache write failed")
            original_put_bytes(key, value)

        with tempfile.TemporaryDirectory() as directory:
            listings_path = Path(directory) / "listings.json"
            cache_path = Path(directory) / "nearby.json"
            write_nearby_cache(cache_path)
            with (
                patch.object(refresh_agent, "LISTINGS_PATH", listings_path),
                patch.object(refresh_agent, "NEARBY_CACHE_PATH", cache_path),
                patch.object(refresh_agent, "_run_collection", return_value=(True, "ok")),
                patch.object(kv, "put_bytes", side_effect=fail_cache_only),
                self.assertRaisesRegex(RuntimeError, "cache write failed"),
            ):
                refresh_agent.process_once(kv)

        self.assertEqual(kv.values[refresh_agent.LISTINGS_KEY], previous_raw)
        self.assertNotIn(refresh_agent.META_KEY, kv.values)
        self.assertEqual(kv.values[refresh_agent.STATE_KEY]["status"], "failed")

    def test_nearby_cache_validation_rejects_bad_json_schema_and_size(self):
        valid_raw = json.dumps(nearby_cache_data()).encode("utf-8")
        self.assertEqual(
            refresh_agent._validate_nearby_cache(valid_raw),
            nearby_cache_data()["fetchedAt"],
        )

        with self.assertRaisesRegex(RuntimeError, "JSON"):
            refresh_agent._validate_nearby_cache(b"{")

        wrong_version = nearby_cache_data()
        wrong_version["schemaVersion"] = 999
        with self.assertRaisesRegex(RuntimeError, "버전"):
            refresh_agent._validate_nearby_cache(json.dumps(wrong_version).encode())

        bad_geometry = nearby_cache_data()
        bad_geometry["pois"][0]["geometry"] = [[[float("nan"), 126.82]]]
        with self.assertRaisesRegex(RuntimeError, "geometry"):
            refresh_agent._validate_nearby_cache(json.dumps(bad_geometry).encode())

        with (
            patch.object(refresh_agent, "MAX_NEARBY_CACHE_BYTES", 10),
            self.assertRaisesRegex(RuntimeError, "크기"),
        ):
            refresh_agent._validate_nearby_cache(valid_raw)

    def test_nearby_cache_ttl_is_24_hours(self):
        config = json.loads(
            (refresh_agent.COLLECTOR_DIR / "config.json").read_text(encoding="utf-8")
        )
        self.assertEqual(config["nearbyFacilities"]["cacheTtlHours"], 24)

    def test_invalid_listing_schema_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "스키마"):
            refresh_agent._validate_listings(b'{"updatedAt":"not-a-date"}')

    def test_upload_rejects_missing_or_nonzero_premium_audit(self):
        missing = listing_data()
        missing["stats"].pop("premiumAudit")
        with self.assertRaisesRegex(RuntimeError, "권리금 감사"):
            refresh_agent._validate_listings(json.dumps(missing).encode())

        unsafe = listing_data()
        unsafe["stats"]["premiumAudit"]["totalViolations"] = 1
        with self.assertRaisesRegex(RuntimeError, "권리금 감사"):
            refresh_agent._validate_listings(json.dumps(unsafe).encode())

    def test_legacy_snapshot_is_allowed_only_as_previous_seed(self):
        legacy = listing_data()
        legacy["stats"].pop("premiumAudit")
        legacy["listings"] = [{"id": "naver:1", "source": "naver"}]
        raw = json.dumps(legacy).encode()
        self.assertEqual(
            refresh_agent._validate_listings(raw, require_strict_premium=False),
            legacy["updatedAt"],
        )
        with self.assertRaisesRegex(RuntimeError, "권리금 감사|조건 미충족"):
            refresh_agent._validate_listings(raw)

    def test_upload_rejects_malformed_merged_ids_and_false_checks(self):
        malformed_ids = listing_data()
        malformed_ids["listings"][0]["mergedListingIds"] = "daangn:2970853"
        with self.assertRaisesRegex(RuntimeError, "잘못된 ID"):
            refresh_agent._validate_listings(json.dumps(malformed_ids).encode())

        false_check = listing_data()
        false_check["listings"][0]["checks"]["deposit"] = False
        with self.assertRaisesRegex(RuntimeError, "조건 미충족"):
            refresh_agent._validate_listings(json.dumps(false_check).encode())

        mismatched_id = listing_data()
        mismatched_id["listings"][0]["mergedListingIds"] = ["naver:2"]
        with self.assertRaisesRegex(RuntimeError, "잘못된 ID"):
            refresh_agent._validate_listings(json.dumps(mismatched_id).encode())

    def test_upload_recalculates_prices_and_rejects_criteria_tampering(self):
        for deposit in (100, 499, 1001):
            with self.subTest(deposit=deposit):
                unsafe = listing_data()
                unsafe["listings"][0]["deposit"] = deposit
                unsafe["listings"][0]["rent"] = 60
                unsafe["listings"][0]["floor"] = 1
                with self.assertRaisesRegex(RuntimeError, "조건 미충족"):
                    refresh_agent._validate_listings(json.dumps(unsafe).encode())

        tampered = listing_data()
        tampered["criteria"]["depositMin"] = 0
        with self.assertRaisesRegex(RuntimeError, "운영 기준"):
            refresh_agent._validate_listings(json.dumps(tampered).encode())

    def test_upload_rejects_non_500m_or_missing_nearby_evidence(self):
        wrong_stats = listing_data()
        wrong_stats["stats"]["nearby"]["radiusM"] = 800
        with self.assertRaisesRegex(RuntimeError, "500m 운영 기준"):
            refresh_agent._validate_listings(json.dumps(wrong_stats).encode())

        outside = listing_data()
        outside["listings"][0]["nearbyFacilities"][0]["distanceM"] = 500.01
        with self.assertRaisesRegex(RuntimeError, "500m 생활권"):
            refresh_agent._validate_listings(json.dumps(outside).encode())

        missing = listing_data()
        missing["listings"][0]["nearbyFacilities"] = []
        with self.assertRaisesRegex(RuntimeError, "500m 생활권"):
            refresh_agent._validate_listings(json.dumps(missing).encode())

    def test_upload_rejects_invalid_change_history(self):
        missing = listing_data()
        missing.pop("changeHistory")
        with self.assertRaisesRegex(RuntimeError, "변경 이력"):
            refresh_agent._validate_listings(json.dumps(missing).encode())

        mismatched_time = listing_data()
        mismatched_time["changeHistory"]["currentAt"] = "2026-08-01T00:00:00Z"
        with self.assertRaisesRegex(RuntimeError, "변경 이력"):
            refresh_agent._validate_listings(json.dumps(mismatched_time).encode())

        bad_count = listing_data()
        bad_count["changeHistory"]["baseline"] = False
        bad_count["changeHistory"]["counts"]["new"] = 1
        with self.assertRaisesRegex(RuntimeError, "카운터"):
            refresh_agent._validate_listings(json.dumps(bad_count).encode())

    def test_upload_rejects_is_new_and_first_seen_inconsistent_with_history(self):
        inconsistent = listing_data()
        inconsistent["listings"][0]["firstSeen"] = "not-a-date"
        inconsistent["listings"][0]["isNew"] = "yes"
        inconsistent["stats"]["new"] = 999

        with self.assertRaisesRegex(RuntimeError, "신규|firstSeen|isNew"):
            refresh_agent._validate_listings(json.dumps(inconsistent).encode())

    def test_upload_rejects_listing_ids_shared_by_multiple_cards(self):
        duplicated = listing_data()
        second = json.loads(json.dumps(duplicated["listings"][0]))
        second["id"] = "daangn:2"
        second["source"] = "daangn"
        second["mergedListingIds"] = ["daangn:2", "naver:1"]
        duplicated["listings"].append(second)
        duplicated["stats"]["nearby"]["kept"] = 2

        with self.assertRaisesRegex(RuntimeError, "중복|ID"):
            refresh_agent._validate_listings(json.dumps(duplicated).encode())

    def test_upload_rejects_false_change_history_truncation(self):
        not_truncated = listing_data()
        not_truncated["changeHistory"]["truncated"] = True

        with self.assertRaisesRegex(RuntimeError, "잘린|truncated|변경 이력"):
            refresh_agent._validate_listings(json.dumps(not_truncated).encode())


if __name__ == "__main__":
    unittest.main()
