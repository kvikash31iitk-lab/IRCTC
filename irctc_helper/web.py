from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, url_for

from .browser_helper import launch_prefill
from .scheduler import BookingScheduler
from .station_catalog import search_stations
from .storage import load_presets, load_settings, save_presets, save_settings
from .watcher import AvailabilityWatcher


booking_scheduler = BookingScheduler()
availability_watcher = AvailabilityWatcher()
USER_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "tampermonkey" / "irctc-helper.user.js"


def _delete_preset_by_id(preset_id: str) -> bool:
    presets = load_presets()
    remaining = [item for item in presets if item["preset_id"] != preset_id]
    if len(remaining) == len(presets):
        return False

    save_presets(remaining)
    return True


def _cors_json(payload: Any, status: int = 200) -> Any:
    response = jsonify(payload)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response, status


def _find_preset_by_id(preset_id: str) -> dict[str, Any] | None:
    return next((item for item in load_presets() if item["preset_id"] == preset_id), None)


def _build_preset_payload(form: Any, preset_id: str) -> dict[str, Any]:
    passengers = _extract_passengers(form)
    return {
        "preset_id": preset_id,
        "label": form["label"],
        "from_station": form["from_station"],
        "to_station": form["to_station"],
        "journey_date": form["journey_date"],
        "travel_class": form["travel_class"],
        "quota": form["quota"],
        "train_number": form.get("train_number", ""),
        "mobile_number": form.get("mobile_number", ""),
        "email": form.get("email", ""),
        "booking_url": form.get("booking_url", ""),
        "availability_url": form.get("availability_url", ""),
        "availability_keywords": [
            keyword.strip()
            for keyword in form.get("availability_keywords", "").split(",")
            if keyword.strip()
        ],
        "is_default": form.get("is_default") == "on",
        "passengers": passengers,
    }


def _clear_other_defaults(presets: list[dict], keep_id: str) -> None:
    """Ensure only one preset is marked as default."""
    for preset in presets:
        if preset["preset_id"] != keep_id:
            preset["is_default"] = False


def create_app() -> Flask:
    app = Flask(__name__)
    booking_scheduler.start()
    availability_watcher.start()

    @app.route("/")
    def index() -> str:
        return render_template(
            "index.html",
            presets=load_presets(),
            settings=load_settings(),
        )

    @app.get("/api/presets")
    def list_presets() -> Any:
        response = jsonify(load_presets())
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.get("/api/presets/<preset_id>")
    def get_preset(preset_id: str) -> Any:
        preset = _find_preset_by_id(preset_id)
        if preset is None:
            return jsonify({"error": "Preset not found"}), 404

        response = jsonify(preset)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.delete("/api/presets/<preset_id>")
    def delete_preset_api(preset_id: str) -> Any:
        if not _delete_preset_by_id(preset_id):
            return _cors_json({"error": "Preset not found"}, 404)

        return _cors_json({"ok": True, "deleted_preset_id": preset_id})

    @app.get("/api/stations")
    def list_stations() -> Any:
        query = request.args.get("q", "")
        response = jsonify(search_stations(query))
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.get("/tampermonkey/irctc-helper.user.js")
    def tampermonkey_script() -> Any:
        if not USER_SCRIPT_PATH.exists():
            abort(404)

        response = Response(USER_SCRIPT_PATH.read_text(encoding="utf-8"), mimetype="text/javascript")
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    @app.post("/presets")
    def create_preset() -> Any:
        presets = load_presets()
        new_preset = _build_preset_payload(request.form, str(uuid.uuid4())[:8])
        if new_preset.get("is_default"):
            _clear_other_defaults(presets, new_preset["preset_id"])
        presets.append(new_preset)
        save_presets(presets)
        return redirect(url_for("index"))

    @app.get("/presets/<preset_id>/edit")
    def edit_preset_form(preset_id: str) -> Any:
        preset = _find_preset_by_id(preset_id)
        if preset is None:
            abort(404)

        return render_template("edit_preset.html", preset=preset)

    @app.post("/presets/<preset_id>")
    def update_preset(preset_id: str) -> Any:
        presets = load_presets()
        preset_index = next((index for index, item in enumerate(presets) if item["preset_id"] == preset_id), None)
        if preset_index is None:
            abort(404)

        updated = _build_preset_payload(request.form, preset_id)
        if updated.get("is_default"):
            _clear_other_defaults(presets, preset_id)
        presets[preset_index] = updated
        save_presets(presets)
        return redirect(url_for("index"))

    @app.post("/settings")
    def update_settings() -> Any:
        save_settings(
            {
                "open_time": request.form.get("open_time", "10:00"),
                "watch_interval_seconds": int(request.form.get("watch_interval_seconds", 60)),
                "notify_on_change_only": request.form.get("notify_on_change_only") == "on",
            }
        )
        return redirect(url_for("index"))

    @app.post("/prefill/<preset_id>")
    def prefill(preset_id: str) -> Any:
        threading.Thread(target=launch_prefill, args=(preset_id, None), daemon=True).start()
        return redirect(url_for("index"))

    @app.post("/presets/<preset_id>/delete")
    def delete_preset(preset_id: str) -> Any:
        _delete_preset_by_id(preset_id)
        return redirect(url_for("index"))

    return app


def _extract_passengers(form: Any) -> list[dict]:
    passengers = []
    for index in range(1, 7):
        name = form.get(f"passenger_name_{index}", "").strip()
        age = form.get(f"passenger_age_{index}", "").strip()
        gender = form.get(f"passenger_gender_{index}", "").strip()
        berth = form.get(f"passenger_berth_{index}", "").strip()

        if not name:
            continue

        passengers.append(
            {
                "name": name,
                "age": int(age or 0),
                "gender": gender,
                "berth_preference": berth,
            }
        )
    return passengers
