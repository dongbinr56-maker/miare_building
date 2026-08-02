import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from playwright.sync_api import Error as PlaywrightError


COLLECTOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_DIR))

from collect import launch_naver_browser


class BrowserBackendTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_local_browser_is_the_default(self):
        playwright = MagicMock()
        browser = playwright.chromium.launch.return_value
        context = browser.new_context.return_value
        page = context.new_page.return_value

        result = launch_naver_browser(playwright)

        self.assertEqual(result, (browser, context, page))
        playwright.chromium.launch.assert_called_once()
        playwright.chromium.connect_over_cdp.assert_not_called()

    @patch.dict(
        os.environ,
        {
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
            "CLOUDFLARE_BROWSER_TOKEN": "browser-secret",
        },
        clear=True,
    )
    def test_cloudflare_credentials_select_remote_cdp(self):
        playwright = MagicMock()
        browser = playwright.chromium.connect_over_cdp.return_value
        context = browser.new_context.return_value
        page = context.new_page.return_value

        result = launch_naver_browser(playwright)

        self.assertEqual(result, (browser, context, page))
        args, kwargs = playwright.chromium.connect_over_cdp.call_args
        self.assertIn("/browser-rendering/devtools/browser", args[0])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer browser-secret")
        browser.new_context.assert_called_once_with(
            user_agent=unittest.mock.ANY,
            locale="ko-KR",
            viewport={"width": 1400, "height": 900},
        )
        context.new_page.assert_called_once_with()
        playwright.chromium.launch.assert_not_called()

    @patch.dict(
        os.environ,
        {"CLOUDFLARE_ACCOUNT_ID": "a" * 32},
        clear=True,
    )
    def test_kv_account_id_alone_still_uses_local_browser(self):
        playwright = MagicMock()
        browser = playwright.chromium.launch.return_value
        context = browser.new_context.return_value

        result = launch_naver_browser(playwright)

        self.assertEqual(result[0], browser)
        playwright.chromium.launch.assert_called_once()
        playwright.chromium.connect_over_cdp.assert_not_called()

    @patch.dict(
        os.environ,
        {"CLOUDFLARE_BROWSER_TOKEN": "browser-secret"},
        clear=True,
    )
    def test_browser_token_without_account_id_is_rejected(self):
        with self.assertRaises(RuntimeError):
            launch_naver_browser(MagicMock())

    @patch.dict(
        os.environ,
        {
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
            "CLOUDFLARE_BROWSER_TOKEN": "browser-secret",
        },
        clear=True,
    )
    @patch("collect.time.sleep")
    def test_cloudflare_rate_limit_is_retried(self, sleep):
        playwright = MagicMock()
        browser = MagicMock()
        playwright.chromium.connect_over_cdp.side_effect = [
            PlaywrightError("429 Too Many Requests: Rate limit exceeded"),
            browser,
        ]

        result = launch_naver_browser(playwright)

        self.assertEqual(result[0], browser)
        self.assertEqual(playwright.chromium.connect_over_cdp.call_count, 2)
        sleep.assert_called_once_with(5)

    @patch.dict(
        os.environ,
        {
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
            "CLOUDFLARE_BROWSER_TOKEN": "browser-secret",
        },
        clear=True,
    )
    @patch("collect.time.sleep")
    def test_cloudflare_auth_error_is_not_retried(self, sleep):
        playwright = MagicMock()
        playwright.chromium.connect_over_cdp.side_effect = PlaywrightError(
            "401 Unauthorized"
        )

        with self.assertRaises(PlaywrightError):
            launch_naver_browser(playwright)

        playwright.chromium.connect_over_cdp.assert_called_once()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
