# -*- coding: utf-8 -*-
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from collect import REGION_LIST_URL, discover_child_regions
from daangn import collect_daangn


class RegionDiscoveryTest(unittest.TestCase):
    def test_discovers_every_sec_region_and_preserves_api_order(self):
        session = Mock()
        session.get.return_value = {
            "regionList": [
                {
                    "cortarType": "dvsn",
                    "cortarName": "광산구",
                    "cortarNo": "1233000000",
                },
                {
                    "cortarType": "sec",
                    "cortarName": "송정동",
                    "cortarNo": "1233010100",
                    "centerLat": 35.14,
                    "centerLon": 126.79,
                },
                {
                    "cortarType": "sec",
                    "cortarName": "신가동",
                    "cortarNo": "1233011900",
                    "centerLat": 35.18,
                    "centerLon": 126.83,
                },
                {  # 중복 코드는 한 번만 수집한다.
                    "cortarType": "sec",
                    "cortarName": "신가동 중복",
                    "cortarNo": "1233011900",
                },
                {"cortarType": "sec", "cortarName": "코드 없음"},
            ]
        }

        regions = discover_child_regions(session, "1233000000")

        session.get.assert_called_once_with(
            REGION_LIST_URL.format(cortar_no="1233000000")
        )
        self.assertEqual(
            regions,
            [
                {
                    "name": "송정동",
                    "cortarNo": "1233010100",
                    "centerLat": 35.14,
                    "centerLon": 126.79,
                },
                {
                    "name": "신가동",
                    "cortarNo": "1233011900",
                    "centerLat": 35.18,
                    "centerLon": 126.83,
                },
            ],
        )

    def test_invalid_or_failed_region_response_never_falls_back_to_four_dongs(self):
        for response in (None, {}, {"regionList": None}, {"regionList": []}):
            with self.subTest(response=response):
                session = Mock()
                session.get.return_value = response
                self.assertEqual(discover_child_regions(session, "1233000000"), [])

    @patch("daangn.time.sleep")
    @patch("daangn._enrich_locations")
    @patch("daangn._fetch_articles", return_value=[])
    @patch("daangn.resolve_region_id", side_effect=[101, 102])
    @patch("daangn._session")
    def test_daangn_uses_the_same_discovered_region_list(
        self,
        session_factory,
        resolve_region_id,
        _fetch_articles,
        _enrich_locations,
        _sleep,
    ):
        session = session_factory.return_value
        regions = [
            {"name": "송정동", "cortarNo": "1233010100"},
            {"name": "신가동", "cortarNo": "1233011900"},
        ]

        listings = collect_daangn(
            {"regionSearchPrefix": "광산구", "daangn": {}},
            {},
            regions,
            lambda _msg: None,
        )

        self.assertEqual(listings, [])
        self.assertEqual(
            resolve_region_id.call_args_list,
            [call(session, "광산구", "송정동"), call(session, "광산구", "신가동")],
        )
        self.assertEqual(_fetch_articles.call_count, 2)
        _enrich_locations.assert_called_once()


if __name__ == "__main__":
    unittest.main()
