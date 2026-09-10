from __future__ import annotations

import ctypes
import json
import math
import os
import sys
import uuid
import threading
import time
from ctypes import wintypes
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from PIL import ImageGrab
from PySide6.QtCore import QEvent, QFileSystemWatcher, QObject, QPoint, QRect, QSize, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QAction, QColor, QContextMenuEvent, QCursor, QFont, QFontMetrics, QBrush, QIcon, QImage, QKeyEvent, QMouseEvent, QPainter, QPalette, QPen, QPixmap, QWheelEvent, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .manager_client import DesktopSettings, ManagerClient, RolePanelSendResult
from .plugin_catalog import (
    DesktopExtensionRegistry,
    DesktopPluginHotkey,
    create_builtin_desktop_extension_registry,
)
from .qt_async import QtAsyncTask, start_qt_task
from .system_selection import SelectionDeliveryTarget
from .windows_app_identity import sync_startup_shortcut


DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S"
DEFAULT_CLIPBOARD_PIN_SHORTCUT = "Ctrl+Alt+V"
_HISTORY_LIMIT = 30
_SETTINGS_RETRY_DELAY_MS = 2_000
_SELECTION_HANDLE_RADIUS = 5
_SELECTION_HANDLE_HIT_SIZE = 4
_SELECTION_MINIMUM_SIZE = 2
_ANNOTATION_DEFAULT_COLOR = "#EF4444"
_ANNOTATION_COLORS = ("#EF4444", "#F59E0B", "#22C55E", "#3B82F6")
_ANNOTATION_DEFAULT_STROKE_WIDTH = 3
_ANNOTATION_DEFAULT_FONT_SIZE = 18
_TEXT_ANNOTATION_MINIMUM_SIZE = QSize(48, 30)
_TEXT_ANNOTATION_DEFAULT_SIZE = QSize(260, 90)
_TEXT_ANNOTATION_MINIMUM_FONT_SIZE = 10
_TEXT_ANNOTATION_MAXIMUM_FONT_SIZE = 96
_ANNOTATION_FONT_FAMILY = "Microsoft YaHei UI"

_TOOLBAR_ICON_KINDS = {
    "selection": "crop",
    "rectangle": "rectangle",
    "arrow": "arrow",
    "text": "text",
    "text-smaller": "text-smaller",
    "text-larger": "text-larger",
    "copy": "copy",
    "pin": "pin",
    "send": "send",
}
_TOOLBAR_LABELS = {
    "selection": "调整选区",
    "rectangle": "矩形框",
    "arrow": "箭头",
    "text": "文字标注",
    "text-smaller": "减小文字字号",
    "text-larger": "增大文字字号",
    "copy": "复制截图",
    "pin": "贴图",
    "send": "发送截图",
}


def _toolbar_icon(kind: str, color: str, size: int = 24) -> QIcon:
    """Create the small monochrome toolbar glyphs without adding an icon dependency."""
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    pen = QPen(QColor(color), 2.0, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)
    painter.setPen(pen)
    painter.setBrush(Qt.BrushStyle.NoBrush)
    center = size // 2
    if kind == "crop":
        painter.drawLine(QPoint(5, 9), QPoint(5, 5))
        painter.drawLine(QPoint(5, 5), QPoint(9, 5))
        painter.drawLine(QPoint(size - 9, 5), QPoint(size - 5, 5))
        painter.drawLine(QPoint(size - 5, 5), QPoint(size - 5, 9))
        painter.drawLine(QPoint(5, size - 9), QPoint(5, size - 5))
        painter.drawLine(QPoint(5, size - 5), QPoint(9, size - 5))
        painter.drawLine(QPoint(size - 9, size - 5), QPoint(size - 5, size - 5))
        painter.drawLine(QPoint(size - 5, size - 5), QPoint(size - 5, size - 9))
    elif kind == "rectangle":
        painter.drawRect(QRect(5, 6, size - 10, size - 12))
    elif kind == "arrow":
        painter.drawLine(QPoint(5, size - 6), QPoint(size - 6, 5))
        painter.drawLine(QPoint(size - 6, 5), QPoint(size - 13, 5))
        painter.drawLine(QPoint(size - 6, 5), QPoint(size - 6, 12))
    elif kind == "text":
        font = QFont("Segoe UI", 14, QFont.Weight.Bold)
        painter.setFont(font)
        painter.drawText(QRect(2, 1, size - 4, size - 2), Qt.AlignmentFlag.AlignCenter, "T")
    elif kind in ("text-smaller", "text-larger"):
        font = QFont("Segoe UI", 12, QFont.Weight.Bold)
        painter.setFont(font)
        painter.drawText(QRect(2, 1, size - 4, size - 2), Qt.AlignmentFlag.AlignCenter, "T" + ("−" if kind == "text-smaller" else "+"))
    elif kind == "copy":
        painter.drawRect(QRect(8, 5, 11, 13))
        painter.drawRect(QRect(5, 8, 11, 11))
    elif kind == "pin":
        painter.drawLine(QPoint(center, 5), QPoint(center, 14))
        painter.drawLine(QPoint(8, 5), QPoint(size - 8, 5))
        painter.drawLine(QPoint(9, 14), QPoint(size - 9, 14))
        painter.drawLine(QPoint(center, 14), QPoint(7, size - 5))
        painter.drawLine(QPoint(center, 14), QPoint(size - 7, size - 5))
    elif kind == "color":
        painter.setBrush(QBrush(QColor(color)))
        painter.drawEllipse(QRect(5, 5, size - 10, size - 10))
    elif kind == "send":
        painter.drawLine(QPoint(4, size - 5), QPoint(size - 5, 4))
        painter.drawLine(QPoint(size - 5, 4), QPoint(size - 8, size - 13))
        painter.drawLine(QPoint(size - 5, 4), QPoint(size - 13, 7))
        painter.drawLine(QPoint(4, size - 5), QPoint(size - 10, size - 7))
        painter.drawLine(QPoint(4, size - 5), QPoint(size - 6, size - 5))
    painter.end()
    return QIcon(pixmap)


class ScreenshotAnnotationTool(str, Enum):
    SELECTION = "selection"
    RECTANGLE = "rectangle"
    ARROW = "arrow"
    TEXT = "text"


class ScreenshotSelectionHandle(str, Enum):
    NONE = "none"
    NORTH = "north"
    NORTH_EAST = "north-east"
    EAST = "east"
    SOUTH_EAST = "south-east"
    SOUTH = "south"
    SOUTH_WEST = "south-west"
    WEST = "west"
    NORTH_WEST = "north-west"


@dataclass(frozen=True)
class ScreenshotAnnotation:
    tool: ScreenshotAnnotationTool
    start: QPoint
    end: QPoint
    color: str = _ANNOTATION_DEFAULT_COLOR
    stroke_width: int = _ANNOTATION_DEFAULT_STROKE_WIDTH
    text: str = ""
    font_size: int = _ANNOTATION_DEFAULT_FONT_SIZE
_PLUGIN_HOTKEY_ID_RANGE = range(0x5300, 0x5400)


def _next_plugin_hotkey_id(used_ids: set[int]) -> int | None:
    return next((candidate for candidate in _PLUGIN_HOTKEY_ID_RANGE if candidate not in used_ids), None)


def _screenshot_theme_colors() -> dict[str, str]:
    app = QApplication.instance()
    dark = bool(app and app.palette().color(QPalette.ColorRole.Window).lightness() < 128)
    if dark:
        return {
            "surface": "#19242e",
            "border": "#526779",
            "text": "#e9f2f7",
            "hover": "#1b3a40",
            "toolbar": "rgba(16, 22, 29, 236)",
            "selection": "#43d4d7",
        }
    return {
        "surface": "#ffffff",
        "border": "#cbd5e1",
        "text": "#0f172a",
        "hover": "#e2f5f0",
        "toolbar": "rgba(15, 23, 42, 232)",
        "selection": "#2dd4bf",
    }


_MODIFIERS = {
    "CTRL": 0x0002,
    "CONTROL": 0x0002,
    "ALT": 0x0001,
    "SHIFT": 0x0004,
    "WIN": 0x0008,
    "WINDOWS": 0x0008,
}
_SPECIAL_KEYS = {
    "SPACE": 0x20,
    "TAB": 0x09,
    "ENTER": 0x0D,
    "ESC": 0x1B,
    "ESCAPE": 0x1B,
    "F1": 0x70,
    "F2": 0x71,
    "F3": 0x72,
    "F4": 0x73,
    "F5": 0x74,
    "F6": 0x75,
    "F7": 0x76,
    "F8": 0x77,
    "F9": 0x78,
    "F10": 0x79,
    "F11": 0x7A,
    "F12": 0x7B,
}


@dataclass(frozen=True)
class ScreenshotSettings:
    enabled: bool = False
    shortcut: str = DEFAULT_SCREENSHOT_SHORTCUT
    clipboard_shortcut: str = DEFAULT_CLIPBOARD_PIN_SHORTCUT
    auto_copy: bool = True


@dataclass(frozen=True)
class ScreenshotWindowCandidate:
    rectangle: QRect


def screenshot_window_candidates(ignore_handles: tuple[int, ...] = ()) -> tuple[ScreenshotWindowCandidate, ...]:
    """Return visible top-level application windows in front-to-back order."""
    if sys.platform != "win32":
        return ()
    ignored = {handle for handle in ignore_handles if handle}
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    candidates: list[ScreenshotWindowCandidate] = []
    ws_ex_toolwindow = 0x00000080
    ws_ex_noactivate = 0x08000000

    @callback_type
    def inspect_window(handle, _lparam):
        if int(handle) in ignored or not user32.IsWindowVisible(handle) or user32.IsIconic(handle):
            return True
        ex_style = int(user32.GetWindowLongPtrW(handle, -20))
        if ex_style & ws_ex_toolwindow and ex_style & ws_ex_noactivate:
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(handle, ctypes.byref(rect)):
            return True
        width = int(rect.right - rect.left)
        height = int(rect.bottom - rect.top)
        if width < 24 or height < 24:
            return True
        candidates.append(ScreenshotWindowCandidate(QRect(int(rect.left), int(rect.top), width, height)))
        return True

    user32.EnumWindows(inspect_window, 0)
    return tuple(candidates)


def screenshot_window_candidate_at(
    candidates: tuple[ScreenshotWindowCandidate, ...],
    screen_point: QPoint,
) -> ScreenshotWindowCandidate | None:
    return next((candidate for candidate in candidates if candidate.rectangle.contains(screen_point)), None)


@dataclass(frozen=True)
class ScreenshotHistory:
    paths: tuple[Path, ...]
    index: int = 0

    @property
    def current(self) -> Path | None:
        return self.paths[self.index] if self.paths else None

    def move(self, offset: int) -> "ScreenshotHistory":
        if not self.paths:
            return self
        return ScreenshotHistory(self.paths, max(0, min(self.index + offset, len(self.paths) - 1)))


@dataclass(frozen=True)
class PinnedScreenshot:
    pin_id: str
    image_path: Path
    x: int
    y: int
    width: int
    height: int
    opacity: float


@dataclass(frozen=True)
class ScreenCaptureSegment:
    """Maps one Qt desktop rectangle to its native-pixel screenshot rectangle."""

    logical_rect: QRect
    source_rect: QRect


@dataclass(frozen=True)
class ScreenCaptureLayout:
    """Piecewise mapping for a virtual desktop with mixed monitor DPI."""

    virtual_geometry: QRect
    image_size: QSize
    segments: tuple[ScreenCaptureSegment, ...]
    native_geometry: QRect | None = None

    def source_rect_for_logical(self, logical_rect: QRect) -> QRect:
        if logical_rect.isEmpty():
            return QRect()
        if not self.segments:
            return self._uniform_source_rect(logical_rect)
        source: QRect | None = None
        for segment in self.segments:
            intersection = logical_rect.intersected(segment.logical_rect)
            if intersection.isEmpty():
                continue
            mapped = self._map_rect(intersection, segment.logical_rect, segment.source_rect)
            source = mapped if source is None else source.united(mapped)
        return (source or QRect()).intersected(QRect(QPoint(0, 0), self.image_size))

    def logical_rect_for_source(self, source_rect: QRect) -> QRect:
        if source_rect.isEmpty():
            return QRect()
        if not self.segments:
            return self._uniform_logical_rect(source_rect)
        logical: QRect | None = None
        for segment in self.segments:
            intersection = source_rect.intersected(segment.source_rect)
            if intersection.isEmpty():
                continue
            mapped = self._map_rect(intersection, segment.source_rect, segment.logical_rect)
            logical = mapped if logical is None else logical.united(mapped)
        return (logical or QRect()).intersected(QRect(QPoint(0, 0), self.virtual_geometry.size()))

    def draw(self, painter: QPainter, image: QImage, target_rect: QRect | None = None) -> None:
        target = target_rect or QRect(QPoint(0, 0), self.virtual_geometry.size())
        if target.isEmpty() or image.isNull():
            return
        if not self.segments:
            painter.drawImage(target, image, self._uniform_source_rect(target))
            return
        for segment in self.segments:
            logical = target.intersected(segment.logical_rect)
            if logical.isEmpty():
                continue
            source = self._map_rect(logical, segment.logical_rect, segment.source_rect)
            painter.drawImage(logical, image, source)

    def to_payload(self) -> dict[str, Any]:
        return {
            "virtual": self._rect_payload(self.virtual_geometry),
            "image": [self.image_size.width(), self.image_size.height()],
            "native": self._rect_payload(self.native_geometry) if self.native_geometry is not None else None,
            "segments": [
                {
                    "logical": self._rect_payload(segment.logical_rect),
                    "source": self._rect_payload(segment.source_rect),
                }
                for segment in self.segments
            ],
        }

    @classmethod
    def from_payload(cls, value: object) -> "ScreenCaptureLayout | None":
        if not isinstance(value, dict):
            return None
        virtual = cls._rect_from_payload(value.get("virtual"))
        image_value = value.get("image")
        if virtual is None or not isinstance(image_value, list) or len(image_value) != 2:
            return None
        try:
            image_size = QSize(int(image_value[0]), int(image_value[1]))
        except (TypeError, ValueError):
            return None
        if image_size.isEmpty():
            return None
        raw_segments = value.get("segments")
        if not isinstance(raw_segments, list):
            return None
        segments: list[ScreenCaptureSegment] = []
        for raw_segment in raw_segments:
            if not isinstance(raw_segment, dict):
                continue
            logical = cls._rect_from_payload(raw_segment.get("logical"))
            source = cls._rect_from_payload(raw_segment.get("source"))
            if logical is not None and source is not None and not logical.isEmpty() and not source.isEmpty():
                segments.append(ScreenCaptureSegment(logical, source))
        native = cls._rect_from_payload(value.get("native"))
        return cls(virtual, image_size, tuple(segments), native)

    @staticmethod
    def _map_rect(rect: QRect, from_rect: QRect, to_rect: QRect) -> QRect:
        def map_start(value: int, from_start: int, from_size: int, to_start: int, to_size: int) -> int:
            return to_start + round((value - from_start) * to_size / from_size)

        left = map_start(rect.left(), from_rect.left(), from_rect.width(), to_rect.left(), to_rect.width())
        top = map_start(rect.top(), from_rect.top(), from_rect.height(), to_rect.top(), to_rect.height())
        right = map_start(rect.right() + 1, from_rect.left(), from_rect.width(), to_rect.left(), to_rect.width())
        bottom = map_start(rect.bottom() + 1, from_rect.top(), from_rect.height(), to_rect.top(), to_rect.height())
        return QRect(left, top, max(1, right - left), max(1, bottom - top))

    def _uniform_source_rect(self, logical_rect: QRect) -> QRect:
        return self._map_rect(logical_rect, QRect(QPoint(0, 0), self.virtual_geometry.size()), QRect(QPoint(0, 0), self.image_size)).intersected(QRect(QPoint(0, 0), self.image_size))

    def _uniform_logical_rect(self, source_rect: QRect) -> QRect:
        return self._map_rect(source_rect, QRect(QPoint(0, 0), self.image_size), QRect(QPoint(0, 0), self.virtual_geometry.size())).intersected(QRect(QPoint(0, 0), self.virtual_geometry.size()))

    @staticmethod
    def _rect_payload(rect: QRect) -> list[int]:
        return [rect.x(), rect.y(), rect.width(), rect.height()]

    @staticmethod
    def _rect_from_payload(value: object) -> QRect | None:
        if not isinstance(value, list) or len(value) != 4:
            return None
        try:
            rect = QRect(int(value[0]), int(value[1]), int(value[2]), int(value[3]))
        except (TypeError, ValueError):
            return None
        return rect if not rect.isEmpty() else None


def desktop_screenshot_state_directory(project_root: Path) -> Path:
    return project_root / "data" / "desktop"


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json_object(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{time.time_ns()}.tmp")
    try:
        temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary_path, path)
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass


class ScreenshotRegionStore:
    def __init__(self, project_root: Path) -> None:
        self._path = desktop_screenshot_state_directory(project_root) / "screenshot-region-history.json"

    def get(self, image_path: Path) -> QRect | None:
        entries = _read_json_object(self._path).get("regions")
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("image") != image_path.name:
                continue
            try:
                rect = QRect(int(entry["x"]), int(entry["y"]), int(entry["width"]), int(entry["height"]))
            except (KeyError, TypeError, ValueError):
                return None
            return rect if rect.width() > 0 and rect.height() > 0 else None
        return None

    def get_layout(self, image_path: Path) -> ScreenCaptureLayout | None:
        entries = _read_json_object(self._path).get("regions")
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("image") != image_path.name:
                continue
            return ScreenCaptureLayout.from_payload(entry.get("layout"))
        return None

    def remember_layout(self, image_path: Path, layout: ScreenCaptureLayout) -> None:
        if not image_path.name or layout.image_size.isEmpty():
            return
        payload = _read_json_object(self._path)
        entries = payload.get("regions")
        records = [entry for entry in entries if isinstance(entry, dict) and entry.get("image") != image_path.name] if isinstance(entries, list) else []
        existing = next((entry for entry in entries if isinstance(entry, dict) and entry.get("image") == image_path.name), None) if isinstance(entries, list) else None
        record = dict(existing) if isinstance(existing, dict) else {"image": image_path.name}
        record["layout"] = layout.to_payload()
        records.insert(0, record)
        _write_json_object(self._path, {"version": 1, "regions": records[:_HISTORY_LIMIT]})

    def rename_image(self, previous_path: Path, next_path: Path) -> None:
        if not previous_path.name or not next_path.name or previous_path.name == next_path.name:
            return
        payload = _read_json_object(self._path)
        entries = payload.get("regions")
        if not isinstance(entries, list):
            return
        records: list[dict[str, Any]] = []
        moved: dict[str, Any] | None = None
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            image_name = entry.get("image")
            if image_name == previous_path.name:
                moved = dict(entry)
                moved["image"] = next_path.name
                continue
            if image_name == next_path.name:
                continue
            records.append(entry)
        if moved is not None:
            records.insert(0, moved)
            _write_json_object(self._path, {"version": 1, "regions": records[:_HISTORY_LIMIT]})

    def remember(self, image_path: Path, source_rect: QRect) -> None:
        if source_rect.isEmpty() or not image_path.name:
            return
        payload = _read_json_object(self._path)
        entries = payload.get("regions")
        records = [entry for entry in entries if isinstance(entry, dict) and entry.get("image") != image_path.name] if isinstance(entries, list) else []
        existing = next((entry for entry in entries if isinstance(entry, dict) and entry.get("image") == image_path.name), None) if isinstance(entries, list) else None
        record: dict[str, Any] = {
            "image": image_path.name,
            "x": source_rect.x(),
            "y": source_rect.y(),
            "width": source_rect.width(),
            "height": source_rect.height(),
        }
        if isinstance(existing, dict) and isinstance(existing.get("layout"), dict):
            record["layout"] = existing["layout"]
        records.insert(0, record)
        _write_json_object(self._path, {"version": 1, "regions": records[:_HISTORY_LIMIT]})


class PinnedScreenshotStore:
    def __init__(self, project_root: Path) -> None:
        self._directory = desktop_screenshot_state_directory(project_root) / "screenshot-pins"
        self._manifest_path = self._directory / "manifest.json"

    def create(self, image: QImage, position: QPoint, size: QSize, opacity: float) -> PinnedScreenshot:
        if image.isNull():
            raise RuntimeError("贴图图片不可用。")
        pin_id = uuid.uuid4().hex
        image_path = self._directory / f"{pin_id}.png"
        self._directory.mkdir(parents=True, exist_ok=True)
        if not image.save(str(image_path), "PNG"):
            raise RuntimeError("贴图保存失败。")
        record = PinnedScreenshot(pin_id, image_path, position.x(), position.y(), max(1, size.width()), max(1, size.height()), self._opacity(opacity))
        try:
            records = self._read_records()
            records.insert(0, record)
            self._write_records(records)
        except Exception:
            try:
                image_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return record

    def load(self) -> tuple[PinnedScreenshot, ...]:
        return tuple(record for record in self._read_records() if record.image_path.is_file() and not QImage(str(record.image_path)).isNull())

    def update(self, pin_id: str, position: QPoint, size: QSize, opacity: float) -> None:
        records = self._read_records()
        updated = [
            PinnedScreenshot(record.pin_id, record.image_path, position.x(), position.y(), max(1, size.width()), max(1, size.height()), self._opacity(opacity)) if record.pin_id == pin_id else record
            for record in records
        ]
        if updated != records:
            self._write_records(updated)

    def delete(self, pin_id: str) -> None:
        records = self._read_records()
        removed = [record for record in records if record.pin_id == pin_id]
        if not removed:
            return
        self._write_records([record for record in records if record.pin_id != pin_id])
        for record in removed:
            try:
                record.image_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _read_records(self) -> list[PinnedScreenshot]:
        entries = _read_json_object(self._manifest_path).get("pins")
        if not isinstance(entries, list):
            return []
        records: list[PinnedScreenshot] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            pin_id = str(entry.get("id") or "").strip()
            image_name = str(entry.get("image") or "").strip()
            if not pin_id or not image_name or Path(image_name).name != image_name:
                continue
            try:
                record = PinnedScreenshot(
                    pin_id,
                    self._directory / image_name,
                    int(entry["x"]),
                    int(entry["y"]),
                    max(1, int(entry["width"])),
                    max(1, int(entry["height"])),
                    self._opacity(float(entry.get("opacity", 1.0))),
                )
            except (KeyError, TypeError, ValueError):
                continue
            records.append(record)
        return records

    def _write_records(self, records: list[PinnedScreenshot]) -> None:
        _write_json_object(
            self._manifest_path,
            {
                "version": 1,
                "pins": [
                    {
                        "id": record.pin_id,
                        "image": record.image_path.name,
                        "x": record.x,
                        "y": record.y,
                        "width": record.width,
                        "height": record.height,
                        "opacity": record.opacity,
                    }
                    for record in records
                ],
            },
        )

    @staticmethod
    def _opacity(value: float) -> float:
        return max(0.1, min(1.0, value))


def parse_hotkey(value: str) -> tuple[int, int] | None:
    tokens = [item.strip().upper() for item in value.split("+") if item.strip()]
    if not tokens:
        return None
    modifiers = 0
    key: int | None = None
    for token in tokens:
        modifier = _MODIFIERS.get(token)
        if modifier is not None:
            modifiers |= modifier
            continue
        if key is not None:
            return None
        if token in _SPECIAL_KEYS:
            key = _SPECIAL_KEYS[token]
        elif len(token) == 1 and (token.isalpha() or token.isdigit()):
            key = ord(token)
        else:
            return None
    if key is None or (not modifiers and not 0x70 <= key <= 0x7B):
        return None
    return modifiers | 0x4000, key


def screenshot_directory(project_root: Path) -> Path:
    return project_root / ".rabiroute-message-images"


def screenshot_history(image_path: Path) -> ScreenshotHistory:
    directory = image_path.parent
    candidates = [
        path
        for pattern in ("screenshot-*.png", "screen-*.png")
        for path in directory.glob(pattern)
        if path.is_file()
    ]
    candidates.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    ordered = [image_path, *(path for path in candidates if path != image_path)]
    return ScreenshotHistory(tuple(ordered[:_HISTORY_LIMIT]))


def save_screenshot_image(project_root: Path, image: QImage, prefix: str = "screenshot") -> Path:
    directory = screenshot_directory(project_root)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{prefix}-{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 1_000_000:06d}.png"
    if image.isNull() or not image.save(str(path), "PNG"):
        raise RuntimeError("截图保存失败。")
    return path


class WindowsGlobalHotkey(QObject):
    activated = Signal()
    registration_failed = Signal(str)
    _RETRY_DELAYS_SECONDS = (0.25, 0.5, 1.0, 2.0)

    def __init__(self, hotkey_id: int, thread_name: str) -> None:
        super().__init__()
        self._hotkey_id = hotkey_id
        self._thread_name = thread_name
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._stop_requested = threading.Event()
        self._hotkey: tuple[int, int] | None = None
        self._shortcut = ""
        self._failure_reported = False

    def configure(self, enabled: bool, shortcut: str) -> None:
        hotkey = parse_hotkey(shortcut) if enabled else None
        if hotkey == self._hotkey and (hotkey is None or (self._thread is not None and self._thread.is_alive())):
            return
        self.stop()
        if hotkey != self._hotkey:
            self._failure_reported = False
        self._shortcut = shortcut
        self._hotkey = hotkey
        if hotkey is not None:
            self.start()

    def start(self) -> None:
        if sys.platform != "win32" or (self._thread is not None and self._thread.is_alive()) or self._hotkey is None:
            return
        self._stop_requested.clear()
        self._thread = threading.Thread(target=self._run, name=self._thread_name, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            return
        self._stop_requested.set()
        if self._thread_id:
            ctypes.windll.user32.PostThreadMessageW(self._thread_id, 0x0012, 0, 0)
        thread.join(timeout=1.5)
        # Never discard a live owner or clear its cancellation for a replacement.
        if not thread.is_alive():
            self._thread = None
            self._thread_id = 0

    def _run(self) -> None:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        message = wintypes.MSG()
        # PostThreadMessage cannot wake a thread until its message queue exists.
        user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        self._thread_id = int(kernel32.GetCurrentThreadId())
        modifiers, virtual_key = self._hotkey or (0, 0)
        registered = False
        try:
            for attempt in range(len(self._RETRY_DELAYS_SECONDS) + 1):
                if self._stop_requested.is_set():
                    return
                if user32.RegisterHotKey(None, self._hotkey_id, modifiers, virtual_key):
                    registered = True
                    self._failure_reported = False
                    break
                if attempt == len(self._RETRY_DELAYS_SECONDS):
                    if not self._failure_reported:
                        self._failure_reported = True
                        self.registration_failed.emit(
                            f"快捷键 {self._shortcut} 重试后仍无法注册，请检查占用或更换快捷键。"
                        )
                    return
                if self._stop_requested.wait(self._RETRY_DELAYS_SECONDS[attempt]):
                    return
            while not self._stop_requested.is_set() and user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if not self._stop_requested.is_set() and message.message == 0x0312 and message.wParam == self._hotkey_id:
                    self.activated.emit()
        finally:
            if registered:
                user32.UnregisterHotKey(None, self._hotkey_id)
            self._thread_id = 0


class WindowsGlobalScreenshotHotkey(WindowsGlobalHotkey):
    def __init__(self) -> None:
        super().__init__(0x5242, "RabiRouteScreenshotHotkey")


class WindowsGlobalClipboardPinHotkey(WindowsGlobalHotkey):
    def __init__(self) -> None:
        super().__init__(0x5243, "RabiRouteClipboardPinHotkey")


def capture_desktop_image(screens: list[Any] | None = None) -> QImage:
    if sys.platform == "win32":
        return capture_desktop_image_async()
    screens = screens if screens is not None else list(QApplication.screens())
    if not screens:
        raise RuntimeError("没有可用的显示器。")
    geometries = [screen.geometry() for screen in screens]
    left = min(rect.left() for rect in geometries)
    top = min(rect.top() for rect in geometries)
    right = max(rect.right() + 1 for rect in geometries)
    bottom = max(rect.bottom() + 1 for rect in geometries)
    image = QImage(right - left, bottom - top, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.black)
    painter = QPainter(image)
    try:
        for screen, geometry in zip(screens, geometries):
            pixmap = screen.grabWindow(0)
            painter.drawPixmap(geometry.left() - left, geometry.top() - top, pixmap)
    finally:
        painter.end()
    return image


def capture_desktop_image_async() -> QImage:
    if sys.platform != "win32":
        raise RuntimeError("系统截图仅支持 Windows。")
    captured = ImageGrab.grab(all_screens=True)
    if captured.mode != "RGBA":
        captured = captured.convert("RGBA")
    image = QImage(captured.tobytes(), captured.width, captured.height, QImage.Format.Format_RGBA8888).copy()
    if image.isNull():
        raise RuntimeError("截图像素不可用。")
    return image


def windows_virtual_screen_origin() -> QPoint:
    if sys.platform != "win32":
        return QPoint(0, 0)
    user32 = ctypes.windll.user32
    return QPoint(int(user32.GetSystemMetrics(76)), int(user32.GetSystemMetrics(77)))


def capture_desktop(project_root: Path, screens: list[Any] | None = None) -> Path:
    return save_screenshot_image(project_root, capture_desktop_image(screens), "capture")


class ScreenshotColorPreviewWindow(QFrame):
    """Mouse-transparent color magnifier rendered independently from the capture overlay."""

    def __init__(self) -> None:
        super().__init__()
        self._magnifier_pixmap = QPixmap()
        self._color_name = ""
        self.magnifier = QLabel(self)
        self.swatch = QLabel(self)
        self.hex_label = QLabel(self)
        self._configure_window()
        self._configure_layout()

    def _configure_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
            | Qt.WindowType.WindowTransparentForInput
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setFixedSize(126, 150)
        colors = _screenshot_theme_colors()
        self.setStyleSheet(
            f"background: {colors['toolbar']}; color: white; border: 1px solid {colors['selection']}; border-radius: 6px;"
        )

    def _configure_layout(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 7, 5)
        layout.setSpacing(6)
        self.magnifier.setFixedSize(110, 110)
        self.magnifier.setStyleSheet("border: 0;")
        self.swatch.setFixedSize(34, 24)
        self.hex_label.setStyleSheet("border: 0; font-family: Consolas, 'Courier New', monospace; font-weight: 600;")
        details = QHBoxLayout()
        details.setContentsMargins(0, 0, 0, 0)
        details.setSpacing(6)
        details.addWidget(self.swatch)
        details.addWidget(self.hex_label)
        details.addStretch(1)
        layout.addWidget(self.magnifier, 0, Qt.AlignmentFlag.AlignHCenter)
        layout.addLayout(details)

    def present(self, position: QPoint, magnifier: QImage, color: QColor) -> None:
        self.move(position)
        if not self.isVisible():
            self.show()
            self.raise_()
        self._magnifier_pixmap.convertFromImage(magnifier)
        self.magnifier.setPixmap(self._magnifier_pixmap)
        color_name = color.name().upper()
        if color_name != self._color_name:
            self._color_name = color_name
            self.swatch.setStyleSheet(
                f"background: {color_name}; border: 1px solid rgba(255, 255, 255, 180); border-radius: 3px;"
            )
            self.hex_label.setText(color_name)


class ScreenshotCaptureOverlay(QWidget):
    copy_requested = Signal(QImage)
    pin_requested = Signal(QImage, QRect)
    send_requested = Signal(QImage)
    color_copy_requested = Signal(str)

    def __init__(
        self,
        history: ScreenshotHistory,
        virtual_geometry: QRect | None = None,
        region_store: ScreenshotRegionStore | None = None,
        transient_paths: tuple[Path, ...] = (),
        auto_copy_on_confirm: bool = True,
        capture_layout: ScreenCaptureLayout | None = None,
        pin_shortcut: str = DEFAULT_CLIPBOARD_PIN_SHORTCUT,
    ) -> None:
        super().__init__()
        self._history = history
        self._region_store = region_store
        self._transient_paths = set(transient_paths)
        self._auto_copy_on_confirm = auto_copy_on_confirm
        self._capture_layout = capture_layout
        self._pin_shortcut = pin_shortcut or DEFAULT_CLIPBOARD_PIN_SHORTCUT
        self._image = QImage()
        self._capture_pixmap = QPixmap()
        self._dimmed_capture_pixmap = QPixmap()
        self._capture_ready = bool(history.paths)
        self._pending_action: str | None = None
        self._selection = QRect()
        self._drag_start: QPoint | None = None
        self._selection_move_offset: QPoint | None = None
        self._selection_resize_handle = ScreenshotSelectionHandle.NONE
        self._selection_resize_start = QRect()
        self._annotation_tool = ScreenshotAnnotationTool.SELECTION
        self._annotation_color = _ANNOTATION_DEFAULT_COLOR
        self._annotation_font_size = _ANNOTATION_DEFAULT_FONT_SIZE
        self._annotations: list[ScreenshotAnnotation] = []
        self._active_annotation: ScreenshotAnnotation | None = None
        self._selected_text_annotation: ScreenshotAnnotation | None = None
        self._text_move_offset: QPoint | None = None
        self._text_dragged = False
        self._text_edit_on_release = False
        self._text_resize_handle = ScreenshotSelectionHandle.NONE
        self._text_resize_start = QRect()
        self._text_editor: QPlainTextEdit | None = None
        self._text_editor_source_bounds: QRect | None = None
        self._text_editing_annotation: ScreenshotAnnotation | None = None
        self._window_candidates: tuple[ScreenshotWindowCandidate, ...] = ()
        self._hover_window_candidate: ScreenshotWindowCandidate | None = None
        self._candidate_click_pending = False
        self._pointer_position: QPoint | None = None
        self._color_preview: QColor | None = None
        self._toolbar = QFrame(self)
        self._text_properties_bar = QFrame(self)
        self._history_label = QLabel(self)
        self._color_tip = ScreenshotColorPreviewWindow()
        self._color_magnifier = self._color_tip.magnifier
        self._color_swatch = self._color_tip.swatch
        self._color_hex_label = self._color_tip.hex_label
        self._selection_tool_button = QPushButton("调整", self._toolbar)
        self._rectangle_tool_button = QPushButton("框", self._toolbar)
        self._arrow_tool_button = QPushButton("箭头", self._toolbar)
        self._text_tool_button = QPushButton("文字", self._toolbar)
        self._text_smaller_button = QPushButton(self._text_properties_bar)
        self._text_font_size_label = QLabel(self._text_properties_bar)
        self._text_larger_button = QPushButton(self._text_properties_bar)
        self._annotation_tool_buttons = {
            ScreenshotAnnotationTool.SELECTION: self._selection_tool_button,
            ScreenshotAnnotationTool.RECTANGLE: self._rectangle_tool_button,
            ScreenshotAnnotationTool.ARROW: self._arrow_tool_button,
            ScreenshotAnnotationTool.TEXT: self._text_tool_button,
        }
        self._annotation_color_buttons = {
            color: QPushButton(self._toolbar)
            for color in _ANNOTATION_COLORS
        }
        self._copy_button = QPushButton("复制", self._toolbar)
        self._pin_button = QPushButton("贴图", self._toolbar)
        self._send_button = QPushButton("发送", self._toolbar)
        self._undo_shortcut = QShortcut(QKeySequence("Ctrl+Z"), self)
        self._undo_shortcut.setContext(Qt.ShortcutContext.WindowShortcut)
        self._undo_shortcut.activated.connect(self._undo_annotation)
        self._configure_window(virtual_geometry)
        self._configure_toolbar()
        self._show_history(self._history.index)

    def _configure_window(self, virtual_geometry: QRect | None) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        geometry = virtual_geometry or self._virtual_geometry()
        self.setGeometry(geometry)
        colors = _screenshot_theme_colors()
        self._history_label.setStyleSheet(
            f"background: {colors['toolbar']}; color: white; border-radius: 6px; padding: 5px 8px;"
        )
        self._history_label.move(14, 14)
        self._color_tip.hide()

    def _configure_toolbar(self) -> None:
        colors = _screenshot_theme_colors()
        self._toolbar.setStyleSheet(
            f"QFrame {{ background: {colors['surface']}; border: 1px solid {colors['border']}; border-radius: 8px; }}"
            f"QPushButton {{ border: 1px solid transparent; border-radius: 6px; padding: 4px; color: {colors['text']}; }}"
            f"QPushButton:hover {{ background: {colors['hover']}; border-color: {colors['border']}; }}"
            "QPushButton:pressed { background: #0f766e; color: white; }"
            "QPushButton:checked { background: #0f766e; color: white; border: 2px solid #5eead4; }"
            "QPushButton[selected=\"true\"] { background: rgba(20, 184, 166, 0.18); border: 2px solid #5eead4; }"
            "QPushButton:disabled { color: #94a3b8; background: transparent; border-color: transparent; }"
        )
        layout = QHBoxLayout(self._toolbar)
        layout.setContentsMargins(5, 5, 5, 5)
        layout.setSpacing(3)
        for tool, button in self._annotation_tool_buttons.items():
            key = tool.value
            button.setText("")
            button.setCheckable(True)
            button.setFixedSize(34, 34)
            button.setIconSize(QSize(20, 20))
            button.setToolTip(_TOOLBAR_LABELS[key])
            button.setAccessibleName(_TOOLBAR_LABELS[key])
            button.setObjectName("screenshotToolButton")
            button.clicked.connect(lambda _checked=False, selected_tool=tool: self._set_annotation_tool(selected_tool))
            layout.addWidget(button)
        for color, button in self._annotation_color_buttons.items():
            button.setFixedSize(30, 30)
            button.setIconSize(QSize(18, 18))
            button.setToolTip(f"标注颜色 {color}")
            button.setAccessibleName(f"标注颜色 {color}")
            button.setIcon(_toolbar_icon("color", color, 24))
            button.clicked.connect(lambda _checked=False, selected_color=color: self._set_annotation_color(selected_color))
            layout.addWidget(button)
        for button, key in (
            (self._copy_button, "copy"),
            (self._pin_button, "pin"),
            (self._send_button, "send"),
        ):
            button.setText("")
            button.setFixedSize(34, 34)
            button.setIconSize(QSize(20, 20))
            button.setToolTip(_TOOLBAR_LABELS[key])
            button.setAccessibleName(_TOOLBAR_LABELS[key])
            button.setIcon(_toolbar_icon(_TOOLBAR_ICON_KINDS[key], colors["text"]))
            layout.addWidget(button)
        self._text_properties_bar.setStyleSheet(
            f"QFrame {{ background: {colors['surface']}; border: 1px solid {colors['border']}; border-radius: 8px; }}"
            f"QPushButton {{ border: 1px solid transparent; border-radius: 6px; padding: 4px; color: {colors['text']}; }}"
            f"QPushButton:hover {{ background: {colors['hover']}; border-color: {colors['border']}; }}"
            "QPushButton:pressed { background: #0f766e; color: white; }"
            "QPushButton:disabled { color: #94a3b8; background: transparent; border-color: transparent; }"
        )
        properties_layout = QHBoxLayout(self._text_properties_bar)
        properties_layout.setContentsMargins(5, 5, 5, 5)
        properties_layout.setSpacing(3)
        for button, key, delta in (
            (self._text_smaller_button, "text-smaller", -2),
            (self._text_larger_button, "text-larger", 2),
        ):
            button.setFixedSize(30, 34)
            button.setIconSize(QSize(20, 20))
            button.setToolTip(_TOOLBAR_LABELS[key])
            button.setAccessibleName(_TOOLBAR_LABELS[key])
            button.setIcon(_toolbar_icon(_TOOLBAR_ICON_KINDS[key], colors["text"]))
            button.clicked.connect(lambda _checked=False, size_delta=delta: self._adjust_annotation_font_size(size_delta))
        self._text_font_size_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._text_font_size_label.setMinimumWidth(28)
        self._text_font_size_label.setToolTip("当前文字字号")
        self._text_font_size_label.setAccessibleName("当前文字字号")
        properties_layout.addWidget(self._text_smaller_button)
        properties_layout.addWidget(self._text_font_size_label)
        properties_layout.addWidget(self._text_larger_button)
        self._toolbar.hide()
        self._text_properties_bar.hide()
        for widget in (
            self._history_label,
            self._toolbar,
            self._text_properties_bar,
            *self._annotation_tool_buttons.values(),
            self._text_smaller_button,
            self._text_larger_button,
            *self._annotation_color_buttons.values(),
            self._copy_button,
            self._pin_button,
            self._send_button,
        ):
            widget.installEventFilter(self)
        self._copy_button.clicked.connect(self._copy)
        self._pin_button.clicked.connect(self._pin)
        self._send_button.clicked.connect(self._send)
        self._refresh_annotation_controls()

    def _refresh_annotation_controls(self) -> None:
        colors = _screenshot_theme_colors()
        for tool, button in self._annotation_tool_buttons.items():
            selected = tool == self._annotation_tool
            button.setChecked(selected)
            button.setIcon(_toolbar_icon(_TOOLBAR_ICON_KINDS[tool.value], "#ffffff" if selected else colors["text"]))
        text_controls_visible = self._annotation_tool == ScreenshotAnnotationTool.TEXT or self._selected_text_annotation is not None
        self._text_properties_bar.setVisible(text_controls_visible and self._toolbar.isVisible())
        self._text_smaller_button.setEnabled(text_controls_visible and self._annotation_font_size > _TEXT_ANNOTATION_MINIMUM_FONT_SIZE)
        self._text_larger_button.setEnabled(text_controls_visible and self._annotation_font_size < _TEXT_ANNOTATION_MAXIMUM_FONT_SIZE)
        self._text_font_size_label.setText(str(self._annotation_font_size))
        self._text_font_size_label.setStyleSheet(f"color: {colors['text']}; font-weight: 700;")
        for color, button in self._annotation_color_buttons.items():
            selected = color == self._annotation_color
            button.setProperty("selected", selected)
            button.setIcon(_toolbar_icon("color", color, 24))
            button.style().unpolish(button)
            button.style().polish(button)
            button.update()

    def _set_annotation_tool(self, tool: ScreenshotAnnotationTool) -> None:
        self._commit_text_annotation()
        self._annotation_tool = tool
        self._refresh_annotation_controls()
        if not self._selection.isEmpty():
            self._position_text_properties_bar()
            self.update(self._selection_paint_bounds(self._selection))

    def _set_annotation_color(self, color: str) -> None:
        self._annotation_color = color
        self._refresh_annotation_controls()

    def _adjust_annotation_font_size(self, delta: int) -> None:
        target = max(_TEXT_ANNOTATION_MINIMUM_FONT_SIZE, min(_TEXT_ANNOTATION_MAXIMUM_FONT_SIZE, self._annotation_font_size + delta))
        if target == self._annotation_font_size:
            return
        self._annotation_font_size = target
        annotation = self._selected_text_annotation
        if annotation is not None:
            updated = ScreenshotAnnotation(
                annotation.tool,
                annotation.start,
                annotation.end,
                annotation.color,
                annotation.stroke_width,
                annotation.text,
                target,
            )
            self._replace_annotation(annotation, updated)
            self._selected_text_annotation = updated
        self._refresh_annotation_controls()
        self._position_toolbar()

    def _clear_annotations(self) -> None:
        self._cancel_text_annotation()
        self._annotations.clear()
        self._active_annotation = None
        self._selected_text_annotation = None
        self._text_move_offset = None
        self._text_edit_on_release = False
        self._text_resize_handle = ScreenshotSelectionHandle.NONE
        self._annotation_tool = ScreenshotAnnotationTool.SELECTION
        self._refresh_annotation_controls()

    def _undo_annotation(self) -> None:
        self._cancel_text_annotation()
        if not self._annotations:
            return
        annotation = self._annotations.pop()
        self._update_annotation_region(annotation, None)
        self._refresh_annotation_controls()

    def _source_point(self, point: QPoint) -> QPoint:
        if self._image.isNull() or self.width() <= 0 or self.height() <= 0:
            return QPoint(point)
        source = self._source_rect(QRect(point, QSize(1, 1)))
        return source.topLeft() if not source.isEmpty() else QPoint(point)

    def _overlay_point_from_source(self, point: QPoint) -> QPoint:
        if self._image.isNull() or self._image.width() <= 0 or self._image.height() <= 0:
            return QPoint(point)
        if self._capture_layout is not None:
            logical = self._capture_layout.logical_rect_for_source(QRect(point, QSize(1, 1)))
            if not logical.isEmpty():
                return logical.topLeft()
        return QPoint(
            max(0, min(self.width() - 1, round(point.x() * self.width() / self._image.width()))),
            max(0, min(self.height() - 1, round(point.y() * self.height() / self._image.height()))),
        )

    def _annotation_display_scale(self) -> float:
        if self._image.isNull() or self._image.width() <= 0 or self._image.height() <= 0:
            return 1.0
        return ((self.width() / self._image.width()) + (self.height() / self._image.height())) / 2

    def _annotation_source_stroke_width(self) -> int:
        return max(1, round(_ANNOTATION_DEFAULT_STROKE_WIDTH / max(self._annotation_display_scale(), 0.01)))

    def _annotation_source_font_size(self) -> int:
        return max(_TEXT_ANNOTATION_MINIMUM_FONT_SIZE, round(self._annotation_font_size / max(self._annotation_display_scale(), 0.01)))

    @staticmethod
    def _text_annotation_source_bounds(annotation: ScreenshotAnnotation) -> QRect:
        explicit_bounds = QRect(annotation.start, annotation.end).normalized()
        if annotation.start != annotation.end:
            return explicit_bounds
        font = QFont(_ANNOTATION_FONT_FAMILY)
        font.setPixelSize(max(_TEXT_ANNOTATION_MINIMUM_FONT_SIZE, annotation.font_size))
        metrics = QFontMetrics(font)
        lines = annotation.text.splitlines() or [""]
        return QRect(
            annotation.start,
            QSize(
                max(_TEXT_ANNOTATION_MINIMUM_SIZE.width(), max(metrics.horizontalAdvance(line) for line in lines) + 10),
                max(_TEXT_ANNOTATION_MINIMUM_SIZE.height(), metrics.lineSpacing() * len(lines) + 10),
            ),
        )

    def _text_annotation_display_rect(self, annotation: ScreenshotAnnotation) -> QRect:
        return self._selection_from_source(self._text_annotation_source_bounds(annotation))

    def _annotation_display_bounds(self, annotation: ScreenshotAnnotation) -> QRect:
        start = self._overlay_point_from_source(annotation.start)
        end = self._overlay_point_from_source(annotation.end)
        stroke = max(1, round(annotation.stroke_width * self._annotation_display_scale()))
        bounds = self._text_annotation_display_rect(annotation) if annotation.tool == ScreenshotAnnotationTool.TEXT else QRect(start, end).normalized()
        padding = max(6, stroke * 5)
        return bounds.adjusted(-padding, -padding, padding, padding).intersected(self.rect())

    def _replace_annotation(self, previous: ScreenshotAnnotation, current: ScreenshotAnnotation) -> bool:
        try:
            index = self._annotations.index(previous)
        except ValueError:
            return False
        self._annotations[index] = current
        self._update_annotation_region(previous, current)
        return True

    def _select_text_annotation(self, annotation: ScreenshotAnnotation | None) -> None:
        previous = self._selected_text_annotation
        self._selected_text_annotation = annotation
        if annotation is not None:
            self._annotation_font_size = annotation.font_size
            self._annotation_color = annotation.color
        self._refresh_annotation_controls()
        self._update_annotation_region(previous, annotation)
        if not self._selection.isEmpty():
            self._position_toolbar()

    def _text_annotation_at(self, point: QPoint) -> ScreenshotAnnotation | None:
        for annotation in reversed(self._annotations):
            if annotation.tool == ScreenshotAnnotationTool.TEXT and self._text_annotation_display_rect(annotation).contains(point):
                return annotation
        return None

    def _text_annotation_handle_points(self, annotation: ScreenshotAnnotation) -> tuple[tuple[ScreenshotSelectionHandle, QPoint], ...]:
        bounds = self._text_annotation_display_rect(annotation)
        if bounds.isEmpty():
            return ()
        left, top, right, bottom = bounds.left(), bounds.top(), bounds.right(), bounds.bottom()
        return (
            (ScreenshotSelectionHandle.NORTH_WEST, QPoint(left, top)),
            (ScreenshotSelectionHandle.NORTH, QPoint((left + right) // 2, top)),
            (ScreenshotSelectionHandle.NORTH_EAST, QPoint(right, top)),
            (ScreenshotSelectionHandle.EAST, QPoint(right, (top + bottom) // 2)),
            (ScreenshotSelectionHandle.SOUTH_EAST, QPoint(right, bottom)),
            (ScreenshotSelectionHandle.SOUTH, QPoint((left + right) // 2, bottom)),
            (ScreenshotSelectionHandle.SOUTH_WEST, QPoint(left, bottom)),
            (ScreenshotSelectionHandle.WEST, QPoint(left, (top + bottom) // 2)),
        )

    def _text_annotation_handle_at(self, point: QPoint) -> ScreenshotSelectionHandle:
        annotation = self._selected_text_annotation
        if annotation is None:
            return ScreenshotSelectionHandle.NONE
        for handle, handle_point in self._text_annotation_handle_points(annotation):
            if abs(point.x() - handle_point.x()) <= _SELECTION_HANDLE_HIT_SIZE and abs(point.y() - handle_point.y()) <= _SELECTION_HANDLE_HIT_SIZE:
                return handle
        return ScreenshotSelectionHandle.NONE

    def _resized_text_annotation_rect(self, point: QPoint) -> QRect:
        bounds = QRect(self._text_resize_start)
        limit = self._selection
        left, top, right, bottom = bounds.left(), bounds.top(), bounds.right(), bounds.bottom()
        handle = self._text_resize_handle
        if handle in (ScreenshotSelectionHandle.NORTH_WEST, ScreenshotSelectionHandle.WEST, ScreenshotSelectionHandle.SOUTH_WEST):
            left = max(limit.left(), min(point.x(), right - _TEXT_ANNOTATION_MINIMUM_SIZE.width() + 1))
        if handle in (ScreenshotSelectionHandle.NORTH_EAST, ScreenshotSelectionHandle.EAST, ScreenshotSelectionHandle.SOUTH_EAST):
            right = min(limit.right(), max(point.x(), left + _TEXT_ANNOTATION_MINIMUM_SIZE.width() - 1))
        if handle in (ScreenshotSelectionHandle.NORTH_WEST, ScreenshotSelectionHandle.NORTH, ScreenshotSelectionHandle.NORTH_EAST):
            top = max(limit.top(), min(point.y(), bottom - _TEXT_ANNOTATION_MINIMUM_SIZE.height() + 1))
        if handle in (ScreenshotSelectionHandle.SOUTH_WEST, ScreenshotSelectionHandle.SOUTH, ScreenshotSelectionHandle.SOUTH_EAST):
            bottom = min(limit.bottom(), max(point.y(), top + _TEXT_ANNOTATION_MINIMUM_SIZE.height() - 1))
        return QRect(left, top, right - left + 1, bottom - top + 1)

    def _update_selected_text_bounds(self, display_bounds: QRect) -> None:
        previous = self._selected_text_annotation
        if previous is None:
            return
        source_bounds = self._source_rect(display_bounds.intersected(self._selection))
        current = ScreenshotAnnotation(
            ScreenshotAnnotationTool.TEXT,
            source_bounds.topLeft(),
            source_bounds.bottomRight(),
            previous.color,
            previous.stroke_width,
            previous.text,
            previous.font_size,
        )
        if self._replace_annotation(previous, current):
            self._selected_text_annotation = current

    def _paint_selected_text_annotation(self, painter: QPainter) -> None:
        annotation = self._selected_text_annotation
        if annotation is None or annotation == self._text_editing_annotation:
            return
        bounds = self._text_annotation_display_rect(annotation)
        if bounds.isEmpty():
            return
        painter.save()
        try:
            color = QColor(_screenshot_theme_colors()["selection"])
            painter.setPen(QPen(color, 1, Qt.PenStyle.DashLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(bounds.adjusted(0, 0, -1, -1))
            painter.setPen(QPen(color, 1))
            painter.setBrush(QColor("white"))
            for _handle, point in self._text_annotation_handle_points(annotation):
                painter.drawRect(QRect(point.x() - _SELECTION_HANDLE_RADIUS, point.y() - _SELECTION_HANDLE_RADIUS, _SELECTION_HANDLE_RADIUS * 2 + 1, _SELECTION_HANDLE_RADIUS * 2 + 1))
        finally:
            painter.restore()

    def _update_annotation_region(
        self,
        previous: ScreenshotAnnotation | None,
        current: ScreenshotAnnotation | None,
    ) -> None:
        dirty = QRect()
        if previous is not None:
            dirty = self._annotation_display_bounds(previous)
        if current is not None:
            bounds = self._annotation_display_bounds(current)
            dirty = bounds if dirty.isEmpty() else dirty.united(bounds)
        if not dirty.isEmpty():
            self.update(dirty)

    def _draw_annotation(
        self,
        painter: QPainter,
        annotation: ScreenshotAnnotation,
        source_origin: QPoint | None = None,
    ) -> None:
        if source_origin is None:
            start = self._overlay_point_from_source(annotation.start)
            end = self._overlay_point_from_source(annotation.end)
            stroke = max(1, round(annotation.stroke_width * self._annotation_display_scale()))
            font_size = max(10, round(annotation.font_size * self._annotation_display_scale()))
        else:
            start = annotation.start - source_origin
            end = annotation.end - source_origin
            stroke = annotation.stroke_width
            font_size = annotation.font_size
        painter.save()
        try:
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            color = QColor(annotation.color)
            pen = QPen(color, stroke)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            if annotation.tool == ScreenshotAnnotationTool.RECTANGLE:
                painter.drawRect(QRect(start, end).normalized())
                return
            if annotation.tool == ScreenshotAnnotationTool.ARROW:
                painter.drawLine(start, end)
                dx = end.x() - start.x()
                dy = end.y() - start.y()
                length = math.hypot(dx, dy)
                if length > 0:
                    angle = math.atan2(dy, dx)
                    head_size = max(8, stroke * 4)
                    for offset in (math.pi * 5 / 6, -math.pi * 5 / 6):
                        point = QPoint(
                            round(end.x() + math.cos(angle + offset) * head_size),
                            round(end.y() + math.sin(angle + offset) * head_size),
                        )
                        painter.drawLine(end, point)
                return
            if annotation.tool == ScreenshotAnnotationTool.TEXT and annotation.text:
                font = QFont(_ANNOTATION_FONT_FAMILY)
                font.setPixelSize(font_size)
                painter.setFont(font)
                bounds = self._text_annotation_source_bounds(annotation)
                text_bounds = QRect(bounds.topLeft() - source_origin, bounds.size()) if source_origin is not None else self._text_annotation_display_rect(annotation)
                painter.drawText(text_bounds, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop | Qt.TextFlag.TextWordWrap, annotation.text)
        finally:
            painter.restore()

    def _paint_annotations(self, painter: QPainter) -> None:
        if self._selection.isEmpty():
            return
        painter.save()
        try:
            painter.setClipRect(self._selection)
            for annotation in self._annotations:
                if annotation != self._text_editing_annotation:
                    self._draw_annotation(painter, annotation)
            if self._active_annotation is not None:
                self._draw_annotation(painter, self._active_annotation)
            self._paint_selected_text_annotation(painter)
        finally:
            painter.restore()

    def _selection_handle_points(self) -> tuple[tuple[ScreenshotSelectionHandle, QPoint], ...]:
        if self._selection.isEmpty():
            return ()
        left, top = self._selection.left(), self._selection.top()
        right, bottom = self._selection.right(), self._selection.bottom()
        center_x = (left + right) // 2
        center_y = (top + bottom) // 2
        return (
            (ScreenshotSelectionHandle.NORTH_WEST, QPoint(left, top)),
            (ScreenshotSelectionHandle.NORTH, QPoint(center_x, top)),
            (ScreenshotSelectionHandle.NORTH_EAST, QPoint(right, top)),
            (ScreenshotSelectionHandle.EAST, QPoint(right, center_y)),
            (ScreenshotSelectionHandle.SOUTH_EAST, QPoint(right, bottom)),
            (ScreenshotSelectionHandle.SOUTH, QPoint(center_x, bottom)),
            (ScreenshotSelectionHandle.SOUTH_WEST, QPoint(left, bottom)),
            (ScreenshotSelectionHandle.WEST, QPoint(left, center_y)),
        )

    def _clamp_point_to_selection(self, point: QPoint) -> QPoint:
        if self._selection.isEmpty():
            return QPoint(point)
        return QPoint(
            max(self._selection.left(), min(self._selection.right(), point.x())),
            max(self._selection.top(), min(self._selection.bottom(), point.y())),
        )

    def _selection_handle_at(self, point: QPoint) -> ScreenshotSelectionHandle:
        for handle, handle_point in self._selection_handle_points():
            if abs(point.x() - handle_point.x()) <= _SELECTION_HANDLE_HIT_SIZE and abs(point.y() - handle_point.y()) <= _SELECTION_HANDLE_HIT_SIZE:
                return handle
        return ScreenshotSelectionHandle.NONE

    @staticmethod
    def _cursor_for_selection_handle(handle: ScreenshotSelectionHandle) -> Qt.CursorShape:
        if handle in (ScreenshotSelectionHandle.NORTH, ScreenshotSelectionHandle.SOUTH):
            return Qt.CursorShape.SizeVerCursor
        if handle in (ScreenshotSelectionHandle.EAST, ScreenshotSelectionHandle.WEST):
            return Qt.CursorShape.SizeHorCursor
        if handle in (ScreenshotSelectionHandle.NORTH_WEST, ScreenshotSelectionHandle.SOUTH_EAST):
            return Qt.CursorShape.SizeFDiagCursor
        if handle in (ScreenshotSelectionHandle.NORTH_EAST, ScreenshotSelectionHandle.SOUTH_WEST):
            return Qt.CursorShape.SizeBDiagCursor
        return Qt.CursorShape.ArrowCursor

    def _resized_selection(self, point: QPoint) -> QRect:
        start = self._selection_resize_start
        left, top = start.left(), start.top()
        right, bottom = start.right(), start.bottom()
        handle = self._selection_resize_handle
        if handle in (ScreenshotSelectionHandle.NORTH_WEST, ScreenshotSelectionHandle.WEST, ScreenshotSelectionHandle.SOUTH_WEST):
            left = max(0, min(point.x(), right - _SELECTION_MINIMUM_SIZE + 1))
        if handle in (ScreenshotSelectionHandle.NORTH_EAST, ScreenshotSelectionHandle.EAST, ScreenshotSelectionHandle.SOUTH_EAST):
            right = min(self.width() - 1, max(point.x(), left + _SELECTION_MINIMUM_SIZE - 1))
        if handle in (ScreenshotSelectionHandle.NORTH_WEST, ScreenshotSelectionHandle.NORTH, ScreenshotSelectionHandle.NORTH_EAST):
            top = max(0, min(point.y(), bottom - _SELECTION_MINIMUM_SIZE + 1))
        if handle in (ScreenshotSelectionHandle.SOUTH_WEST, ScreenshotSelectionHandle.SOUTH, ScreenshotSelectionHandle.SOUTH_EAST):
            bottom = min(self.height() - 1, max(point.y(), top + _SELECTION_MINIMUM_SIZE - 1))
        return QRect(left, top, right - left + 1, bottom - top + 1)

    def _paint_selection_handles(self, painter: QPainter) -> None:
        if self._selection.width() < _SELECTION_MINIMUM_SIZE or self._selection.height() < _SELECTION_MINIMUM_SIZE:
            return
        painter.save()
        try:
            painter.setPen(QPen(QColor(_screenshot_theme_colors()["selection"]), 1))
            painter.setBrush(QColor("white"))
            for _handle, point in self._selection_handle_points():
                painter.drawRect(
                    QRect(
                        point.x() - _SELECTION_HANDLE_RADIUS,
                        point.y() - _SELECTION_HANDLE_RADIUS,
                        _SELECTION_HANDLE_RADIUS * 2 + 1,
                        _SELECTION_HANDLE_RADIUS * 2 + 1,
                    )
                )
        finally:
            painter.restore()

    def _begin_annotation(self, point: QPoint) -> bool:
        if self._annotation_tool == ScreenshotAnnotationTool.SELECTION or not self._selection.contains(point):
            return False
        if self._annotation_tool == ScreenshotAnnotationTool.TEXT:
            self._start_text_annotation(point)
            return True
        source_point = self._source_point(point)
        self._active_annotation = ScreenshotAnnotation(
            self._annotation_tool,
            source_point,
            source_point,
            self._annotation_color,
            self._annotation_source_stroke_width(),
            font_size=self._annotation_source_font_size(),
        )
        self._toolbar.hide()
        self._text_properties_bar.hide()
        return True

    def _update_active_annotation(self, point: QPoint) -> None:
        if self._active_annotation is None:
            return
        previous = self._active_annotation
        end = self._source_point(self._clamp_point_to_selection(point))
        self._active_annotation = ScreenshotAnnotation(
            previous.tool,
            previous.start,
            end,
            previous.color,
            previous.stroke_width,
            previous.text,
            previous.font_size,
        )
        self._update_annotation_region(previous, self._active_annotation)

    def _finish_active_annotation(self, point: QPoint) -> None:
        if self._active_annotation is None:
            return
        self._update_active_annotation(point)
        annotation = self._active_annotation
        self._active_annotation = None
        if annotation.start != annotation.end:
            self._annotations.append(annotation)
            self._refresh_annotation_controls()
        else:
            self._update_annotation_region(annotation, None)
        self._position_toolbar()

    def _start_text_annotation(self, point: QPoint, annotation: ScreenshotAnnotation | None = None) -> None:
        self._commit_text_annotation()
        point = self._clamp_point_to_selection(point)
        if annotation is not None:
            display_bounds = self._text_annotation_display_rect(annotation)
            source_bounds = self._text_annotation_source_bounds(annotation)
            self._select_text_annotation(annotation)
        else:
            right = min(self._selection.right(), point.x() + _TEXT_ANNOTATION_DEFAULT_SIZE.width() - 1)
            bottom = min(self._selection.bottom(), point.y() + _TEXT_ANNOTATION_DEFAULT_SIZE.height() - 1)
            display_bounds = QRect(point, QPoint(max(point.x() + _TEXT_ANNOTATION_MINIMUM_SIZE.width() - 1, right), max(point.y() + _TEXT_ANNOTATION_MINIMUM_SIZE.height() - 1, bottom))).intersected(self._selection)
            source_bounds = self._source_rect(display_bounds)
        editor = QPlainTextEdit(self)
        # Keep a real text editor for keyboard input and selection, but remove the
        # visible input-box chrome so text is edited directly on the screenshot.
        editor.setContentsMargins(0, 0, 0, 0)
        editor.setViewportMargins(0, 0, 0, 0)
        editor.document().setDocumentMargin(0.0)
        editor.setPlaceholderText("")
        editor.setPlainText(annotation.text if annotation is not None else "")
        editor.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        editor.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        editor.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        editor.setFrameStyle(QFrame.Shape.NoFrame)
        editor.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        editor.setStyleSheet(
            f"background: transparent; color: {annotation.color if annotation is not None else self._annotation_color}; border: none; padding: 0; selection-background-color: rgba(20, 184, 166, 0.28);"
        )
        font = QFont(_ANNOTATION_FONT_FAMILY)
        font.setPixelSize(max(_TEXT_ANNOTATION_MINIMUM_FONT_SIZE, round((annotation.font_size if annotation is not None else self._annotation_font_size) * self._annotation_display_scale())))
        editor.setFont(font)
        editor.setGeometry(display_bounds)
        editor.installEventFilter(self)
        self._text_editor = editor
        self._text_editor_source_bounds = source_bounds
        self._text_editing_annotation = annotation
        editor.textChanged.connect(self._resize_text_editor_to_content)
        self._undo_shortcut.setEnabled(False)
        self._toolbar.hide()
        self._text_properties_bar.hide()
        self.update(self._annotation_display_bounds(annotation) if annotation is not None else display_bounds)
        editor.show()
        editor.raise_()
        if annotation is None:
            self._resize_text_editor_to_content()
        editor.setFocus()

    def _resize_text_editor_to_content(self) -> None:
        editor = self._text_editor
        if editor is None or self._selection.isEmpty():
            return
        text = editor.toPlainText()
        lines = text.split("\n") or [""]
        metrics = editor.fontMetrics()
        width = max((metrics.horizontalAdvance(line) for line in lines), default=0) + 4
        height = metrics.lineSpacing() * max(1, len(lines)) + 4
        origin = editor.geometry().topLeft()
        max_width = max(2, self._selection.right() - origin.x() + 1)
        max_height = max(2, self._selection.bottom() - origin.y() + 1)
        next_geometry = QRect(
            origin,
            QSize(
                max(2, min(max_width, width)),
                max(2, min(max_height, height)),
            ),
        )
        previous_geometry = QRect(editor.geometry())
        if next_geometry != previous_geometry:
            editor.setGeometry(next_geometry)
            self.update(previous_geometry.united(next_geometry))
        self._text_editor_source_bounds = self._source_rect(next_geometry)

    def _commit_text_annotation(self) -> None:
        editor = self._text_editor
        source_bounds = self._text_editor_source_bounds
        previous = self._text_editing_annotation
        if editor is None:
            return
        self._text_editor = None
        self._text_editor_source_bounds = None
        self._text_editing_annotation = None
        self._undo_shortcut.setEnabled(True)
        text = editor.toPlainText().strip()
        color = previous.color if previous is not None else self._annotation_color
        font_size = previous.font_size if previous is not None else self._annotation_source_font_size()
        current = None
        if text and source_bounds is not None:
            current = ScreenshotAnnotation(
                ScreenshotAnnotationTool.TEXT,
                source_bounds.topLeft(),
                source_bounds.bottomRight(),
                color,
                previous.stroke_width if previous is not None else self._annotation_source_stroke_width(),
                text,
                font_size,
            )
        editor.hide()
        editor.deleteLater()
        if previous is not None:
            if current is None:
                if previous in self._annotations:
                    self._annotations.remove(previous)
                    self._update_annotation_region(previous, None)
                self._select_text_annotation(None)
            elif self._replace_annotation(previous, current):
                self._select_text_annotation(current)
        elif current is not None:
            self._annotations.append(current)
            self._select_text_annotation(current)
            self._update_annotation_region(None, current)
        self._refresh_annotation_controls()
        if not self._selection.isEmpty():
            self._position_toolbar()

    def _cancel_text_annotation(self) -> None:
        if self._text_editor is None:
            return
        editor = self._text_editor
        previous = self._text_editing_annotation
        self._text_editor = None
        self._text_editor_source_bounds = None
        self._text_editing_annotation = None
        self._undo_shortcut.setEnabled(True)
        editor.hide()
        editor.deleteLater()
        self._select_text_annotation(previous)
        if previous is not None:
            self.update(self._annotation_display_bounds(previous))

    @staticmethod
    def _virtual_geometry() -> QRect:
        screens = list(QApplication.screens())
        if not screens:
            return QRect(0, 0, 1, 1)
        result = QRect(screens[0].geometry())
        for screen in screens[1:]:
            result = result.united(screen.geometry())
        return result

    def _show_history(self, index: int) -> None:
        if not self._history.paths:
            self._history_label.setText("正在准备截图…")
            self._history_label.adjustSize()
            self.update()
            return
        index = max(0, min(index, len(self._history.paths) - 1))
        self._clear_annotations()
        path = self._history.paths[index]
        image = QImage(str(path))
        if image.isNull():
            self._history = ScreenshotHistory(tuple(item for item in self._history.paths if item != path), 0)
            self._show_history(0)
            return
        self._history = ScreenshotHistory(self._history.paths, index)
        self._image = image
        stored_layout = self._region_store.get_layout(path) if self._region_store is not None else None
        self._capture_layout = stored_layout if stored_layout is not None and stored_layout.image_size == image.size() else None
        if self._capture_layout is not None:
            # New captures keep their original monitor geometry.  Historical
            # single-monitor images therefore reopen on that monitor instead
            # of being stretched across whichever overlay was already open.
            self.set_capture_layout(self._capture_layout)
        self._invalidate_render_cache()
        self._capture_ready = True
        source_rect = self._region_store.get(path) if self._region_store is not None else None
        self._selection = self._selection_from_source(source_rect) if source_rect is not None else QRect()
        self._toolbar.hide()
        self._text_properties_bar.hide()
        self._history_label.setText(f"{index + 1} / {len(self._history.paths)}    < 上一张    > 下一张")
        self._history_label.adjustSize()
        if not self._selection.isEmpty():
            self._position_toolbar()
        self.update()

    def set_capture_image(self, image: QImage) -> None:
        if image.isNull():
            return
        self._image = image
        if self._capture_layout is not None and self._capture_layout.image_size != image.size():
            self._capture_layout = None
        self._invalidate_render_cache()
        self._clear_annotations()
        self._update_color_preview()
        self._history_label.setText("正在保存截图…")
        self._history_label.adjustSize()
        self.update()

    @property
    def capture_layout(self) -> ScreenCaptureLayout | None:
        return self._capture_layout

    def set_capture_layout(self, layout: ScreenCaptureLayout | None) -> None:
        if layout is None or layout.image_size != self._image.size():
            self._capture_layout = None
        else:
            self._capture_layout = layout
            self.setGeometry(layout.virtual_geometry)
            if layout.native_geometry is not None and sys.platform == "win32" and QApplication.platformName() == "windows":
                # A top-level HWND has ONE DPI even when it spans monitors.
                # Qt screen rectangles use per-monitor logical sizes, so their
                # union cannot be used as this window's canvas on mixed DPI.
                native = layout.native_geometry
                user32 = ctypes.windll.user32
                user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
                user32.SetWindowPos.restype = wintypes.BOOL
                if not user32.SetWindowPos(int(self.winId()), None, native.x(), native.y(), native.width(), native.height(), 0x0014):
                    raise RuntimeError("无法将截图窗口定位到完整桌面。")
                self._capture_layout = ScreenCaptureLayout(QRect(self.geometry()), layout.image_size, (), QRect(native))
                self._pointer_position = None
                self.set_window_candidates(self._window_candidates)
        self._invalidate_render_cache()
        self.update()

    def complete_capture(self, history: ScreenshotHistory, transient_path: Path) -> None:
        if not history.paths:
            return
        self._history = history
        self._transient_paths.add(transient_path)
        self._capture_ready = True
        self._history_label.setText(f"{history.index + 1} / {len(history.paths)}    < 上一张    > 下一张")
        self._history_label.adjustSize()
        if self._selection.isEmpty():
            source_rect = self._region_store.get(history.current) if history.current is not None and self._region_store is not None else None
            self._selection = self._selection_from_source(source_rect) if source_rect is not None else QRect()
            if not self._selection.isEmpty():
                self._position_toolbar()
        pending_action = self._pending_action
        self._pending_action = None
        self.update()
        if pending_action is not None:
            self._execute_selection_action(pending_action)

    def capture_failed(self) -> None:
        self._pending_action = None
        self._history_label.setText("截图失败")
        self._history_label.adjustSize()
        self.update()

    def _invalidate_render_cache(self) -> None:
        self._capture_pixmap = QPixmap()
        self._dimmed_capture_pixmap = QPixmap()

    def _ensure_render_cache(self) -> None:
        if self._image.isNull() or self.size().isEmpty():
            self._invalidate_render_cache()
            return
        if self._capture_pixmap.size() == self.size() and not self._dimmed_capture_pixmap.isNull():
            return
        if self._capture_layout is not None:
            scaled = QImage(self.size(), QImage.Format.Format_ARGB32)
            scaled.fill(Qt.GlobalColor.transparent)
            painter = QPainter(scaled)
            try:
                self._capture_layout.draw(painter, self._image, self.rect())
            finally:
                painter.end()
        else:
            scaled = self._image.scaled(
                self.size(),
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
        self._capture_pixmap = QPixmap.fromImage(scaled)
        dimmed = scaled.copy()
        painter = QPainter(dimmed)
        try:
            painter.fillRect(dimmed.rect(), QColor(15, 23, 42, 132))
        finally:
            painter.end()
        self._dimmed_capture_pixmap = QPixmap.fromImage(dimmed)

    def _image_selection(self) -> QImage:
        if self._selection.isEmpty() or self._image.isNull() or self.width() <= 0 or self.height() <= 0:
            return QImage()
        source = self._source_rect(self._selection)
        image = self._image.copy(source)
        if image.isNull() or not self._annotations:
            return image
        painter = QPainter(image)
        try:
            for annotation in self._annotations:
                self._draw_annotation(painter, annotation, source.topLeft())
        finally:
            painter.end()
        return image

    def _selection_label(self, selection: QRect) -> tuple[str, QRect]:
        source = self._source_rect(selection)
        label = f"{source.width()} × {source.height()}" if not source.isNull() else "正在准备截图…"
        metrics = self.fontMetrics()
        label_rect = QRect(
            selection.left(),
            max(0, selection.top() - metrics.height() - 9),
            metrics.horizontalAdvance(label) + 14,
            metrics.height() + 7,
        )
        return label, label_rect

    def _selection_paint_bounds(self, selection: QRect) -> QRect:
        if selection.isEmpty():
            return QRect()
        _label, label_rect = self._selection_label(selection)
        handle_padding = _SELECTION_HANDLE_RADIUS + 3
        return selection.adjusted(-handle_padding, -handle_padding, handle_padding, handle_padding).united(label_rect.adjusted(-2, -2, 2, 2)).intersected(self.rect())

    def _update_selection_region(self, previous: QRect) -> None:
        if previous.isEmpty() != self._selection.isEmpty():
            self.update()
            return
        dirty = self._selection_paint_bounds(previous).united(self._selection_paint_bounds(self._selection))
        if dirty.isEmpty():
            return
        self.update(dirty)

    def _set_selection(self, selection: QRect) -> None:
        previous = QRect(self._selection)
        self._selection = QRect(selection)
        self._update_selection_region(previous)

    def _position_text_properties_bar(self) -> None:
        if self._selection.isEmpty() or not self._text_properties_bar.isVisible() or not self._toolbar.isVisible():
            return
        self._text_properties_bar.adjustSize()
        x = max(8, min(self._toolbar.x(), self.width() - self._text_properties_bar.width() - 8))
        below = self._toolbar.y() + self._toolbar.height() + 4
        y = below if below + self._text_properties_bar.height() <= self.height() - 8 else self._toolbar.y() - self._text_properties_bar.height() - 4
        y = max(8, min(y, self.height() - self._text_properties_bar.height() - 8))
        self._text_properties_bar.move(x, y)
        self._text_properties_bar.raise_()

    def _position_toolbar(self) -> None:
        if self._selection.isEmpty():
            return
        self._toolbar.adjustSize()
        selection_right_x = self._selection.right() - self._toolbar.width() + 1
        x = max(8, min(selection_right_x, self.width() - self._toolbar.width() - 8))
        below = self._selection.bottom() + 10
        y = below if below + self._toolbar.height() <= self.height() - 8 else self._selection.top() - self._toolbar.height() - 10
        y = max(8, min(y, self.height() - self._toolbar.height() - 8))
        self._toolbar.move(x, y)
        self._toolbar.show()
        self._toolbar.raise_()
        # Refresh after showing the main toolbar so a text-properties bar selected
        # before this call is made visible and positioned in the second row.
        self._refresh_annotation_controls()
        self._position_text_properties_bar()

    def _complete_selection(self) -> None:
        self._candidate_click_pending = False
        if self._selection.width() < 2 or self._selection.height() < 2:
            self._set_selection(QRect())
            self._toolbar.hide()
            self._text_properties_bar.hide()
            return
        self._position_toolbar()
        self.update(self._selection_paint_bounds(self._selection))

    def _commit_current_capture(self) -> Path | None:
        current = self._history.current
        if current is None or current not in self._transient_paths:
            return current
        target = current.with_name(f"screenshot-{current.name.removeprefix('capture-')}")
        try:
            current.replace(target)
        except OSError:
            return None
        if self._region_store is not None:
            try:
                self._region_store.rename_image(current, target)
            except OSError:
                pass
        self._history = ScreenshotHistory(tuple(target if path == current else path for path in self._history.paths), self._history.index)
        self._transient_paths.discard(current)
        return target

    def _remember_selection(self) -> None:
        current = self._commit_current_capture()
        if current is None or self._region_store is None:
            return
        try:
            self._region_store.remember(current, self._source_rect(self._selection))
        except OSError:
            pass

    def set_window_candidates(self, candidates: tuple[ScreenshotWindowCandidate, ...]) -> None:
        self._window_candidates = candidates
        if self._pointer_position is None:
            layout = self._capture_layout
            if layout is not None and layout.native_geometry is not None and sys.platform == "win32":
                cursor = wintypes.POINT()
                if ctypes.windll.user32.GetCursorPos(ctypes.byref(cursor)):
                    source = QPoint(cursor.x, cursor.y) - layout.native_geometry.topLeft()
                    self._pointer_position = self._selection_from_source(QRect(source, QSize(1, 1))).topLeft()
            if self._pointer_position is None:
                self._pointer_position = self.mapFromGlobal(QCursor.pos())
        self._update_window_hover(self._pointer_position)
        self._update_color_preview()
        self.update()

    def _selection_from_window_candidate(self, candidate: ScreenshotWindowCandidate) -> QRect:
        if self._capture_layout is not None and self._capture_layout.native_geometry is not None:
            source = candidate.rectangle.translated(-self._capture_layout.native_geometry.topLeft())
            return self._selection_from_source(source).intersected(self.rect())
        top_left = candidate.rectangle.topLeft() - self.geometry().topLeft()
        return QRect(top_left, candidate.rectangle.size()).intersected(self.rect())

    def _update_window_hover(self, point: QPoint) -> None:
        if not self._selection.isEmpty() or self._drag_start is not None:
            self._hover_window_candidate = None
            return
        screen_point = self.mapToGlobal(point)
        if self._capture_layout is not None and self._capture_layout.native_geometry is not None:
            screen_point = self._source_rect(QRect(point, QSize(1, 1))).topLeft() + self._capture_layout.native_geometry.topLeft()
        self._hover_window_candidate = screenshot_window_candidate_at(
            self._window_candidates,
            screen_point,
        )

    def _global_rect(self, rectangle: QRect) -> QRect:
        layout = self._capture_layout
        if layout is None or layout.native_geometry is None:
            return QRect(self.mapToGlobal(rectangle.topLeft()), rectangle.size())
        native = self._source_rect(rectangle).translated(layout.native_geometry.topLeft())
        # Separate top-level tips and pins use the destination monitor's DPI.
        for screen in QApplication.screens():
            geometry = screen.geometry()
            ratio = screen.devicePixelRatio()
            physical = QRect(geometry.topLeft(), QSize(round(geometry.width() * ratio), round(geometry.height() * ratio)))
            if physical.contains(native.topLeft()):
                return ScreenCaptureLayout._map_rect(native, physical, geometry)
        return native

    def _update_color_preview(self) -> None:
        if not self._selection.isEmpty() or self._drag_start is not None:
            self._color_preview = None
        else:
            self._color_preview = self._color_at(self._pointer_position)
        self._update_color_tip()

    def _update_color_tip(self) -> None:
        if self._color_preview is None or self._pointer_position is None:
            self._color_tip.hide()
            return
        magnifier = self._color_magnifier_image(self._pointer_position)
        if magnifier.isNull():
            self._color_tip.hide()
            return
        self._color_tip.present(
            self._global_rect(QRect(self._color_tip_position(self._pointer_position), QSize(1, 1))).topLeft(),
            magnifier,
            self._color_preview,
        )
    def _color_tip_position(self, cursor: QPoint) -> QPoint:
        margin = 14
        size = self._color_tip.size()
        candidates = (
            QPoint(cursor.x() + margin, cursor.y() + margin),
            QPoint(cursor.x() - size.width() - margin, cursor.y() + margin),
            QPoint(cursor.x() + margin, cursor.y() - size.height() - margin),
            QPoint(cursor.x() - size.width() - margin, cursor.y() - size.height() - margin),
        )
        bounds = self.rect().adjusted(8, 8, -8, -8)
        for position in candidates:
            if bounds.contains(QRect(position, size)):
                return position
        return QPoint(
            max(bounds.left(), min(cursor.x() + margin, bounds.right() - size.width() + 1)),
            max(bounds.top(), min(cursor.y() + margin, bounds.bottom() - size.height() + 1)),
        )

    def _color_magnifier_image(self, point: QPoint) -> QImage:
        if self._image.isNull():
            return QImage()
        source = self._source_rect(QRect(point, QSize(1, 1)))
        if source.isEmpty():
            return QImage()
        sample_size = 11
        sample_radius = sample_size // 2
        center = source.topLeft()
        requested = QRect(
            center.x() - sample_radius,
            center.y() - sample_radius,
            sample_size,
            sample_size,
        )
        if self._image.rect().contains(requested):
            sample = self._image.copy(requested)
        else:
            visible = requested.intersected(self._image.rect())
            sample = QImage(sample_size, sample_size, QImage.Format.Format_ARGB32)
            sample.fill(self._image.pixelColor(center))
            painter = QPainter(sample)
            try:
                painter.drawImage(visible.topLeft() - requested.topLeft(), self._image, visible)
            finally:
                painter.end()
        magnifier = sample.scaled(
            sample_size * 10,
            sample_size * 10,
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.FastTransformation,
        )
        painter = QPainter(magnifier)
        try:
            center_offset = sample_radius * 10
            painter.setPen(QPen(QColor("black"), 3))
            painter.drawRect(center_offset, center_offset, 10, 10)
            painter.setPen(QPen(QColor("white"), 1))
            painter.drawRect(center_offset, center_offset, 10, 10)
        finally:
            painter.end()
        return magnifier

    def _color_at(self, point: QPoint | None) -> QColor | None:
        if point is None or self._image.isNull() or not self.rect().contains(point):
            return None
        source = self._source_rect(QRect(point, QSize(1, 1)))
        if source.isEmpty():
            return None
        return self._image.pixelColor(source.topLeft())

    def copy_current_color(self) -> bool:
        color = self._color_preview or self._color_at(self._pointer_position)
        if color is None:
            return False
        self._color_preview = color
        self.color_copy_requested.emit(color.name().upper())
        self._update_color_tip()
        return True

    def _copy(self) -> None:
        self._run_selection_action("copy")

    def pin_selection(self) -> bool:
        return self._run_selection_action("pin")

    def _pin(self) -> None:
        self.pin_selection()

    def _send(self) -> None:
        self._run_selection_action("send")

    def _focus_hovered_window_candidate(self) -> bool:
        if not self._selection.isEmpty() or self._drag_start is not None or self._hover_window_candidate is None:
            return not self._selection.isEmpty()
        selection = self._selection_from_window_candidate(self._hover_window_candidate)
        if selection.isEmpty():
            return False
        self._set_selection(selection)
        self._hover_window_candidate = None
        self._candidate_click_pending = False
        self._position_toolbar()
        self._update_color_preview()
        return True

    def _run_selection_action(self, action: str) -> bool:
        self._commit_text_annotation()
        if self._selection.isEmpty() and not self._focus_hovered_window_candidate():
            return False
        if not self._capture_ready:
            self._pending_action = action
            self._history_label.setText("正在准备截图，完成后继续…")
            self._history_label.adjustSize()
            self.update()
            return True
        self._execute_selection_action(action)
        return True

    def _execute_selection_action(self, action: str) -> None:
        image = self._image_selection()
        if image.isNull():
            return
        self._remember_selection()
        if action != "copy" and self._auto_copy_on_confirm:
            self.copy_requested.emit(image)
        if action == "copy":
            self.copy_requested.emit(image)
        elif action == "pin":
            origin = self._global_rect(self._selection)
            self.pin_requested.emit(image, origin)
        elif action == "send":
            self.send_requested.emit(image)
        else:
            return
        self.close()

    def paintEvent(self, event) -> None:
        dirty = event.rect().intersected(self.rect())
        painter = QPainter(self)
        try:
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
            painter.fillRect(dirty, Qt.GlobalColor.transparent)
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
            self._ensure_render_cache()
            if not self._capture_pixmap.isNull():
                background = self._dimmed_capture_pixmap if not self._selection.isEmpty() else self._capture_pixmap
                painter.drawPixmap(dirty, background, dirty)
            elif not self._image.isNull():
                painter.drawImage(self.rect(), self._image)
            if not self._selection.isEmpty():
                selection_rect = self._selection.intersected(dirty)
                if not selection_rect.isEmpty():
                    if not self._capture_pixmap.isNull():
                        painter.drawPixmap(selection_rect, self._capture_pixmap, selection_rect)
                    elif not self._image.isNull():
                        painter.drawImage(selection_rect, self._image, self._source_rect(selection_rect))
                self._paint_annotations(painter)
                painter.setPen(QPen(QColor(_screenshot_theme_colors()["selection"]), 2, Qt.PenStyle.DashLine))
                painter.drawRect(self._selection.adjusted(0, 0, -1, -1))
                self._paint_selection_handles(painter)
                label, label_rect = self._selection_label(self._selection)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(13, 148, 136, 230))
                painter.drawRoundedRect(label_rect, 4, 4)
                painter.setPen(QColor("white"))
                painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)
            elif self._hover_window_candidate is not None:
                candidate_rect = self._selection_from_window_candidate(self._hover_window_candidate)
                if not candidate_rect.isEmpty():
                    if not self._capture_pixmap.isNull():
                        painter.drawPixmap(dirty, self._dimmed_capture_pixmap, dirty)
                        candidate_dirty = candidate_rect.intersected(dirty)
                        if not candidate_dirty.isEmpty():
                            painter.drawPixmap(candidate_dirty, self._capture_pixmap, candidate_dirty)
                    elif not self._image.isNull():
                        painter.fillRect(self.rect(), QColor(15, 23, 42, 132))
                        self._draw_image(painter, candidate_rect)
                    painter.setPen(QPen(QColor(_screenshot_theme_colors()["selection"]), 2, Qt.PenStyle.DashLine))
                    painter.drawRect(candidate_rect.adjusted(0, 0, -1, -1))
                    label = f"窗口 {candidate_rect.width()} × {candidate_rect.height()} · 回车复制 / {self._pin_shortcut} 贴图 / F2 发送"
                    metrics = painter.fontMetrics()
                    label_rect = QRect(candidate_rect.left(), max(0, candidate_rect.top() - metrics.height() - 9), metrics.horizontalAdvance(label) + 14, metrics.height() + 7)
                    painter.setPen(Qt.PenStyle.NoPen)
                    painter.setBrush(QColor(13, 148, 136, 230))
                    painter.drawRoundedRect(label_rect, 4, 4)
                    painter.setPen(QColor("white"))
                    painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)
        finally:
            painter.end()

    def resizeEvent(self, event) -> None:
        layout = self._capture_layout
        if layout is not None and layout.native_geometry is not None:
            # WM_DPICHANGED/resize can arrive after SetWindowPos returns.
            self._capture_layout = ScreenCaptureLayout(QRect(self.geometry()), layout.image_size, (), layout.native_geometry)
        self._invalidate_render_cache()
        super().resizeEvent(event)

    def _source_rect(self, selection: QRect) -> QRect:
        if self.width() <= 0 or self.height() <= 0:
            return QRect()
        if self._capture_layout is not None:
            return self._capture_layout.source_rect_for_logical(selection)
        return QRect(
            round(selection.x() * self._image.width() / self.width()),
            round(selection.y() * self._image.height() / self.height()),
            max(1, round(selection.width() * self._image.width() / self.width())),
            max(1, round(selection.height() * self._image.height() / self.height())),
        ).intersected(self._image.rect())

    def _selection_from_source(self, source: QRect) -> QRect:
        if source.isEmpty() or self._image.isNull() or self._image.width() <= 0 or self._image.height() <= 0:
            return QRect()
        if self._capture_layout is not None:
            return self._capture_layout.logical_rect_for_source(source)
        return QRect(
            round(source.x() * self.width() / self._image.width()),
            round(source.y() * self.height() / self._image.height()),
            max(1, round(source.width() * self.width() / self._image.width())),
            max(1, round(source.height() * self.height() / self._image.height())),
        ).intersected(self.rect())

    def _draw_image(self, painter: QPainter, target: QRect) -> None:
        if self._capture_layout is not None:
            self._capture_layout.draw(painter, self._image, target)
            return
        painter.drawImage(target, self._image, self._source_rect(target))

    def eventFilter(self, watched: QObject, event) -> bool:
        if watched is self._text_editor and event.type() == QEvent.Type.KeyPress and isinstance(event, QKeyEvent):
            if event.key() == Qt.Key.Key_Escape:
                self._cancel_text_annotation()
                self._position_toolbar()
                self.setFocus()
                return True
        if watched is not self._text_editor and event.type() == QEvent.Type.KeyPress and isinstance(event, QKeyEvent):
            if event.key() == Qt.Key.Key_Z and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
                self._undo_annotation()
                return True
            if event.key() == Qt.Key.Key_Escape:
                self.close()
                return True
        if event.type() == QEvent.Type.MouseButtonPress and isinstance(event, QMouseEvent) and event.button() == Qt.MouseButton.RightButton:
            self.close()
            event.accept()
            return True
        return super().eventFilter(watched, event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.RightButton:
            self.close()
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            point = event.position().toPoint()
            self._pointer_position = point
            if self._text_editor is not None and not self._text_editor.geometry().contains(point):
                self._commit_text_annotation()
                self.setFocus()
                event.accept()
                return
            if self._selection.isEmpty() and self._hover_window_candidate is not None:
                selection = self._selection_from_window_candidate(self._hover_window_candidate)
                if not selection.isEmpty():
                    self._set_selection(selection)
                    self._drag_start = point
                    self._candidate_click_pending = True
                    self._selection_move_offset = None
                    self._toolbar.hide()
                    self._text_properties_bar.hide()
                    event.accept()
                    return
            if not self._selection.isEmpty():
                if self._selected_text_annotation is not None:
                    text_handle = self._text_annotation_handle_at(point)
                    if text_handle != ScreenshotSelectionHandle.NONE:
                        self._text_resize_handle = text_handle
                        self._text_resize_start = self._text_annotation_display_rect(self._selected_text_annotation)
                        self._toolbar.hide()
                        self._text_properties_bar.hide()
                        self.setCursor(self._cursor_for_selection_handle(text_handle))
                        event.accept()
                        return
                    text_annotation = self._text_annotation_at(point)
                    if text_annotation is not None:
                        self._text_edit_on_release = text_annotation == self._selected_text_annotation
                        self._select_text_annotation(text_annotation)
                        self._text_move_offset = point - self._text_annotation_display_rect(text_annotation).topLeft()
                        self._text_dragged = False
                        self._toolbar.hide()
                        self._text_properties_bar.hide()
                        event.accept()
                        return
                else:
                    text_annotation = self._text_annotation_at(point)
                    if text_annotation is not None:
                        self._text_edit_on_release = False
                        self._select_text_annotation(text_annotation)
                        self._text_move_offset = point - self._text_annotation_display_rect(text_annotation).topLeft()
                        self._text_dragged = False
                        self._toolbar.hide()
                        self._text_properties_bar.hide()
                        event.accept()
                        return
                handle = self._selection_handle_at(point)
                if handle != ScreenshotSelectionHandle.NONE:
                    self._commit_text_annotation()
                    self._selection_resize_handle = handle
                    self._selection_resize_start = QRect(self._selection)
                    self._toolbar.hide()
                    self._text_properties_bar.hide()
                    self.setCursor(self._cursor_for_selection_handle(handle))
                    event.accept()
                    return
                if self._begin_annotation(point):
                    event.accept()
                    return
                if self._selection.contains(point):
                    self._selection_move_offset = point - self._selection.topLeft()
                    self._toolbar.hide()
                    self._text_properties_bar.hide()
                    event.accept()
                    return
            self._hover_window_candidate = None
            self._drag_start = point
            self._selection_move_offset = None
            self._candidate_click_pending = False
            self._set_selection(QRect(self._drag_start, self._drag_start))
            self._toolbar.hide()
            self._text_properties_bar.hide()
            self._update_color_preview()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        point = event.position().toPoint()
        self._pointer_position = point
        if self._text_resize_handle != ScreenshotSelectionHandle.NONE and event.buttons() & Qt.MouseButton.LeftButton:
            bounds = self._resized_text_annotation_rect(point)
            self._update_selected_text_bounds(bounds)
            event.accept()
            return
        if self._text_move_offset is not None and event.buttons() & Qt.MouseButton.LeftButton and self._selected_text_annotation is not None:
            old_bounds = self._text_annotation_display_rect(self._selected_text_annotation)
            target = point - self._text_move_offset
            target.setX(max(self._selection.left(), min(target.x(), self._selection.right() - old_bounds.width() + 1)))
            target.setY(max(self._selection.top(), min(target.y(), self._selection.bottom() - old_bounds.height() + 1)))
            moved = QRect(target, old_bounds.size())
            if moved.topLeft() != old_bounds.topLeft():
                self._text_dragged = True
                self._update_selected_text_bounds(moved)
            event.accept()
            return
        if self._selection_resize_handle != ScreenshotSelectionHandle.NONE and event.buttons() & Qt.MouseButton.LeftButton:
            self._set_selection(self._resized_selection(point))
            event.accept()
            return
        if self._selection_move_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            point -= self._selection_move_offset
            x = max(0, min(point.x(), self.width() - self._selection.width()))
            y = max(0, min(point.y(), self.height() - self._selection.height()))
            previous = QRect(self._selection)
            self._selection.moveTo(x, y)
            self._update_selection_region(previous)
            self._update_color_preview()
            event.accept()
            return
        if self._active_annotation is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self._update_active_annotation(point)
            event.accept()
            return
        if self._drag_start is not None and event.buttons() & Qt.MouseButton.LeftButton:
            if self._candidate_click_pending and (point - self._drag_start).manhattanLength() <= 4:
                event.accept()
                return
            self._candidate_click_pending = False
            self._hover_window_candidate = None
            self._set_selection(QRect(self._drag_start, point).normalized())
            self._update_color_preview()
            event.accept()
            return
        if not self._selection.isEmpty():
            handle = self._selection_handle_at(point)
            if handle != ScreenshotSelectionHandle.NONE:
                self.setCursor(self._cursor_for_selection_handle(handle))
            elif self._annotation_tool == ScreenshotAnnotationTool.SELECTION and self._selection.contains(point):
                self.setCursor(Qt.CursorShape.SizeAllCursor)
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
        previous_hover = self._hover_window_candidate
        self._update_window_hover(point)
        self._update_color_preview()
        if self._hover_window_candidate != previous_hover:
            self.update()
        event.accept()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._text_resize_handle != ScreenshotSelectionHandle.NONE:
            self._text_resize_handle = ScreenshotSelectionHandle.NONE
            self._position_toolbar()
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._text_move_offset is not None:
            open_editor = self._text_edit_on_release and not self._text_dragged and self._selected_text_annotation is not None
            annotation = self._selected_text_annotation
            self._text_move_offset = None
            self._text_edit_on_release = False
            self._position_toolbar()
            self.setCursor(Qt.CursorShape.ArrowCursor)
            if open_editor and annotation is not None:
                self._start_text_annotation(event.position().toPoint(), annotation)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._selection_resize_handle != ScreenshotSelectionHandle.NONE:
            self._set_selection(self._resized_selection(event.position().toPoint()))
            self._selection_resize_handle = ScreenshotSelectionHandle.NONE
            self._position_toolbar()
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._selection_move_offset is not None:
            self._selection_move_offset = None
            self._position_toolbar()
            self.update(self._selection_paint_bounds(self._selection))
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._active_annotation is not None:
            self._finish_active_annotation(event.position().toPoint())
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._drag_start is not None:
            if not self._candidate_click_pending:
                self._set_selection(QRect(self._drag_start, event.position().toPoint()).normalized())
            self._drag_start = None
            self._complete_selection()
            self._update_color_preview()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._selection.contains(event.position().toPoint()):
            annotation = self._text_annotation_at(event.position().toPoint())
            if annotation is not None:
                self._start_text_annotation(event.position().toPoint(), annotation)
                event.accept()
                return
        super().mouseDoubleClickEvent(event)

    def closeEvent(self, event) -> None:
        self._cancel_text_annotation()
        self._color_tip.close()
        self._color_tip.deleteLater()
        for path in tuple(self._transient_paths):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        self._transient_paths.clear()
        event.accept()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()
            return
        if event.key() == Qt.Key.Key_Z and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._undo_annotation()
            return
        if event.key() == Qt.Key.Key_C and event.modifiers() == Qt.KeyboardModifier.NoModifier:
            self.copy_current_color()
            return
        if event.key() == Qt.Key.Key_A and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._set_selection(self.rect())
            self._complete_selection()
            return
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) or (
            event.key() == Qt.Key.Key_C and event.modifiers() & Qt.KeyboardModifier.ControlModifier
        ):
            self._copy()
            return
        if event.key() == Qt.Key.Key_F2:
            self._send()
            return
        if event.key() == Qt.Key.Key_Comma or event.text() == "<":
            self._show_history(self._history.move(1).index)
            return
        if event.key() == Qt.Key.Key_Period or event.text() == ">":
            self._show_history(self._history.move(-1).index)
            return
        super().keyPressEvent(event)


class PinnedImageWindow(QWidget):
    state_changed = Signal()
    removed = Signal()

    def __init__(
        self,
        image: QImage,
        position: QPoint | None = None,
        display_size: QSize | None = None,
        opacity: float = 1.0,
    ) -> None:
        super().__init__()
        self._source = image.copy()
        self._base_size = display_size if display_size is not None and display_size.isValid() else self.default_display_size(image)
        self._zoom = 1.0
        self._drag_offset: QPoint | None = None
        self._remove_when_closed = True
        self._toolbar = QFrame(self)
        self._image_label = QLabel(self)
        self._configure_window()
        self._configure_layout()
        self._apply_image_size()
        self.setWindowOpacity(max(0.1, min(1.0, opacity)))
        if position is not None:
            self.move(position)

    @staticmethod
    def default_display_size(image: QImage) -> QSize:
        width, height = max(1, image.width()), max(1, image.height())
        scale = min(1.0, 900 / width, 650 / height)
        return QSize(max(1, round(width * scale)), max(1, round(height * scale)))

    def close_for_shutdown(self) -> None:
        self._remove_when_closed = False
        self.close()

    def _configure_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        colors = _screenshot_theme_colors()
        self.setStyleSheet(f"background: {colors['surface']}; border: 1px solid {colors['border']}; border-radius: 8px;")

    def _configure_layout(self) -> None:
        colors = _screenshot_theme_colors()
        self._toolbar.setStyleSheet(f"background: {colors['toolbar']}; border: 0; border-radius: 7px;")
        toolbar_layout = QHBoxLayout(self._toolbar)
        toolbar_layout.setContentsMargins(5, 5, 5, 5)
        toolbar_layout.setSpacing(2)
        for label, callback in (("复制", self._copy), ("保存", self._save), ("关闭", self.close)):
            button = QPushButton(label, self._toolbar)
            button.setStyleSheet("QPushButton { color: white; border: 0; padding: 4px 8px; } QPushButton:hover { background: #334155; border-radius: 5px; }")
            button.clicked.connect(callback)
            toolbar_layout.addWidget(button)
        self._toolbar.hide()
        self._image_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

    def _apply_image_size(self) -> None:
        width = max(1, round(self._base_size.width() * self._zoom))
        height = max(1, round(self._base_size.height() * self._zoom))
        pixmap = QPixmap.fromImage(self._source).scaled(width, height, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.resize(pixmap.size())
        self._image_label.setPixmap(pixmap)
        self._image_label.setGeometry(self.rect())
        self._toolbar.adjustSize()
        self._toolbar.move(max(6, self.width() - self._toolbar.width() - 6), 6)

    def _copy(self) -> None:
        QApplication.clipboard().setImage(self._source)

    def _save(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        target, _ = QFileDialog.getSaveFileName(self, "保存贴图", "贴图.png", "PNG 图片 (*.png)")
        if target:
            self._source.save(target, "PNG")

    def _set_opacity(self, value: float) -> None:
        self.setWindowOpacity(max(0.1, min(1.0, value)))
        self.state_changed.emit()

    def enterEvent(self, event) -> None:
        self._toolbar.show()
        self._toolbar.raise_()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:
        if not self._toolbar.underMouse():
            self._toolbar.hide()
        super().leaveEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self.activateWindow()
            self.setFocus()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            moved = self._drag_offset is not None
            self._drag_offset = None
            if moved:
                self.state_changed.emit()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        self._zoom = max(0.25, min(4.0, self._zoom * (1.1 if event.angleDelta().y() > 0 else 1 / 1.1)))
        self._apply_image_size()
        self.state_changed.emit()
        event.accept()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()
            return
        if event.key() == Qt.Key.Key_C and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._copy()
            return
        super().keyPressEvent(event)

    def contextMenuEvent(self, event: QContextMenuEvent) -> None:
        menu = QMenu(self)
        copy_action = QAction("复制", menu)
        copy_action.triggered.connect(self._copy)
        menu.addAction(copy_action)
        save_action = QAction("保存", menu)
        save_action.triggered.connect(self._save)
        menu.addAction(save_action)
        menu.addSeparator()
        for opacity in (100, 80, 60, 40):
            action = QAction(f"透明度 {opacity}%", menu)
            action.triggered.connect(lambda _checked=False, value=opacity: self._set_opacity(value / 100))
            menu.addAction(action)
        menu.addSeparator()
        close_action = QAction("关闭", menu)
        close_action.triggered.connect(self.close)
        menu.addAction(close_action)
        menu.exec(event.globalPos())

    def closeEvent(self, event) -> None:
        if self._remove_when_closed:
            self.removed.emit()
        event.accept()


class ScreenshotComposer(QDialog):
    send_requested = Signal(str, str)

    def __init__(self, image_path: Path, targets: list[SelectionDeliveryTarget], parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("发送截图")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setModal(False)
        self._image_path = image_path
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview.setMinimumSize(420, 260)
        pixmap = QPixmap(str(image_path))
        if not pixmap.isNull():
            self._preview.setPixmap(pixmap.scaled(720, 480, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        self._target = QComboBox()
        for target in targets:
            self._target.addItem(target.label, target.gateway_id)
        self._text = QPlainTextEdit()
        self._text.setPlaceholderText("输入要和截图一起发送给人格的文字……")
        self._text.setMinimumHeight(80)
        self._error = QLabel()
        self._error.setStyleSheet("color: #b42318;")
        self._error.hide()
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel | QDialogButtonBox.StandardButton.Ok)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("发送")
        buttons.rejected.connect(self.reject)
        buttons.accepted.connect(self._send)
        layout = QVBoxLayout(self)
        layout.addWidget(self._preview)
        layout.addWidget(QLabel("投递至人格"))
        layout.addWidget(self._target)
        layout.addWidget(self._text)
        layout.addWidget(self._error)
        layout.addWidget(buttons)
        self.resize(760, 700)

    @property
    def image_path(self) -> Path:
        return self._image_path

    def set_error(self, message: str) -> None:
        self._error.setText(message)
        self._error.setVisible(bool(message))

    def set_sending(self, sending: bool) -> None:
        self._target.setEnabled(not sending)
        self._text.setEnabled(not sending)

    @Slot()
    def _send(self) -> None:
        gateway_id = str(self._target.currentData() or "").strip()
        if not gateway_id:
            self.set_error("没有可投递的激活人格。")
            return
        self.send_requested.emit(gateway_id, self._text.toPlainText().strip())



class SystemScreenshotController(QObject):
    def __init__(
        self,
        manager: ManagerClient,
        project_root: Path,
        delivery_targets_provider: Callable[[], list[SelectionDeliveryTarget]],
        notify: Callable[[str, str, bool], None],
        settings_path: Path | None = None,
        host_executable: Path | None = None,
        hotkey: WindowsGlobalHotkey | None = None,
        clipboard_hotkey: WindowsGlobalHotkey | None = None,
        extension_registry: DesktopExtensionRegistry | None = None,
        execute_command: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self._manager = manager
        self._project_root = project_root
        self._delivery_targets_provider = delivery_targets_provider
        self._notify = notify
        self._settings_path = settings_path
        self._host_executable = host_executable
        self._hotkey = hotkey or WindowsGlobalScreenshotHotkey()
        self._clipboard_hotkey = clipboard_hotkey or WindowsGlobalClipboardPinHotkey()
        self._desktop_extensions = extension_registry or create_builtin_desktop_extension_registry()
        self._execute_command = execute_command or self._execute_builtin_command
        self._settings = ScreenshotSettings()
        self._plugin_hotkeys: tuple[DesktopPluginHotkey, ...] = ()
        self._plugin_hotkey_instances: dict[tuple[str, str, str], WindowsGlobalHotkey] = {}
        self._reserved_hotkeys = {
            "desktop.capture-screenshot": self._hotkey,
            "desktop.pin-clipboard-image": self._clipboard_hotkey,
        }
        self._settings_task: QtAsyncTask | None = None
        self._window_candidates_task: QtAsyncTask | None = None
        self._capture_save_task: QtAsyncTask | None = None
        self._send_task: QtAsyncTask | None = None
        self._composer: ScreenshotComposer | None = None
        self._capture_overlay: ScreenshotCaptureOverlay | None = None
        self._region_store = ScreenshotRegionStore(project_root)
        self._pin_store = PinnedScreenshotStore(project_root)
        self._pins: dict[PinnedImageWindow, str] = {}
        self._pins_restored = False
        self._started = False
        self._settings_refresh_scheduled = False
        self._settings_retry_scheduled = False
        self._settings_retry_delay_ms = _SETTINGS_RETRY_DELAY_MS
        self._settings_watcher = QFileSystemWatcher(self)
        self._settings_watcher.fileChanged.connect(self._settings_changed)
        self._settings_watcher.directoryChanged.connect(self._settings_changed)
        self._connect_plugin_hotkey(self._hotkey, "desktop.capture-screenshot")
        self._connect_plugin_hotkey(self._clipboard_hotkey, "desktop.pin-clipboard-image")

    def set_plugin_hotkeys(self, items: tuple[DesktopPluginHotkey, ...]) -> None:
        accepted = tuple(item for item in items if self._desktop_extensions.has_hotkey_contract(item))
        accepted_keys = {self._plugin_hotkey_key(item) for item in accepted}
        for key, hotkey_instance in tuple(self._plugin_hotkey_instances.items()):
            if key in accepted_keys:
                continue
            hotkey_instance.configure(False, "")
            if hotkey_instance not in self._reserved_hotkeys.values():
                hotkey_instance.stop()
            self._plugin_hotkey_instances.pop(key, None)
        self._plugin_hotkeys = accepted
        self._apply_hotkey_configuration()

    def _connect_plugin_hotkey(self, hotkey: WindowsGlobalHotkey, handler_id: str) -> None:
        hotkey.activated.connect(lambda target=handler_id: self._execute_command(target))
        if isinstance(hotkey, WindowsGlobalHotkey):
            hotkey.registration_failed.connect(self._notify_hotkey_failure)

    @Slot(str)
    def _notify_hotkey_failure(self, message: str) -> None:
        self._notify("系统快捷键", message, True)

    def _execute_builtin_command(self, handler_id: str) -> None:
        if handler_id == "desktop.capture-screenshot":
            self.request_capture()
        elif handler_id == "desktop.pin-clipboard-image":
            self.request_clipboard_pin()

    @staticmethod
    def _plugin_hotkey_key(item: DesktopPluginHotkey) -> tuple[str, str, str]:
        return item.plugin_id, item.instance_id, item.contribution_id

    def _plugin_hotkey_instance(self, item: DesktopPluginHotkey) -> WindowsGlobalHotkey | None:
        key = self._plugin_hotkey_key(item)
        existing = self._plugin_hotkey_instances.get(key)
        if existing is not None:
            return existing
        reserved = self._reserved_hotkeys.get(item.handler_id)
        if reserved is not None and reserved not in self._plugin_hotkey_instances.values():
            instance = reserved
        else:
            used_ids = {getattr(value, "_hotkey_id", 0) for value in self._plugin_hotkey_instances.values()}
            hotkey_id = _next_plugin_hotkey_id(used_ids)
            if hotkey_id is None:
                return None
            instance = WindowsGlobalHotkey(hotkey_id, f"RabiRoutePluginHotkey:{item.contribution_id}")
            self._connect_plugin_hotkey(instance, item.handler_id)
        self._plugin_hotkey_instances[key] = instance
        return instance

    @Slot()
    def request_capture(self) -> None:
        self._capture_requested()

    @Slot()
    def request_clipboard_pin(self) -> None:
        self._pin_requested()

    def _apply_hotkey_configuration(self) -> None:
        configured: set[WindowsGlobalHotkey] = set()
        for item in self._plugin_hotkeys:
            instance = self._plugin_hotkey_instance(item)
            if instance is None:
                continue
            configured.add(instance)
            instance.configure(
                self._started and self._desktop_extensions.hotkey_enabled(item, self._settings),
                self._desktop_extensions.hotkey_binding(item, self._settings),
            )
        reserved_bindings = {
            self._hotkey: self._settings.shortcut,
            self._clipboard_hotkey: self._settings.clipboard_shortcut,
        }
        for instance in self._reserved_hotkeys.values():
            if instance not in configured:
                instance.configure(False, reserved_bindings.get(instance, ""))

    def start(self) -> None:
        self._started = True
        self._arm_settings_watcher()
        self._restore_pinned_images()
        self._apply_hotkey_configuration()
        self.refresh_settings()

    def stop(self) -> None:
        self._started = False
        for hotkey_instance in set(self._plugin_hotkey_instances.values()) | set(self._reserved_hotkeys.values()):
            hotkey_instance.stop()
        self._plugin_hotkey_instances.clear()
        if self._composer is not None:
            self._composer.close()
            self._composer = None
        if self._capture_overlay is not None:
            self._capture_overlay.close()
            self._capture_overlay = None
        for pin in tuple(self._pins):
            pin.close_for_shutdown()
        self._pins.clear()

    def _arm_settings_watcher(self) -> None:
        current = self._settings_watcher.files() + self._settings_watcher.directories()
        if current:
            self._settings_watcher.removePaths(current)
        if self._settings_path is None:
            return
        paths: list[str] = []
        if self._settings_path.exists():
            paths.append(str(self._settings_path))
        directory = self._settings_path.parent
        while not directory.exists() and directory != directory.parent:
            directory = directory.parent
        if directory.exists():
            paths.append(str(directory))
        if paths:
            self._settings_watcher.addPaths(list(dict.fromkeys(paths)))

    @Slot(str)
    def _settings_changed(self, _path: str) -> None:
        if not self._started:
            return
        self._arm_settings_watcher()
        if self._settings_refresh_scheduled:
            return
        self._settings_refresh_scheduled = True
        QTimer.singleShot(80, self._refresh_settings_after_change)

    @Slot()
    def _refresh_settings_after_change(self) -> None:
        self._settings_refresh_scheduled = False
        if not self._started:
            return
        self._arm_settings_watcher()
        self.refresh_settings()

    def _schedule_settings_retry(self) -> None:
        if not self._started or self._settings_retry_scheduled:
            return
        self._settings_retry_scheduled = True
        QTimer.singleShot(self._settings_retry_delay_ms, self._retry_settings)

    @Slot()
    def _retry_settings(self) -> None:
        self._settings_retry_scheduled = False
        if self._started:
            self.refresh_settings()

    @Slot()
    def refresh_settings(self) -> None:
        if not self._started or self._settings_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
            if not self._started:
                return
            if not isinstance(result, DesktopSettings):
                self._schedule_settings_retry()
                return
            self._settings_retry_scheduled = False
            self._settings = ScreenshotSettings(
                result.screenshot_enabled,
                result.screenshot_shortcut,
                result.screenshot_clipboard_shortcut,
                result.screenshot_auto_copy,
            )
            self._apply_hotkey_configuration()
            if result.autostart_configured:
                try:
                    sync_startup_shortcut(self._project_root, result.autostart, self._host_executable)
                except (OSError, RuntimeError, ValueError) as error:
                    self._notify("RabiRoute 登录启动", str(error), True)

        self._settings_task = start_qt_task(
            self._manager.desktop_settings,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def _capture_requested(self) -> None:
        if not self._settings.enabled or self._capture_overlay is not None:
            return
        # Freeze pixels before constructing widgets or waiting for the shared
        # worker pool. Encoding and window discovery can finish afterwards.
        try:
            image = capture_desktop_image()
            if image.isNull():
                raise RuntimeError("截图像素不可用。")
        except Exception as error:
            self._notify("系统截图", f"截图失败：{error}", True)
            return
        overlay = ScreenshotCaptureOverlay(
            ScreenshotHistory(()),
            region_store=self._region_store,
            auto_copy_on_confirm=self._settings.auto_copy,
            pin_shortcut=self._settings.clipboard_shortcut,
        )
        self._capture_overlay = overlay
        overlay.copy_requested.connect(self._copy_capture_image)
        overlay.pin_requested.connect(self._pin_image)
        overlay.send_requested.connect(self._send_capture_image)
        overlay.color_copy_requested.connect(self._copy_color_text)
        overlay.destroyed.connect(lambda *_: self._clear_capture_overlay(overlay))
        self._capture_image_ready(overlay, image)
        overlay.show()
        overlay.raise_()
        overlay.activateWindow()
        overlay.setFocus(Qt.FocusReason.ActiveWindowFocusReason)
        overlay_handle = int(overlay.winId())
        self._window_candidates_task = start_qt_task(
            lambda: screenshot_window_candidates((overlay_handle,)),
            lambda task, result: self._window_candidates_ready(task, overlay, result),
            on_error=lambda error: error,
        )

    def _window_candidates_ready(self, task: QtAsyncTask, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if self._window_candidates_task is task:
            self._window_candidates_task = None
        if self._capture_overlay is overlay and isinstance(result, tuple):
            overlay.set_window_candidates(tuple(item for item in result if isinstance(item, ScreenshotWindowCandidate)))

    def _capture_image_ready(self, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if not isinstance(result, QImage) or result.isNull():
            if self._capture_overlay is overlay:
                overlay.capture_failed()
                self._notify("系统截图", f"截图失败：{result}", True)
            return
        if self._capture_overlay is not overlay:
            return
        native_geometry = QRect(windows_virtual_screen_origin(), result.size())
        layout = ScreenCaptureLayout(QRect(overlay.geometry()), result.size(), (), native_geometry)
        overlay.set_capture_image(result)
        try:
            overlay.set_capture_layout(layout)
        except RuntimeError as error:
            overlay.capture_failed()
            self._notify("系统截图", str(error), True)
            return
        self._capture_save_task = start_qt_task(
            lambda: save_screenshot_image(self._project_root, result, "capture"),
            lambda save_task, saved: self._capture_image_saved(save_task, overlay, saved),
            on_error=lambda error: error,
        )

    def _capture_image_saved(self, task: QtAsyncTask, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if self._capture_save_task is task:
            self._capture_save_task = None
        if not isinstance(result, Path):
            if self._capture_overlay is overlay:
                overlay.capture_failed()
                self._notify("系统截图", f"截图保存失败：{result}", True)
            return
        if self._capture_overlay is not overlay:
            try:
                result.unlink(missing_ok=True)
            except OSError:
                pass
            return
        if overlay.capture_layout is not None:
            try:
                self._region_store.remember_layout(result, overlay.capture_layout)
            except OSError:
                pass
        overlay.complete_capture(screenshot_history(result), result)

    @Slot()
    def _pin_requested(self) -> None:
        if not self._settings.enabled:
            return
        if self._capture_overlay is not None:
            self._capture_overlay.pin_selection()
            return
        self._pin_clipboard_image()

    def _pin_clipboard_image(self) -> None:
        image = QApplication.clipboard().image()
        if image.isNull():
            self._notify("贴图", "剪贴板中没有图片。", True)
            return
        self._pin_image(image)

    def _clear_capture_overlay(self, overlay: ScreenshotCaptureOverlay) -> None:
        if self._capture_overlay is overlay:
            self._capture_overlay = None

    @Slot(QImage)
    def _copy_capture_image(self, image: QImage) -> None:
        QApplication.clipboard().setImage(image)

    @Slot(str)
    def _copy_color_text(self, value: str) -> None:
        QApplication.clipboard().setText(value)

    @Slot(QImage, QRect)
    def _pin_image(self, image: QImage, origin: QRect | None = None) -> None:
        if image.isNull():
            return
        position = origin.topLeft() if origin is not None and not origin.isEmpty() else QCursor.pos()
        display_size = origin.size() if origin is not None and not origin.isEmpty() else PinnedImageWindow.default_display_size(image)
        try:
            pin = PinnedImageWindow(image, position, display_size)
            record = self._pin_store.create(image, pin.pos(), pin.size(), pin.windowOpacity())
        except Exception as error:
            self._notify("贴图", f"贴图保存失败：{error}", True)
            return
        self._attach_pin(pin, record.pin_id)
        pin.show()
        pin.raise_()
        pin.activateWindow()

    def _restore_pinned_images(self) -> None:
        if self._pins_restored:
            return
        self._pins_restored = True
        for record in self._pin_store.load():
            image = QImage(str(record.image_path))
            if image.isNull():
                continue
            pin = PinnedImageWindow(image, QPoint(record.x, record.y), QSize(record.width, record.height), record.opacity)
            self._attach_pin(pin, record.pin_id)
            pin.show()

    def _attach_pin(self, pin: PinnedImageWindow, pin_id: str) -> None:
        self._pins[pin] = pin_id
        pin.state_changed.connect(lambda: self._save_pin_state(pin, pin_id))
        pin.removed.connect(lambda: self._remove_pin(pin, pin_id))
        pin.destroyed.connect(lambda *_: self._pins.pop(pin, None))

    def _save_pin_state(self, pin: PinnedImageWindow, pin_id: str) -> None:
        if self._pins.get(pin) == pin_id:
            self._pin_store.update(pin_id, pin.pos(), pin.size(), pin.windowOpacity())

    def _remove_pin(self, pin: PinnedImageWindow, pin_id: str) -> None:
        if self._pins.pop(pin, None) == pin_id:
            self._pin_store.delete(pin_id)

    @Slot(QImage)
    def _send_capture_image(self, image: QImage) -> None:
        try:
            image_path = save_screenshot_image(self._project_root, image, "selection")
        except Exception as error:
            self._notify("系统截图", f"截图保存失败：{error}", True)
            return
        self._open_composer(image_path)

    def _open_composer(self, image_path: Path) -> None:
        if self._send_task is not None or self._composer is not None:
            return
        targets = self._delivery_targets_provider()
        if not targets:
            self._notify("系统截图", "当前没有已激活人格，图片已复制或保存。", True)
            return
        composer = ScreenshotComposer(image_path, targets)
        self._composer = composer
        composer.send_requested.connect(self._send_screenshot)
        composer.finished.connect(lambda _result: self._clear_composer(composer))
        composer.show()
        composer.raise_()
        composer.activateWindow()

    def _clear_composer(self, composer: ScreenshotComposer) -> None:
        if self._composer is composer:
            self._composer = None

    @Slot(str, str)
    def _send_screenshot(self, gateway_id: str, text: str) -> None:
        composer = self._composer
        if composer is None or self._send_task is not None:
            return
        try:
            size = composer.image_path.stat().st_size
        except OSError:
            composer.set_error("截图文件已不可用，请重新截图。")
            return
        composer.set_sending(True)
        attachment = {
            "kind": "image",
            "name": composer.image_path.name,
            "path": str(composer.image_path),
            "size": size,
        }

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._send_task is task:
                self._send_task = None
            if not isinstance(result, RolePanelSendResult):
                result = RolePanelSendResult(ok=False, message="未知发送结果")
            if result.ok:
                label = next((target.label for target in self._delivery_targets_provider() if target.gateway_id == gateway_id), gateway_id)
                self._notify("系统截图", f"已投递至 {label}。", False)
                if self._composer is not None:
                    self._composer.accept()
            elif self._composer is not None:
                self._composer.set_sending(False)
                self._composer.set_error(f"投递失败：{result.message or '未知错误'}")

        self._send_task = start_qt_task(
            lambda: self._manager.send_role_panel_message(gateway_id, text, [attachment]),
            completed,
            on_error=lambda error: RolePanelSendResult(ok=False, message=str(error)),
        )
