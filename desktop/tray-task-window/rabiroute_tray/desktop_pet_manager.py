from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QMenu

from .desktop_pet_client import DesktopPetPersona, DesktopPetRosterClient
from .desktop_pet_controller import DesktopPetController
from .desktop_pet_events import DesktopPetEventStream
from .qt_async import QtAsyncTask, start_qt_task


class DesktopPetManager(QObject):
    """Keeps the Qt windows equal to the Manager-owned enabled persona bindings."""

    def __init__(
        self,
        manager_url: str,
        menu: QMenu,
        open_persona: Callable[[str], None],
    ) -> None:
        super().__init__()
        self._manager_url = manager_url
        self._menu = menu
        self._open_persona = open_persona
        self._client = DesktopPetRosterClient(manager_url)
        self._events = DesktopPetEventStream(manager_url)
        self._events.settings_changed.connect(lambda _payload: self.refresh())
        self._events.connection_changed.connect(self._connection_changed)
        self._refresh_task: QtAsyncTask | None = None
        self._refresh_pending = False
        self._closed = False
        self._controllers: dict[str, DesktopPetController] = {}
        self._roster: dict[str, DesktopPetPersona] = {}
        self._loading = True
        self._load_error = ""
        self._retry_delay_ms = 1000
        self._retry_timer = QTimer(self)
        self._retry_timer.setSingleShot(True)
        self._retry_timer.timeout.connect(self.refresh)
        self._rebuild_menu()
        self._events.start()
        self.refresh()

    @property
    def controllers(self) -> dict[str, DesktopPetController]:
        return dict(self._controllers)

    def refresh(self) -> None:
        if self._closed:
            return
        if self._refresh_task is not None:
            self._refresh_pending = True
            return

        self._retry_timer.stop()
        self._loading = True
        self._load_error = ""
        self._rebuild_menu()

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._refresh_task is not task:
                return
            self._refresh_task = None
            if self._closed:
                self._refresh_pending = False
                return
            self._loading = False
            try:
                if isinstance(result, Exception):
                    raise result
                if not isinstance(result, tuple):
                    raise TypeError("Invalid desktop pet roster response")
                self._apply_roster(result)
                self._retry_delay_ms = 1000
            except Exception as error:
                # A failed request is not an authoritative empty roster.
                self._load_error = type(error).__name__
                self._retry_timer.start(self._retry_delay_ms)
                self._retry_delay_ms = min(self._retry_delay_ms * 2, 30000)
            self._rebuild_menu()
            if self._refresh_pending:
                self._refresh_pending = False
                self.refresh()

        self._refresh_task = start_qt_task(
            self._client.roster,
            completed,
            on_error=lambda error: error,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._retry_timer.stop()
        self._loading = False
        self._load_error = ""
        self._events.stop()
        for controller in tuple(self._controllers.values()):
            controller.close()
        self._controllers.clear()
        self._roster.clear()
        self._rebuild_menu()

    def _connection_changed(self, connected: bool) -> None:
        if connected:
            self.refresh()

    def _apply_roster(self, roster: tuple[DesktopPetPersona, ...]) -> None:
        next_roster = {item.persona_id: item for item in roster}
        for persona_id in tuple(self._controllers):
            if persona_id not in next_roster:
                self._controllers.pop(persona_id).close()

        for slot, item in enumerate(roster):
            controller = self._controllers.get(item.persona_id)
            if controller is None:
                controller = DesktopPetController(
                    self._manager_url,
                    item.persona_id,
                    self._open_persona,
                    persona_name=item.name,
                    initial_binding=item.binding,
                    event_stream=self._events,
                    default_slot=slot,
                )
                controller.visibility_changed.connect(lambda _visible: self._rebuild_menu())
                self._controllers[item.persona_id] = controller
            else:
                controller.update_persona(item.name, item.binding)

        self._roster = next_roster
        self._rebuild_menu()

    def _rebuild_menu(self) -> None:
        self._menu.clear()
        if self._loading:
            self._menu.addAction("正在加载虚拟形象…").setEnabled(False)
        elif self._load_error:
            self._menu.addAction(f"虚拟形象加载失败（{self._load_error}），将自动重试").setEnabled(False)
            self._menu.addAction("重试加载", self.refresh)
        if not self._controllers and (self._loading or self._load_error):
            return
        if not self._controllers:
            empty = self._menu.addAction("没有启用的虚拟形象")
            empty.setEnabled(False)
            return

        count = self._menu.addAction(f"已启用 {len(self._controllers)} 个虚拟形象")
        count.setEnabled(False)
        self._menu.addSeparator()
        for persona_id, controller in self._controllers.items():
            submenu = self._menu.addMenu(controller.persona_name)
            submenu.addAction(
                "打开人格配置",
                lambda _checked=False, selected=persona_id: self._open_persona(selected),
            )
            submenu.addAction("隐藏桌宠", controller.hide)
