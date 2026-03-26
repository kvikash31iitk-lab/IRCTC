from __future__ import annotations

import threading
import uuid
from typing import Any

from flask import Flask, jsonify, redirect, render_template, request, url_for

from .browser_helper import launch_prefill
from .scheduler import BookingScheduler
from .station_catalog import search_stations
from .storage import load_presets, load_settings, save_presets, save_settings
from .watcher import AvailabilityWatcher


booking_scheduler = BookingScheduler()
availability_watcher = AvailabilityWatcher()


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
        preset = next((item for item in load_presets() if item["preset_id"] == preset_id), None)
        if preset is None:
            return jsonify({"error": "Preset not found"}), 404

        response = jsonify(preset)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.get("/api/stations")
    def list_stations() -> Any:
        query = request.args.get("q", "")
        response = jsonify(search_stations(query))
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.post("/presets")
    def create_preset() -> Any:
        presets = load_presets()
        passengers = _extract_passengers(request.form)

        presets.append(
            {
                "preset_id": str(uuid.uuid4())[:8],
                "label": request.form["label"],
                "from_station": request.form["from_station"],
                "to_station": request.form["to_station"],
                "journey_date": request.form["journey_date"],
                "travel_class": request.form["travel_class"],
                "quota": request.form["quota"],
                "train_number": request.form.get("train_number", ""),
                "mobile_number": request.form.get("mobile_number", ""),
                "email": request.form.get("email", ""),
                "booking_url": request.form.get("booking_url", ""),
                "availability_url": request.form.get("availability_url", ""),
                "availability_keywords": [
                    keyword.strip()
                    for keyword in request.form.get("availability_keywords", "").split(",")
                    if keyword.strip()
                ],
                "passengers": passengers,
            }
        )
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

    return app


def _extract_passengers(form: Any) -> list[dict]:
    passengers = []
    for index in range(1, 5):
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
