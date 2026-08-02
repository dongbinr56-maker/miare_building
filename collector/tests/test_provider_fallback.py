import sys
import unittest
from pathlib import Path


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from collect import previous_regions, retained_naver_listings


class ProviderFallbackTests(unittest.TestCase):
    def test_previous_regions_accept_only_unique_ten_digit_regions(self):
        regions = previous_regions({
            "regions": [
                {"name": "신가동", "cortarNo": "2920011900", "count": 3},
                {"name": "중복", "cortarNo": "2920011900", "count": 1},
                {"name": "손상", "cortarNo": "bad", "count": 1},
            ],
        })
        self.assertEqual(regions, [
            {"name": "신가동", "cortarNo": "2920011900", "count": 0},
        ])

    def test_cross_listed_card_is_reduced_to_naver_identity(self):
        retained = retained_naver_listings({
            "listings": [{
                "id": "daangn:20",
                "source": "daangn",
                "sources": ["daangn", "naver"],
                "mergedListingIds": ["daangn:20", "naver:10"],
                "link": "https://realty.daangn.com/articles/20",
                "altLinks": [{
                    "source": "naver",
                    "link": "https://new.land.naver.com/offices?articleNo=10",
                }],
                "deposit": 500,
                "rent": 50,
            }],
        })
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0]["id"], "naver:10")
        self.assertEqual(retained[0]["source"], "naver")
        self.assertEqual(retained[0]["sources"], ["naver"])
        self.assertEqual(retained[0]["mergedListingIds"], ["naver:10"])
        self.assertIn("articleNo=10", retained[0]["link"])


if __name__ == "__main__":
    unittest.main()
