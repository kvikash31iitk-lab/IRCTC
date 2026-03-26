from __future__ import annotations

import threading
import time

import requests
from bs4 import BeautifulSoup

from .notifier import notify
from .storage import load_presets, load_settings, load_watcher_cache, save_watcher_cache


class AvailabilityWatcher:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

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
            cache = load_watcher_cache()

            for preset in load_presets():
                preset_id = preset["preset_id"]
                url = preset.get("availability_url")
                keywords = [word.upper() for word in preset.get("availability_keywords", [])]

                if not url or not keywords:
                    continue

                try:
                    response = requests.get(
                        url,
                        timeout=15,
                        headers={
                            "User-Agent": "Mozilla/5.0 (compatible; IRCTC-Helper/1.0)",
                        },
                    )
                    response.raise_for_status()
                    page_text = BeautifulSoup(response.text, "html.parser").get_text(" ", strip=True).upper()
                except Exception as exc:
                    cache[preset_id] = {"status": f"error: {exc}"}
                    continue

                matched = [keyword for keyword in keywords if keyword in page_text]
                previous = cache.get(preset_id, {}).get("matched", [])

                if matched and (matched != previous or not settings.get("notify_on_change_only", True)):
                    notify(
                        "Availability watcher",
                        f"{preset['label']}: matched {', '.join(matched)}",
                    )

                cache[preset_id] = {"matched": matched}

            save_watcher_cache(cache)
            time.sleep(int(settings.get("watch_interval_seconds", 60)))
