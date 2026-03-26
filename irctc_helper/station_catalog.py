from __future__ import annotations

from .storage import load_stations


def format_station(station: dict) -> str:
    name = station.get("name", "").strip()
    code = station.get("code", "").strip()
    city = station.get("city", "").strip()
    label = f"{name} - {code}" if name and code else name or code
    if city and city.upper() not in name.upper():
        return f"{label} ({city})"
    return label


def search_stations(query: str, limit: int = 8) -> list[dict]:
    normalized = query.strip().lower()
    if not normalized:
        return []

    ranked = []
    for station in load_stations():
        name = station.get("name", "")
        code = station.get("code", "")
        city = station.get("city", "")
        haystack = " ".join([name, code, city]).lower()
        label = format_station(station)

        if normalized not in haystack:
            continue

        score = 0
        if code.lower().startswith(normalized):
            score += 4
        if name.lower().startswith(normalized):
            score += 3
        if city.lower().startswith(normalized):
            score += 2
        if normalized in code.lower():
            score += 2
        if normalized in name.lower():
            score += 1

        ranked.append(
            {
                "code": code,
                "name": name,
                "city": city,
                "label": label,
                "score": score,
            }
        )

    ranked.sort(key=lambda item: (-item["score"], item["name"], item["code"]))
    return ranked[:limit]
