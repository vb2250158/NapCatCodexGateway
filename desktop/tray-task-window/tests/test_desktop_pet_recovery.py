from __future__ import annotations

import os
import threading
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMenu

from rabiroute_tray.desktop_pet_client import DesktopPetRosterClient
from rabiroute_tray.desktop_pet_manager import DesktopPetManager
from rabiroute_tray.qt_async import wait_for_qt_tasks


class DesktopPetRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.calls = 0
        self.should_fail = True
        self.empty = False
        self.worker_threads = []
        self.menu = QMenu()
        self.events = patch("rabiroute_tray.desktop_pet_manager.DesktopPetEventStream").start()
        self.controllers = patch("rabiroute_tray.desktop_pet_manager.DesktopPetController").start()
        self.controllers.side_effect = self.make_controller
        patch.object(DesktopPetRosterClient, "_get_json", self.get_json).start()
        self.manager = DesktopPetManager("http://localhost:1", self.menu, lambda _: None)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.manager.close()
        wait_for_qt_tasks()
        self.app.processEvents()
        patch.stopall()
        self.menu.close()

    def make_controller(self, *args, **kwargs):
        controller = MagicMock()
        controller.persona_name = kwargs["persona_name"]
        return controller

    def get_json(self, path):
        self.worker_threads.append(threading.get_ident())
        if path == "/api/desktop/settings":
            self.calls += 1
            if self.should_fail:
                raise TimeoutError("fixture timeout")
            return {"data": {"pets": {} if self.empty else {"YeYu": {"enabled": True, "packId": "fixture"}}}}
        return {"personas": [{"personaId": "YeYu", "name": "夜雨"}]}

    def until(self, predicate, timeout=4000):
        for _ in range(timeout // 10):
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(10)
        self.fail_test("condition not reached")

    def fail_test(self, message):
        self.assertTrue(False, message)

    def texts(self):
        return [action.text() for action in self.menu.actions()]

    def test_real_async_failure_then_success_and_distinct_loading_error(self):
        self.assertIn("正在加载虚拟形象…", self.texts())
        self.until(lambda: any("加载失败" in text for text in self.texts()))
        self.assertNotIn("没有启用的虚拟形象", self.texts())
        self.should_fail = False
        self.until(lambda: "YeYu" in self.manager.controllers)
        self.assertNotIn(threading.get_ident(), self.worker_threads)
        self.assertFalse(self.manager._retry_timer.isActive())

    def test_manual_retry_and_empty_result(self):
        self.until(lambda: any("加载失败" in text for text in self.texts()))
        self.should_fail = False
        self.empty = True
        next(action for action in self.menu.actions() if action.text() == "重试加载").trigger()
        self.until(lambda: "没有启用的虚拟形象" in self.texts())
        self.assertFalse(self.manager._retry_timer.isActive())

    def test_transient_failure_preserves_existing_controller(self):
        self.should_fail = False
        self.manager.refresh()
        self.until(lambda: "YeYu" in self.manager.controllers)
        controller = self.manager.controllers["YeYu"]
        self.should_fail = True
        self.manager.refresh()
        self.until(lambda: any("加载失败" in text for text in self.texts()))
        self.assertIs(self.manager.controllers["YeYu"], controller)
        controller.close.assert_not_called()

    def test_close_cancels_pending_retry(self):
        self.until(lambda: any("加载失败" in text for text in self.texts()))
        self.assertTrue(self.manager._retry_timer.isActive())
        calls = self.calls
        self.manager.close()
        QTest.qWait(1200)
        self.assertFalse(self.manager._retry_timer.isActive())
        self.assertEqual(calls, self.calls)

    def test_controller_creation_failure_can_recover(self):
        self.should_fail = False
        self.controllers.side_effect = RuntimeError("fixture controller failure")
        self.manager.refresh()
        self.until(lambda: any("加载失败" in text for text in self.texts()))
        self.controllers.side_effect = self.make_controller
        self.until(lambda: "YeYu" in self.manager.controllers)


if __name__ == "__main__":
    unittest.main()
