import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


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
    def test_partial_cloudflare_credentials_are_rejected(self):
        with self.assertRaises(RuntimeError):
            launch_naver_browser(MagicMock())


if __name__ == "__main__":
    unittest.main()
