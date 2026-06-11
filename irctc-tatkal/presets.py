"""Preset storage for the tatkal booker.

Schema is kept byte-compatible with the existing Flask helper's
``data/presets.json`` so the two tools can share the same file (and so it can
be synced between the user's home and office PCs). All paths are resolved
relative to this file's directory — no absolute paths — for portability.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"
PRESETS_PATH = DATA_DIR / "presets.json"

# Seeded if presets.json is missing, so the tool runs out of the box.
_SEED_PRESET: dict[str, Any] = {
    "preset_id": "6be5202f",
    "label": "vikash kanpur",
    "from_station": "NEW DELHI - NDLS",
    "to_station": "KANPUR CENTRAL - CNB",
    "journey_date": "2026-04-09",
    "travel_class": "SL",
    "quota": "TATKAL",
    "train_number": "12312",
    "mobile_number": "9830170806",
    "email": "kvikash31.iitk@gmail.com",
    "booking_url": "",
    "availability_url": "",
    "availability_keywords": ["AVAILABLE", "RAC"],
    "is_default": True,
    "passengers": [
        {"name": "vikash kumar", "age": 38, "gender": "Male", "berth_preference": "Lower"}
    ],
}


def load_presets() -> list[dict[str, Any]]:
    """Return all presets, seeding the file on first run."""
    if not PRESETS_PATH.exists():
        save_presets([_SEED_PRESET])
        return [dict(_SEED_PRESET)]

    try:
        data = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    return data if isinstance(data, list) else []


def save_presets(presets: list[dict[str, Any]]) -> None:
    """Persist the full preset list (pretty-printed, UTF-8)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PRESETS_PATH.write_text(json.dumps(presets, indent=2, ensure_ascii=False), encoding="utf-8")


def save_preset(preset: dict[str, Any]) -> dict[str, Any]:
    """Insert or update one preset (matched by ``preset_id``).

    Generates an id when missing and enforces a single default. Returns the
    stored preset (with its id populated).
    """
    preset = dict(preset)
    if not preset.get("preset_id"):
        preset["preset_id"] = uuid.uuid4().hex[:8]

    presets = load_presets()
    if preset.get("is_default"):
        for other in presets:
            other["is_default"] = False

    for index, existing in enumerate(presets):
        if existing.get("preset_id") == preset["preset_id"]:
            presets[index] = preset
            break
    else:
        presets.append(preset)

    save_presets(presets)
    return preset


def delete_preset(preset_id: str) -> bool:
    """Remove one preset; returns True if something was deleted."""
    presets = load_presets()
    remaining = [p for p in presets if p.get("preset_id") != preset_id]
    if len(remaining) == len(presets):
        return False
    save_presets(remaining)
    return True


def get_preset(preset_id: str) -> dict[str, Any] | None:
    return next((p for p in load_presets() if p.get("preset_id") == preset_id), None)


def get_default_preset() -> dict[str, Any] | None:
    """The preset flagged default, or the first one, or None if empty."""
    presets = load_presets()
    if not presets:
        return None
    return next((p for p in presets if p.get("is_default")), presets[0])


def set_journey_date(preset_id: str, journey_date: str) -> dict[str, Any] | None:
    """Update just the journey date (the field that changes every booking).

    ``journey_date`` is expected as ISO ``YYYY-MM-DD``.
    """
    preset = get_preset(preset_id)
    if preset is None:
        return None
    preset["journey_date"] = journey_date
    return save_preset(preset)
