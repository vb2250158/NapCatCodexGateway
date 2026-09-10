from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, TRAY_ROOT)

from PySide6.QtCore import QEvent, QObject, QPoint, QPointF, QRect, QSize, Qt, Signal  # noqa: E402
from PySide6.QtGui import QColor, QImage, QKeyEvent, QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from rabiroute_tray.manager_client import DesktopSettings  # noqa: E402
from rabiroute_tray.plugin_catalog import DesktopPluginHotkey  # noqa: E402
from rabiroute_tray.system_selection import SelectionDeliveryTarget  # noqa: E402
from rabiroute_tray.system_screenshot import (  # noqa: E402
    ScreenshotAnnotation,
    ScreenshotAnnotationTool,
    ScreenshotCaptureOverlay,
    ScreenshotComposer,
    ScreenshotWindowCandidate,
    PinnedScreenshotStore,
    ScreenshotHistory,
    ScreenCaptureLayout,
    ScreenCaptureSegment,
    ScreenshotRegionStore,
    ScreenshotSettings,
    SystemScreenshotController,
    _next_plugin_hotkey_id,
    parse_hotkey,
    save_screenshot_image,
    screenshot_history,
    screenshot_window_candidate_at,
)


def _plugin_hotkey(command_id: str, handler_id: str, binding: str) -> DesktopPluginHotkey:
    return DesktopPluginHotkey(
        plugin_id="io.rabiroute.manager.desktop",
        instance_id="manager:desktop",
        contribution_id=f"{command_id}-hotkey",
        command_id=command_id,
        handler_id=handler_id,
        default_binding=binding,
        label=command_id,
        order=10,
    )


class _FakeScreen:
    def __init__(self, geometry: QRect, device_pixel_ratio: float, name: str = "") -> None:
        self._geometry = geometry
        self._device_pixel_ratio = device_pixel_ratio
        self._name = name

    def geometry(self) -> QRect:
        return QRect(self._geometry)

    def devicePixelRatio(self) -> float:
        return self._device_pixel_ratio

    def name(self) -> str:
        return self._name


class SystemScreenshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_plugin_hotkey_id_capacity_fails_closed(self) -> None:
        self.assertEqual(_next_plugin_hotkey_id(set(range(0x5300, 0x53FF))), 0x53FF)
        self.assertIsNone(_next_plugin_hotkey_id(set(range(0x5300, 0x5400))))

    def test_hotkey_parser_accepts_common_windows_shortcuts(self) -> None:
        modifiers, key = parse_hotkey("Ctrl + Shift + S") or (0, 0)
        self.assertEqual(modifiers & 0x0002, 0x0002)
        self.assertEqual(modifiers & 0x0004, 0x0004)
        self.assertEqual(key, ord("S"))

    def test_hotkey_parser_accepts_function_key(self) -> None:
        modifiers, key = parse_hotkey("Alt+F8") or (0, 0)
        self.assertEqual(modifiers & 0x0001, 0x0001)
        self.assertEqual(key, 0x77)

    def test_hotkey_parser_accepts_unmodified_function_key(self) -> None:
        modifiers, key = parse_hotkey("F1") or (0, 0)
        self.assertEqual(modifiers & 0x4000, 0x4000)
        self.assertEqual(key, 0x70)

    def test_older_segmented_history_remains_readable(self) -> None:
        layout = ScreenCaptureLayout.from_payload({
            "virtual": [-1024, -2160, 3585, 3600],
            "image": [4865, 3600],
            "segments": [{"logical": [1025, 0, 2560, 1440], "source": [1025, 0, 3840, 2160]}],
        })
        self.assertIsNotNone(layout)
        self.assertIsNone(layout.native_geometry)
        self.assertEqual(layout.source_rect_for_logical(QRect(1035, 10, 20, 20)), QRect(1040, 15, 30, 30))

    def test_overlay_selection_uses_native_pixels_for_high_dpi_screen(self) -> None:
        layout = ScreenCaptureLayout(
            QRect(0, 0, 300, 100),
            QSize(500, 100),
            (
                # The right half is displayed at 2x native pixels.
                ScreenCaptureSegment(QRect(0, 0, 100, 100), QRect(0, 0, 100, 100)),
                ScreenCaptureSegment(QRect(100, 0, 200, 100), QRect(100, 0, 400, 100)),
            ),
        )
        image = QImage(500, 100, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)
        overlay = ScreenshotCaptureOverlay(
            ScreenshotHistory(()),
            QRect(0, 0, 300, 100),
            capture_layout=layout,
        )
        overlay.set_capture_image(image)
        overlay._selection = QRect(110, 10, 20, 20)

        self.assertEqual(overlay._image_selection().size(), QSize(40, 20))
        overlay.close()


    def test_hotkey_parser_rejects_invalid_unmodified_or_incomplete_shortcuts(self) -> None:
        self.assertIsNone(parse_hotkey(""))
        self.assertIsNone(parse_hotkey("S"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift+S+T"))

    def test_history_moves_from_current_screen_to_previous_screen(self) -> None:
        current = Path("C:/tmp/current-screen.png")
        previous = Path("C:/tmp/previous-screen.png")
        history = ScreenshotHistory((current, previous))

        self.assertEqual(history.current, current)
        self.assertEqual(history.move(1).current, previous)
        self.assertEqual(history.move(1).move(1).current, previous)
        self.assertEqual(history.move(-1).current, current)

    def test_window_candidate_at_prefers_the_frontmost_matching_window(self) -> None:
        front = ScreenshotWindowCandidate(QRect(10, 8, 40, 30))
        behind = ScreenshotWindowCandidate(QRect(0, 0, 80, 50))

        self.assertEqual(screenshot_window_candidate_at((front, behind), QPoint(15, 12)), front)
        self.assertIsNone(screenshot_window_candidate_at((front, behind), QPoint(100, 80)))

    def test_saved_screenshots_are_ordered_with_current_screen_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(8, 6, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.red)
            previous = save_screenshot_image(root, image)
            time.sleep(0.002)
            current = save_screenshot_image(root, image)

            history = screenshot_history(current)

            self.assertEqual(history.current, current)
            self.assertEqual(history.move(1).current, previous)

    def test_overlay_copies_the_selected_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[QImage] = []
            overlay.copy_requested.connect(emitted.append)

            overlay._copy()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0].size().width(), 30)
            self.assertEqual(emitted[0].size().height(), 20)
            overlay.close()

    def test_pending_capture_overlay_is_transparent(self) -> None:
        overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 100, 60))

        self.assertTrue(overlay.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
        overlay.close()

    def test_selection_dims_only_the_area_outside_the_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(40, 40, 30, 20)
            overlay._color_tip.hide()
            rendered = QImage(100, 60, QImage.Format.Format_ARGB32)
            rendered.fill(Qt.GlobalColor.black)

            overlay.render(rendered)

            self.assertEqual(rendered.pixelColor(55, 55), QColor(Qt.GlobalColor.white))
            self.assertLess(rendered.pixelColor(90, 55).red(), 200)
            overlay.close()

    def test_hovered_window_candidate_dims_only_the_area_outside_the_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            candidate_rect = QRect(40, 40, 30, 20)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(candidate_rect.topLeft()), candidate_rect.size()))
            overlay.set_window_candidates((candidate,))
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(55, 55), QPointF(55, 55), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            overlay._color_tip.hide()
            rendered = QImage(100, 60, QImage.Format.Format_ARGB32)
            rendered.fill(Qt.GlobalColor.black)

            overlay.render(rendered)

            self.assertEqual(rendered.pixelColor(55, 55), QColor(Qt.GlobalColor.white))
            self.assertLess(rendered.pixelColor(90, 55).red(), 200)
            overlay.close()

    def test_right_click_cancels_the_open_capture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            destroyed: list[bool] = []
            overlay.destroyed.connect(lambda *_: destroyed.append(True))
            overlay.show()
            QApplication.processEvents()

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(20, 18), QPointF(20, 18), Qt.MouseButton.RightButton, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.processEvents()

            self.assertEqual(destroyed, [True])

    def test_right_click_on_the_capture_toolbar_cancels_the_open_capture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            overlay._complete_selection()
            destroyed: list[bool] = []
            overlay.destroyed.connect(lambda *_: destroyed.append(True))
            overlay.show()
            QApplication.processEvents()

            QApplication.sendEvent(
                overlay._copy_button,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(5, 5), QPointF(5, 5), Qt.MouseButton.RightButton, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.processEvents()

            self.assertEqual(destroyed, [True])

    def test_dragging_only_creates_a_selection_until_it_is_confirmed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            overlay.copy_requested.connect(copied.append)

            overlay._complete_selection()
            self.assertEqual(copied, [])

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Return, Qt.KeyboardModifier.NoModifier))
            self.assertEqual(len(copied), 1)

    def test_f2_confirms_and_sends_the_selected_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            sent: list[QImage] = []
            overlay.copy_requested.connect(copied.append)
            overlay.send_requested.connect(sent.append)

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_F2, Qt.KeyboardModifier.NoModifier))

            self.assertEqual(len(copied), 1)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0].size(), QSize(30, 20))

    def test_selection_action_waits_for_the_capture_file_then_crops(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[QImage] = []
            overlay.copy_requested.connect(emitted.append)

            overlay._copy()
            self.assertEqual(emitted, [])
            self.assertEqual(overlay._pending_action, "copy")

            overlay.set_capture_image(image)
            capture = save_screenshot_image(root, image, "capture")
            overlay.complete_capture(screenshot_history(capture), capture)

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0].size(), QSize(30, 20))
            self.assertEqual(list((root / ".rabiroute-message-images").glob("capture-*.png")), [])
            self.assertEqual(len(list((root / ".rabiroute-message-images").glob("screenshot-*.png"))), 1)
            overlay.close()

    def test_capture_freezes_pixels_before_overlay_and_background_work(self) -> None:
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda _title, _message, _is_error: None,
        )
        controller._settings = ScreenshotSettings(enabled=True)
        image = QImage(200, 100, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)

        def capture() -> QImage:
            self.assertIsNone(controller._capture_overlay)
            start_task.assert_not_called()
            return image

        with (
            patch("rabiroute_tray.system_screenshot.start_qt_task", return_value=None) as start_task,
            patch("rabiroute_tray.system_screenshot.capture_desktop_image", side_effect=capture) as grab,
        ):
            controller._capture_requested()
            self.assertEqual(controller._capture_overlay._image.pixelColor(0, 0), QColor(Qt.GlobalColor.blue))
            controller._capture_requested()
            grab.assert_called_once()

        self.assertIsNotNone(controller._capture_overlay)
        self.assertEqual(start_task.call_count, 2)
        controller.stop()

    def test_capture_failure_leaves_no_overlay_and_can_retry(self) -> None:
        notifications = []
        controller = SystemScreenshotController(
            None, Path(tempfile.gettempdir()), lambda: [],
            lambda *args: notifications.append(args),
        )
        controller._settings = ScreenshotSettings(enabled=True)
        image = QImage(200, 100, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)
        with (
            patch("rabiroute_tray.system_screenshot.start_qt_task", return_value=None) as start_task,
            patch("rabiroute_tray.system_screenshot.capture_desktop_image", side_effect=[RuntimeError("capture unavailable"), image]),
        ):
            controller._capture_requested()
            self.assertIsNone(controller._capture_overlay)
            start_task.assert_not_called()
            self.assertIn("capture unavailable", notifications[0][1])
            controller._capture_requested()
            self.assertIsNotNone(controller._capture_overlay)
        controller.stop()

    def test_captured_virtual_desktop_uses_one_native_canvas_in_one_overlay(self) -> None:
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda _title, _message, _is_error: None,
        )
        controller._settings = ScreenshotSettings(enabled=True)
        overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 200, 100))
        controller._capture_overlay = overlay
        image = QImage(250, 150, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)
        screens = (
            _FakeScreen(QRect(0, 0, 100, 100), 1.0, "Left"),
            _FakeScreen(QRect(100, 0, 100, 100), 1.5, "Right"),
        )

        with (
            patch("rabiroute_tray.system_screenshot.QApplication.screens", return_value=list(screens)),
            patch("rabiroute_tray.system_screenshot.windows_virtual_screen_origin", return_value=QPoint(0, 0)),
            patch("rabiroute_tray.system_screenshot.start_qt_task", return_value=None),
        ):
            controller._capture_image_ready(overlay, image)

        self.assertEqual(overlay.geometry(), QRect(0, 0, 200, 100))
        self.assertIsNotNone(overlay.capture_layout)
        assert overlay.capture_layout is not None
        self.assertEqual(overlay.capture_layout.segments, ())
        self.assertEqual(overlay.capture_layout.native_geometry, QRect(0, 0, 250, 150))
        self.assertEqual(overlay._source_rect(QRect(110, 10, 20, 20)), QRect(138, 15, 24, 30))
        controller.stop()

    def test_native_canvas_preserves_negative_origin_hover_crop_and_history(self) -> None:
        # Three physical monitors, including 200% and 150% displays to the left.
        native = QRect(-7680, -729, 10240, 2171)
        image = QImage(native.size(), QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)
        overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(-7680, -729, 5120, 1086))
        overlay.set_capture_image(image)
        layout = ScreenCaptureLayout(overlay.geometry(), image.size(), (), native)
        overlay.set_capture_layout(layout)
        self.assertEqual(ScreenCaptureLayout.from_payload(layout.to_payload()), layout)
        candidate = ScreenshotWindowCandidate(QRect(-3800, -600, 600, 400))
        selection = overlay._selection_from_window_candidate(candidate)
        overlay._window_candidates = (candidate,)
        overlay._update_window_hover(selection.center())
        self.assertEqual(overlay._hover_window_candidate, candidate)
        source = overlay._source_rect(selection)
        self.assertLessEqual(abs(source.x() - 3880), 1)
        self.assertLessEqual(abs(source.y() - 129), 1)
        self.assertLessEqual(abs(source.width() - 600), 1)
        self.assertLessEqual(abs(source.height() - 400), 1)
        self.assertEqual(overlay._source_rect(overlay.rect()), image.rect())
        overlay.close()

    def test_native_canvas_tracks_delayed_window_resize(self) -> None:
        image = QImage(1000, 600, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.blue)
        overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 500, 300))
        overlay.set_capture_image(image)
        overlay.set_capture_layout(ScreenCaptureLayout(overlay.geometry(), image.size(), (), QRect(-800, -50, 1000, 600)))
        overlay.show()
        overlay.resize(1000, 600)
        QApplication.processEvents()
        self.assertEqual(overlay.capture_layout.virtual_geometry.size(), overlay.size())
        self.assertEqual(overlay._source_rect(QRect(200, 100, 100, 80)), QRect(200, 100, 100, 80))
        overlay.close()

    def test_window_candidate_hover_uses_the_current_cursor_without_mouse_move(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            local_point = QPoint(15, 12)
            selection = QRect(10, 8, 50, 30)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(selection.topLeft()), selection.size()))

            with patch("rabiroute_tray.system_screenshot.QCursor.pos", return_value=overlay.mapToGlobal(local_point)):
                overlay.set_window_candidates((candidate,))

            self.assertEqual(overlay._pointer_position, local_point)
            self.assertEqual(overlay._hover_window_candidate, candidate)
            overlay.close()

    def test_hovered_window_candidate_is_focused_by_a_confirm_action_without_a_click(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            selection = QRect(10, 8, 50, 30)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(selection.topLeft()), selection.size()))
            copied: list[QImage] = []
            overlay.copy_requested.connect(copied.append)
            overlay.set_window_candidates((candidate,))

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            self.assertEqual(overlay._hover_window_candidate, candidate)
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Return, Qt.KeyboardModifier.NoModifier))

            self.assertEqual(len(copied), 1)
            self.assertEqual(copied[0].size(), QSize(50, 30))
            self.assertEqual(overlay._selection, selection)
            overlay.close()

    def test_color_follow_does_not_repaint_the_full_overlay_while_staying_on_one_candidate(self) -> None:
        class CountingOverlay(ScreenshotCaptureOverlay):
            def __init__(self, *args, **kwargs) -> None:
                self.update_calls = 0
                super().__init__(*args, **kwargs)

            def update(self, *args) -> None:
                self.update_calls += 1
                super().update(*args)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = CountingOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            candidate_rect = QRect(10, 8, 50, 30)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(candidate_rect.topLeft()), candidate_rect.size()))
            overlay.set_window_candidates((candidate,))
            overlay.update_calls = 0

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(25, 18), QPointF(25, 18), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(overlay.update_calls, 0)
            overlay.close()

    def test_hovered_window_click_selects_the_window_without_confirming_an_action(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            selection = QRect(10, 8, 50, 30)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(selection.topLeft()), selection.size()))
            copied: list[QImage] = []
            pinned: list[QImage] = []
            sent: list[QImage] = []
            overlay.copy_requested.connect(copied.append)
            overlay.pin_requested.connect(lambda image, _origin: pinned.append(image))
            overlay.send_requested.connect(sent.append)
            overlay.set_window_candidates((candidate,))

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            self.assertEqual(overlay._hover_window_candidate, candidate)
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonRelease, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(overlay._selection, selection)
            self.assertEqual(copied, [])
            self.assertEqual(pinned, [])
            self.assertEqual(sent, [])
            overlay.close()

    def test_dragging_after_a_window_candidate_click_returns_to_manual_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            candidate_selection = QRect(10, 8, 50, 30)
            candidate = ScreenshotWindowCandidate(QRect(overlay.mapToGlobal(candidate_selection.topLeft()), candidate_selection.size()))
            overlay.set_window_candidates((candidate,))
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(15, 12), QPointF(15, 12), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(70, 45), QPointF(70, 45), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonRelease, QPointF(70, 45), QPointF(70, 45), Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertFalse(overlay._candidate_click_pending)
            self.assertEqual(overlay._selection.topLeft(), QPoint(15, 12))
            self.assertNotEqual(overlay._selection, candidate_selection)
            overlay.close()

    def test_c_copies_the_current_color_without_entering_a_separate_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(QColor("#12ab34"))
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            copied: list[QImage] = []
            colors: list[str] = []
            overlay.copy_requested.connect(copied.append)
            overlay.color_copy_requested.connect(colors.append)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(20, 18), QPointF(20, 18), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )
            self.assertEqual(overlay._color_hex_label.text(), "#12AB34")
            self.assertTrue(overlay._color_tip.testAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents))
            self.assertEqual(overlay._color_tip.size(), QSize(126, 150))
            self.assertGreater(overlay._color_swatch.geometry().top(), overlay._color_magnifier.geometry().bottom())
            self.assertIn("#12AB34", overlay._color_swatch.styleSheet())
            magnifier = overlay._color_magnifier.pixmap().toImage()
            self.assertEqual(magnifier.size(), QSize(110, 110))
            self.assertEqual(magnifier.pixelColor(5, 5), QColor("#12ab34"))
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_C, Qt.KeyboardModifier.NoModifier))

            self.assertEqual(colors, ["#12AB34"])
            self.assertEqual(copied, [])
            self.assertTrue(overlay._selection.isEmpty())
            self.assertTrue(overlay.copy_current_color())
            overlay.close()

    def test_color_tip_is_an_independent_mouse_transparent_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(500, 400, QImage.Format.Format_ARGB32)
            image.fill(QColor("#12ab34"))
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(120, 80, 500, 400))
            cursor = QPoint(32, 380)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(cursor), QPointF(cursor), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            tip = overlay._color_tip
            self.assertIsNone(tip.parentWidget())
            self.assertTrue(tip.testAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents))
            self.assertTrue(tip.windowFlags() & Qt.WindowType.WindowTransparentForInput)
            self.assertLess(tip.geometry().bottom(), overlay.mapToGlobal(cursor).y())
            overlay.close()
            self.assertFalse(tip.isVisible())

    def test_color_tip_moves_above_the_cursor_near_the_bottom_edge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(500, 400, QImage.Format.Format_ARGB32)
            image.fill(QColor("#12ab34"))
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 500, 400))
            cursor = QPoint(32, 380)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(cursor), QPointF(cursor), Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertLess(overlay._color_tip.geometry().bottom(), cursor.y())
            overlay.close()

    def test_dragging_selection_repaints_only_the_changed_region(self) -> None:
        class TrackingOverlay(ScreenshotCaptureOverlay):
            def __init__(self, *args, **kwargs) -> None:
                self.update_calls: list[tuple[object, ...]] = []
                super().__init__(*args, **kwargs)

            def update(self, *args) -> None:
                self.update_calls.append(args)
                super().update(*args)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(1000, 600, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = TrackingOverlay(ScreenshotHistory((path,)), QRect(0, 0, 1000, 600))

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(100, 100), QPointF(100, 100), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            overlay.update_calls.clear()
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(420, 280), QPointF(420, 280), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(len(overlay.update_calls), 1)
            dirty = overlay.update_calls[0][0]
            self.assertIsInstance(dirty, QRect)
            self.assertNotEqual(dirty, overlay.rect())
            self.assertTrue(dirty.contains(overlay._selection))
            overlay.close()

    def test_moving_selection_repaints_only_the_old_and_new_selection_area(self) -> None:
        class TrackingOverlay(ScreenshotCaptureOverlay):
            def __init__(self, *args, **kwargs) -> None:
                self.update_calls: list[tuple[object, ...]] = []
                super().__init__(*args, **kwargs)

            def update(self, *args) -> None:
                self.update_calls.append(args)
                super().update(*args)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(1000, 600, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = TrackingOverlay(ScreenshotHistory((path,)), QRect(0, 0, 1000, 600))
            original = QRect(100, 100, 220, 140)
            overlay._selection = QRect(original)
            overlay._complete_selection()
            overlay.update_calls.clear()

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(130, 120), QPointF(130, 120), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(230, 190), QPointF(230, 190), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(len(overlay.update_calls), 1)
            dirty = overlay.update_calls[0][0]
            self.assertIsInstance(dirty, QRect)
            self.assertNotEqual(dirty, overlay.rect())
            self.assertTrue(dirty.contains(original))
            self.assertTrue(dirty.contains(overlay._selection))
            self.assertTrue(overlay._toolbar.isHidden())
            overlay.close()

    def test_selection_edge_handle_resizes_the_existing_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(39, 18), QPointF(39, 18), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(65, 18), QPointF(65, 18), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonRelease, QPointF(65, 18), QPointF(65, 18), Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(overlay._selection, QRect(10, 8, 56, 20))
            overlay.close()

    def test_rectangle_arrow_and_text_annotations_are_baked_into_the_selected_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(0, 0, 100, 60)
            overlay._annotations = [
                ScreenshotAnnotation(ScreenshotAnnotationTool.RECTANGLE, QPoint(10, 10), QPoint(30, 25), "#ef4444", 3),
                ScreenshotAnnotation(ScreenshotAnnotationTool.ARROW, QPoint(40, 12), QPoint(70, 28), "#3b82f6", 3),
                ScreenshotAnnotation(ScreenshotAnnotationTool.TEXT, QPoint(12, 34), QPoint(12, 34), "#22c55e", 3, "注", 18),
            ]

            rendered = overlay._image_selection()

            self.assertEqual(rendered.size(), QSize(100, 60))
            self.assertGreater(rendered.pixelColor(10, 10).red(), 180)
            self.assertGreater(rendered.pixelColor(55, 20).blue(), 100)
            self.assertTrue(any(rendered.pixelColor(x, y) != QColor(Qt.GlobalColor.white) for y in range(34, 58) for x in range(12, 80)))
            overlay.close()

    def test_annotation_tools_add_and_undo_a_rectangle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 80, 40)
            overlay._set_annotation_tool(ScreenshotAnnotationTool.RECTANGLE)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(22, 18), QPointF(22, 18), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseMove, QPointF(60, 34), QPointF(60, 34), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonRelease, QPointF(60, 34), QPointF(60, 34), Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertEqual(len(overlay._annotations), 1)
            self.assertEqual(overlay._annotations[0].tool, ScreenshotAnnotationTool.RECTANGLE)
            overlay._undo_annotation()
            self.assertEqual(overlay._annotations, [])
            overlay.close()

    def test_screenshot_toolbar_uses_icons_and_exposes_the_selected_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 200, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 200))

            for button in overlay._annotation_tool_buttons.values():
                self.assertFalse(button.icon().isNull())
                self.assertTrue(button.accessibleName())
            self.assertFalse(overlay._copy_button.icon().isNull())
            self.assertFalse(overlay._pin_button.icon().isNull())
            self.assertFalse(overlay._send_button.icon().isNull())
            self.assertTrue(overlay._selection_tool_button.isChecked())
            self.assertEqual(overlay._selection_tool_button.accessibleName(), "调整选区")

            overlay._set_annotation_tool(ScreenshotAnnotationTool.ARROW)
            self.assertFalse(overlay._selection_tool_button.isChecked())
            self.assertTrue(overlay._arrow_tool_button.isChecked())

            selected_color = "#3B82F6"
            overlay._set_annotation_color(selected_color)
            self.assertEqual(overlay._annotation_color_buttons[selected_color].property("selected"), True)
            self.assertEqual(overlay._annotation_color_buttons["#EF4444"].property("selected"), False)
            self.assertEqual(overlay._undo_shortcut.key().toString(), "Ctrl+Z")
            self.assertIs(overlay._text_smaller_button.parentWidget(), overlay._text_properties_bar)
            self.assertIs(overlay._text_larger_button.parentWidget(), overlay._text_properties_bar)
            self.assertIs(overlay._text_font_size_label.parentWidget(), overlay._text_properties_bar)
            self.assertNotIn(overlay._text_smaller_button, overlay._toolbar.findChildren(type(overlay._text_smaller_button)))
            self.assertNotIn(overlay._text_larger_button, overlay._toolbar.findChildren(type(overlay._text_larger_button)))
            overlay.show()
            QApplication.processEvents()
            overlay._selection = QRect(10, 8, 80, 40)
            overlay._complete_selection()
            toolbar_width = overlay._toolbar.width()
            overlay._set_annotation_tool(ScreenshotAnnotationTool.TEXT)
            self.assertTrue(overlay._text_properties_bar.isVisible())
            self.assertGreaterEqual(overlay._text_properties_bar.y(), overlay._toolbar.y() + overlay._toolbar.height())
            self.assertEqual(overlay._toolbar.width(), toolbar_width)
            overlay._set_annotation_tool(ScreenshotAnnotationTool.ARROW)
            self.assertFalse(overlay._text_properties_bar.isVisible())
            overlay._annotations = [ScreenshotAnnotation(ScreenshotAnnotationTool.RECTANGLE, QPoint(10, 10), QPoint(20, 20))]
            overlay._undo_shortcut.activated.emit()
            self.assertEqual(overlay._annotations, [])
            overlay.close()

    def test_screenshot_toolbar_is_right_aligned_to_the_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(900, 300, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 900, 300))
            overlay.show()
            QApplication.processEvents()

            overlay._selection = QRect(120, 60, 700, 120)
            overlay._complete_selection()

            self.assertEqual(
                overlay._toolbar.x() + overlay._toolbar.width(),
                overlay._selection.right() + 1,
            )
            overlay.close()

    def test_text_annotation_commits_the_editor_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 80, 40)
            overlay._set_annotation_tool(ScreenshotAnnotationTool.TEXT)
            overlay._start_text_annotation(QPoint(20, 20))
            self.assertIsNotNone(overlay._text_editor)
            self.assertIn("background: transparent", overlay._text_editor.styleSheet())  # type: ignore[union-attr]
            self.assertIn("border: none", overlay._text_editor.styleSheet())  # type: ignore[union-attr]
            self.assertEqual(overlay._text_editor.placeholderText(), "")  # type: ignore[union-attr]
            overlay._text_editor.setPlainText("重点")  # type: ignore[union-attr]
            overlay._commit_text_annotation()

            self.assertEqual(len(overlay._annotations), 1)
            self.assertEqual(overlay._annotations[0].text, "重点")
            self.assertEqual(overlay._annotations[0].tool, ScreenshotAnnotationTool.TEXT)
            overlay.close()

    def test_text_editor_range_grows_with_the_text_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(180, 120, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.black)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 180, 120))
            overlay._selection = QRect(10, 8, 160, 100)
            overlay._set_annotation_tool(ScreenshotAnnotationTool.TEXT)
            overlay._start_text_annotation(QPoint(20, 20))
            editor = overlay._text_editor
            self.assertIsNotNone(editor)
            empty_size = editor.size()  # type: ignore[union-attr]

            editor.setPlainText("XXXX")  # type: ignore[union-attr]
            one_line_size = editor.size()  # type: ignore[union-attr]
            self.assertGreater(one_line_size.width(), empty_size.width())

            editor.setPlainText("XXXX\nXXXXXXX\nXX")  # type: ignore[union-attr]
            multiline_size = editor.size()  # type: ignore[union-attr]
            self.assertGreater(multiline_size.width(), one_line_size.width())
            self.assertGreater(multiline_size.height(), one_line_size.height())
            self.assertEqual(overlay._text_editor_source_bounds, overlay._source_rect(editor.geometry()))  # type: ignore[union-attr]
            overlay.close()

    def test_text_annotation_clicking_blank_commits_multiline_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(180, 120, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 180, 120))
            overlay._selection = QRect(10, 8, 160, 100)
            overlay._set_annotation_tool(ScreenshotAnnotationTool.TEXT)
            overlay._start_text_annotation(QPoint(20, 20))
            overlay._text_editor.setPlainText("第一行\n第二行" * 80)  # type: ignore[union-attr]

            QApplication.sendEvent(
                overlay,
                QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(170, 100), QPointF(170, 100), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier),
            )

            self.assertIsNone(overlay._text_editor)
            self.assertEqual(len(overlay._annotations), 1)
            self.assertEqual(overlay._annotations[0].text, "第一行\n第二行" * 80)
            overlay.close()

    def test_selected_text_can_reopen_move_resize_and_change_font_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(180, 120, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 180, 120))
            overlay._selection = QRect(10, 8, 160, 100)
            text = ScreenshotAnnotation(ScreenshotAnnotationTool.TEXT, QPoint(20, 20), QPoint(90, 54), "#ef4444", 3, "重点\n说明", 18)
            overlay._annotations = [text]
            overlay._select_text_annotation(text)

            overlay._update_selected_text_bounds(QRect(32, 26, 96, 48))
            moved = overlay._selected_text_annotation
            self.assertIsNotNone(moved)
            self.assertEqual(moved.start, QPoint(32, 26))  # type: ignore[union-attr]
            self.assertEqual(moved.end, QPoint(127, 73))  # type: ignore[union-attr]
            overlay._adjust_annotation_font_size(4)
            self.assertEqual(overlay._selected_text_annotation.font_size, 22)  # type: ignore[union-attr]

            overlay._start_text_annotation(QPoint(40, 32), overlay._selected_text_annotation)
            self.assertEqual(overlay._text_editor.toPlainText(), "重点\n说明")  # type: ignore[union-attr]
            overlay._text_editor.setPlainText("已修改\n文字")  # type: ignore[union-attr]
            overlay._commit_text_annotation()
            self.assertEqual(len(overlay._annotations), 1)
            self.assertEqual(overlay._annotations[0].text, "已修改\n文字")
            overlay.close()

    def test_existing_selection_can_be_dragged_without_changing_its_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseButtonPress,
                    QPointF(15, 12),
                    QPointF(15, 12),
                    Qt.MouseButton.LeftButton,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseMove,
                    QPointF(45, 32),
                    QPointF(45, 32),
                    Qt.MouseButton.NoButton,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseButtonRelease,
                    QPointF(45, 32),
                    QPointF(45, 32),
                    Qt.MouseButton.LeftButton,
                    Qt.MouseButton.NoButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )

            self.assertEqual(overlay._selection, QRect(40, 28, 30, 20))
            overlay.close()

    def test_canceled_capture_is_not_kept_in_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            transient = save_screenshot_image(root, image, "capture")
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((transient,)),
                QRect(0, 0, 100, 60),
                transient_paths=(transient,),
            )

            overlay.close()

            self.assertFalse(transient.exists())
            self.assertEqual(list((root / ".rabiroute-message-images").glob("screenshot-*.png")), [])

    def test_confirmed_capture_promotes_the_current_image_into_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            transient = save_screenshot_image(root, image, "capture")
            region_store = ScreenshotRegionStore(root)
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((transient,)),
                QRect(0, 0, 100, 60),
                region_store,
                (transient,),
            )
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            overlay.copy_requested.connect(copied.append)

            overlay._copy()

            saved = list((root / ".rabiroute-message-images").glob("screenshot-*.png"))
            self.assertEqual(len(copied), 1)
            self.assertFalse(transient.exists())
            self.assertEqual(len(saved), 1)
            self.assertEqual(region_store.get(saved[0]), QRect(10, 8, 30, 20))

    def test_overlay_shortcuts_select_full_screen_and_switch_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "current.png"
            previous = root / "previous.png"
            for path, color in ((current, Qt.GlobalColor.red), (previous, Qt.GlobalColor.green)):
                image = QImage(100, 60, QImage.Format.Format_ARGB32)
                image.fill(color)
                self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((current, previous)), QRect(0, 0, 100, 60))

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier))
            self.assertEqual(overlay._selection, QRect(0, 0, 100, 60))
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Comma, Qt.KeyboardModifier.ShiftModifier, "<"))
            self.assertEqual(overlay._history.index, 1)
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Period, Qt.KeyboardModifier.ShiftModifier, ">"))
            self.assertEqual(overlay._history.index, 0)
            overlay.close()

    def test_region_history_restores_the_previous_area_for_a_saved_screen(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            store = ScreenshotRegionStore(root)
            source_rect = QRect(10, 8, 30, 20)
            store.remember(path, source_rect)

            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((path,)),
                QRect(0, 0, 100, 60),
                store,
            )

            self.assertEqual(overlay._selection, source_rect)
            overlay.close()

    def test_region_history_persists_the_capture_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "screen.png"
            image = QImage(400, 100, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            layout = ScreenCaptureLayout(
                QRect(0, 0, 300, 100),
                QSize(400, 100),
                (ScreenCaptureSegment(QRect(100, 0, 200, 100), QRect(100, 0, 300, 100)),),
            )
            store = ScreenshotRegionStore(root)

            store.remember_layout(path, layout)

            restored = store.get_layout(path)
            self.assertIsNotNone(restored)
            self.assertEqual(restored, layout)

    def test_region_history_moves_the_capture_layout_when_a_capture_is_committed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = root / "capture-screen.png"
            next_path = root / "screenshot-screen.png"
            layout = ScreenCaptureLayout(
                QRect(0, 0, 300, 100),
                QSize(400, 100),
                (ScreenCaptureSegment(QRect(100, 0, 200, 100), QRect(100, 0, 300, 100)),),
            )
            store = ScreenshotRegionStore(root)
            store.remember_layout(previous, layout)

            store.rename_image(previous, next_path)

            self.assertIsNone(store.get_layout(previous))
            self.assertEqual(store.get_layout(next_path), layout)

    def test_pin_uses_the_selected_screen_position(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(120, 80, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[tuple[QImage, QRect]] = []
            overlay.pin_requested.connect(lambda selection, origin: emitted.append((selection, origin)))

            overlay._pin()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0][0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][1].topLeft(), overlay.mapToGlobal(QPoint(10, 8)))
            self.assertEqual(emitted[0][1].size(), QSize(30, 20))

    def test_pin_confirmation_can_skip_auto_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((path,)),
                QRect(0, 0, 100, 60),
                auto_copy_on_confirm=False,
            )
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            pinned: list[tuple[QImage, QRect]] = []
            overlay.copy_requested.connect(copied.append)
            overlay.pin_requested.connect(lambda selection, origin: pinned.append((selection, origin)))

            overlay.pin_selection()

            self.assertEqual(copied, [])
            self.assertEqual(len(pinned), 1)

    def test_pin_shortcut_pins_the_open_capture_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(120, 80, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            controller = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                Path(directory),
                lambda: [],
                lambda _title, _message, _is_error: None,
            )
            controller._settings = ScreenshotSettings(enabled=True)
            controller._capture_overlay = overlay
            emitted: list[tuple[QImage, QRect]] = []
            copied: list[QImage] = []
            overlay.pin_requested.connect(lambda selection, origin: emitted.append((selection, origin)))
            overlay.copy_requested.connect(copied.append)
            clipboard = QImage(24, 18, QImage.Format.Format_ARGB32)
            clipboard.fill(Qt.GlobalColor.red)
            QApplication.clipboard().setImage(clipboard)

            controller._pin_requested()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(len(copied), 1)
            self.assertEqual(copied[0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][1].topLeft(), overlay.mapToGlobal(QPoint(10, 8)))
            self.assertEqual(emitted[0][1].size(), QSize(30, 20))
            overlay.deleteLater()
            QApplication.processEvents()

    def test_pinned_store_persists_geometry_opacity_and_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(24, 18, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.yellow)
            store = PinnedScreenshotStore(root)
            record = store.create(image, QPoint(120, 80), QSize(24, 18), 0.8)

            loaded = store.load()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0].pin_id, record.pin_id)
            self.assertEqual(loaded[0].image_path.name, f"{record.pin_id}.png")
            self.assertEqual((loaded[0].x, loaded[0].y, loaded[0].width, loaded[0].height), (120, 80, 24, 18))
            self.assertAlmostEqual(loaded[0].opacity, 0.8)

            store.update(record.pin_id, QPoint(140, 90), QSize(30, 20), 0.6)
            updated = store.load()[0]
            self.assertEqual((updated.x, updated.y, updated.width, updated.height), (140, 90, 30, 20))
            self.assertAlmostEqual(updated.opacity, 0.6)

            store.delete(record.pin_id)
            self.assertEqual(store.load(), ())
            self.assertFalse(record.image_path.exists())

    def test_controller_restores_pinned_image_without_deleting_it_on_stop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(24, 18, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.yellow)
            origin = QRect(120, 80, 24, 18)
            controller = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                root,
                lambda: [],
                lambda _title, _message, _is_error: None,
            )

            controller._pin_image(image, origin)
            self.assertEqual(len(controller._pins), 1)
            controller.stop()
            self.assertEqual(len(PinnedScreenshotStore(root).load()), 1)

            restored = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                root,
                lambda: [],
                lambda _title, _message, _is_error: None,
            )
            restored._restore_pinned_images()
            self.assertEqual(len(restored._pins), 1)
            pin = next(iter(restored._pins))
            self.assertEqual(pin.pos(), origin.topLeft())
            self.assertEqual(pin.size(), origin.size())

            pin._set_opacity(0.6)
            saved = PinnedScreenshotStore(root).load()[0]
            self.assertAlmostEqual(saved.opacity, 0.6)
            pin.close()
            QApplication.processEvents()
            self.assertEqual(PinnedScreenshotStore(root).load(), ())
            restored.stop()

    def test_plugin_catalog_controls_existing_screenshot_hotkeys(self) -> None:
        class FakeHotkey(QObject):
            activated = Signal()

            def __init__(self) -> None:
                super().__init__()
                self.configurations: list[tuple[bool, str]] = []

            def configure(self, enabled: bool, shortcut: str) -> None:
                self.configurations.append((enabled, shortcut))

            def stop(self) -> None:
                pass

        screenshot_hotkey = FakeHotkey()
        clipboard_hotkey = FakeHotkey()
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda _title, _message, _is_error: None,
            hotkey=screenshot_hotkey,  # type: ignore[arg-type]
            clipboard_hotkey=clipboard_hotkey,  # type: ignore[arg-type]
        )
        controller._started = True
        controller._settings = ScreenshotSettings(True, "Ctrl+Alt+S", "F4", False)

        controller.set_plugin_hotkeys((
            _plugin_hotkey("capture-screenshot", "desktop.capture-screenshot", "Ctrl+Shift+S"),
        ))

        self.assertEqual(screenshot_hotkey.configurations[-1], (True, "Ctrl+Alt+S"))
        self.assertEqual(clipboard_hotkey.configurations[-1], (False, "F4"))
        controller.set_plugin_hotkeys((
            _plugin_hotkey("pin-clipboard-image", "desktop.pin-clipboard-image", "Ctrl+Alt+V"),
        ))
        self.assertEqual(screenshot_hotkey.configurations[-1], (False, "Ctrl+Alt+S"))
        self.assertEqual(clipboard_hotkey.configurations[-1], (True, "F4"))
        controller.stop()

    def test_public_plugin_actions_reuse_existing_capture_and_pin_paths(self) -> None:
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda _title, _message, _is_error: None,
        )
        with patch.object(controller, "_capture_requested") as capture, patch.object(controller, "_pin_requested") as pin:
            controller.request_capture()
            controller.request_clipboard_pin()

        capture.assert_called_once_with()
        pin.assert_called_once_with()
        controller.stop()

    def test_settings_refresh_retries_after_a_transient_manager_error(self) -> None:
        class RetryManager:
            def __init__(self) -> None:
                self.calls = 0

            def desktop_settings(self) -> DesktopSettings:
                self.calls += 1
                if self.calls == 1:
                    raise OSError("Manager is starting")
                return DesktopSettings(True, "F1", "F3", False)

        class FakeHotkey(QObject):
            activated = Signal()

            def __init__(self) -> None:
                super().__init__()
                self.configurations: list[tuple[bool, str]] = []
                self.stopped = False

            def configure(self, enabled: bool, shortcut: str) -> None:
                self.configurations.append((enabled, shortcut))

            def stop(self) -> None:
                self.stopped = True

        with tempfile.TemporaryDirectory() as directory, patch("rabiroute_tray.system_screenshot.sync_startup_shortcut"):
            manager = RetryManager()
            screenshot_hotkey = FakeHotkey()
            clipboard_hotkey = FakeHotkey()
            controller = SystemScreenshotController(
                manager,  # type: ignore[arg-type]
                Path(directory),
                lambda: [],
                lambda _title, _message, _is_error: None,
                hotkey=screenshot_hotkey,  # type: ignore[arg-type]
                clipboard_hotkey=clipboard_hotkey,  # type: ignore[arg-type]
            )
            controller._settings_retry_delay_ms = 1
            controller.set_plugin_hotkeys((
                _plugin_hotkey("capture-screenshot", "desktop.capture-screenshot", "Ctrl+Shift+S"),
                _plugin_hotkey("pin-clipboard-image", "desktop.pin-clipboard-image", "Ctrl+Alt+V"),
            ))
            controller.start()
            deadline = time.monotonic() + 2
            while (
                time.monotonic() < deadline
                and (not screenshot_hotkey.configurations or screenshot_hotkey.configurations[-1] != (True, "F1"))
            ):
                QApplication.processEvents()
                time.sleep(0.01)

            self.assertGreaterEqual(manager.calls, 2)
            self.assertEqual(screenshot_hotkey.configurations[-1], (True, "F1"))
            self.assertEqual(clipboard_hotkey.configurations[-1], (True, "F3"))
            controller.stop()
            self.assertTrue(screenshot_hotkey.stopped)
            self.assertTrue(clipboard_hotkey.stopped)

    def test_clipboard_image_creates_a_pinned_window(self) -> None:
        image = QImage(24, 18, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.yellow)
        QApplication.clipboard().setImage(image)
        notifications: list[tuple[str, str, bool]] = []
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda title, message, is_error: notifications.append((title, message, is_error)),
        )
        controller._settings = ScreenshotSettings(enabled=True)

        controller._pin_clipboard_image()

        self.assertEqual(len(controller._pins), 1)
        self.assertEqual(notifications, [])
        controller.stop()
    def test_composer_emits_entered_text_and_selected_persona(self) -> None:
        composer = ScreenshotComposer(
            Path("C:/tmp/rabiroute-screenshot.png"),
            [
                SelectionDeliveryTarget("route-a", "人格 A"),
                SelectionDeliveryTarget("route-b", "人格 B"),
            ],
        )
        emitted: list[tuple[str, str]] = []
        composer.send_requested.connect(lambda gateway_id, text: emitted.append((gateway_id, text)))
        composer._target.setCurrentIndex(1)
        composer._text.setPlainText("  请查看截图中的按钮布局。  ")

        composer._send()

        self.assertEqual(emitted, [("route-b", "请查看截图中的按钮布局。")])
        composer.close()


if __name__ == "__main__":
    unittest.main()
