from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import (
    DATA_DIR,
    DEFAULT_SETTINGS,
    DEFAULT_STATIONS,
    PRESETS_FILE,
    SETTINGS_FILE,
    STATIONS_FILE,
    WATCHER_CACHE_FILE,
)


def _ensure_file(path: Path, default: Any) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(json.dumps(default, indent=2), encoding="utf-8")


def load_json(path: Path, default: Any) -> Any:
    _ensure_file(path, default)
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        save_json(path, default)
        return default

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        save_json(path, default)
        return default


def save_json(path: Path, data: Any) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_presets() -> list[dict]:
    return load_json(PRESETS_FILE, [])


def save_presets(presets: list[dict]) -> None:
    save_json(PRESETS_FILE, presets)


def load_settings() -> dict:
    settings = load_json(SETTINGS_FILE, DEFAULT_SETTINGS)
    merged = {**DEFAULT_SETTINGS, **settings}
    if merged != settings:
        save_json(SETTINGS_FILE, merged)
    return merged


def save_settings(settings: dict) -> None:
    save_json(SETTINGS_FILE, settings)


def load_watcher_cache() -> dict:
    return load_json(WATCHER_CACHE_FILE, {})


def save_watcher_cache(cache: dict) -> None:
    save_json(WATCHER_CACHE_FILE, cache)


def load_stations() -> list[dict]:
    stations = load_json(STATIONS_FILE, DEFAULT_STATIONS)
    if stations != DEFAULT_STATIONS and not isinstance(stations, list):
        save_json(STATIONS_FILE, DEFAULT_STATIONS)
        return DEFAULT_STATIONS
    return stations
