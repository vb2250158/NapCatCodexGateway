from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication
from rabiroute_tray.system_screenshot import WindowsGlobalHotkey


class ExitingHotkey(WindowsGlobalHotkey):
    def __init__(self):
        super().__init__(1, "hotkey-recovery-test")
        self.attempts = 0

    def _run(self):
        self.attempts += 1


class HotkeyRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_same_shortcut_restarts_exited_registration_thread(self):
        hotkey = ExitingHotkey()
        with patch("rabiroute_tray.system_screenshot.sys.platform", "win32"):
            hotkey.configure(True, "F1")
            hotkey._thread.join(1)
            hotkey.configure(True, "F1")
            hotkey._thread.join(1)
            self.assertEqual(hotkey.attempts, 2)
            hotkey.stop()

    def test_failed_registration_retries_bounded_and_reports_failure(self):
        hotkey = WindowsGlobalHotkey(1, "test")
        hotkey._hotkey = (0, 112)
        hotkey._RETRY_DELAYS_SECONDS = (0, 0)
        messages = []
        hotkey.registration_failed.connect(messages.append)
        api = MagicMock()
        api.user32.RegisterHotKey.return_value = 0
        with patch("rabiroute_tray.system_screenshot.ctypes.windll", api):
            hotkey._run()
        self.assertEqual(api.user32.RegisterHotKey.call_count, 3)
        self.assertEqual(len(messages), 1)
        with patch("rabiroute_tray.system_screenshot.ctypes.windll", api):
            hotkey._run()
        self.assertEqual(len(messages), 1)
        api.user32.UnregisterHotKey.assert_not_called()
        self.assertEqual(hotkey._thread_id, 0)

    def test_transient_registration_failure_recovers_and_unregisters(self):
        hotkey = WindowsGlobalHotkey(1, "test")
        hotkey._hotkey = (0, 112)
        hotkey._RETRY_DELAYS_SECONDS = (0,)
        api = MagicMock()
        api.user32.RegisterHotKey.side_effect = [0, 1]
        api.user32.GetMessageW.return_value = 0
        with patch("rabiroute_tray.system_screenshot.ctypes.windll", api):
            hotkey._run()
        self.assertEqual(api.user32.RegisterHotKey.call_count, 2)
        api.user32.UnregisterHotKey.assert_called_once_with(None, 1)
        self.assertEqual(api.mock_calls[0][0], "user32.PeekMessageW")
        self.assertEqual(hotkey._thread_id, 0)

    def test_stop_before_message_queue_creation_does_not_register(self):
        hotkey = WindowsGlobalHotkey(1, "test")
        api = MagicMock()
        api.user32.PeekMessageW.side_effect = lambda *args: hotkey._stop_requested.set()
        with patch("rabiroute_tray.system_screenshot.ctypes.windll", api):
            hotkey._run()
        api.user32.RegisterHotKey.assert_not_called()
        api.user32.GetMessageW.assert_not_called()

    def test_stop_timeout_retains_live_owner_and_cancellation(self):
        hotkey = WindowsGlobalHotkey(1, "test")
        thread = MagicMock()
        thread.is_alive.return_value = True
        hotkey._thread = thread
        hotkey.stop()
        self.assertIs(hotkey._thread, thread)
        self.assertTrue(hotkey._stop_requested.is_set())
        with patch("rabiroute_tray.system_screenshot.threading.Thread") as factory:
            hotkey._hotkey = (0, 112)
            hotkey.start()
            factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
