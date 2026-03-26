from __future__ import annotations

import threading
import time
import webbrowser
from datetime import datetime

from .notifier import notify
from .storage import load_presets, load_settings


class BookingScheduler:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._last_open_date: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _run(self) -> None:
        while not self._stop_event.is_set():
            settings = load_settings()
            presets = load_presets()
            now = datetime.now()
            open_time = settings.get("open_time", "10:00")

            if now.strftime("%H:%M") == open_time and self._last_open_date != now.strftime("%Y-%m-%d"):
                for preset in presets:
                    url = preset.get("booking_url")
                    if url:
                        webbrowser.open(url)
                notify("IRCTC Helper", f"Booking pages opened for {len(presets)} preset(s).")
                self._last_open_date = now.strftime("%Y-%m-%d")

            time.sleep(1)
