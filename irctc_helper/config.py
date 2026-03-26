from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
PRESETS_FILE = DATA_DIR / "presets.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
WATCHER_CACHE_FILE = DATA_DIR / "watcher_cache.json"
STATIONS_FILE = DATA_DIR / "stations.json"


@dataclass
class Passenger:
    name: str
    age: int
    gender: str
    berth_preference: str = ""


@dataclass
class TripPreset:
    preset_id: str
    label: str
    from_station: str
    to_station: str
    journey_date: str
    travel_class: str
    quota: str
    train_number: str = ""
    mobile_number: str = ""
    email: str = ""
    passengers: list[Passenger] = field(default_factory=list)
    booking_url: str = ""
    availability_url: str = ""
    availability_keywords: list[str] = field(default_factory=lambda: ["AVAILABLE", "RAC"])

    def to_dict(self) -> dict:
        return asdict(self)


DEFAULT_SETTINGS = {
    "open_time": "10:00",
    "watch_interval_seconds": 60,
    "notify_on_change_only": True,
}


DEFAULT_STATIONS = [
    {"code": "NDLS", "name": "NEW DELHI", "city": "DELHI"},
    {"code": "DLI", "name": "DELHI JN", "city": "DELHI"},
    {"code": "PNBE", "name": "PATNA JN", "city": "PATNA"},
    {"code": "HWH", "name": "HOWRAH JN", "city": "HOWRAH"},
    {"code": "SBC", "name": "KSR BENGALURU", "city": "BENGALURU"},
    {"code": "MAS", "name": "MGR CHENNAI CTL", "city": "CHENNAI"},
    {"code": "CSTM", "name": "MUMBAI CSMT", "city": "MUMBAI"},
    {"code": "MMCT", "name": "MUMBAI CENTRAL", "city": "MUMBAI"},
    {"code": "BCT", "name": "MUMBAI CENTRAL", "city": "MUMBAI"},
    {"code": "LKO", "name": "LUCKNOW NR", "city": "LUCKNOW"},
    {"code": "CNB", "name": "KANPUR CENTRAL", "city": "KANPUR"},
    {"code": "PRYJ", "name": "PRAYAGRAJ JN", "city": "PRAYAGRAJ"},
    {"code": "BBS", "name": "BHUBANESWAR", "city": "BHUBANESWAR"},
    {"code": "PURI", "name": "PURI", "city": "PURI"},
    {"code": "RJPB", "name": "RAJENDRANAGAR T", "city": "PATNA"},
    {"code": "GAYA", "name": "GAYA JN", "city": "GAYA"},
    {"code": "JAT", "name": "JAMMU TAWI", "city": "JAMMU"},
    {"code": "ASR", "name": "AMRITSAR JN", "city": "AMRITSAR"},
    {"code": "LDH", "name": "LUDHIANA JN", "city": "LUDHIANA"},
    {"code": "JP", "name": "JAIPUR", "city": "JAIPUR"},
    {"code": "ADI", "name": "AHMEDABAD JN", "city": "AHMEDABAD"},
    {"code": "BPL", "name": "BHOPAL JN", "city": "BHOPAL"},
    {"code": "NGP", "name": "NAGPUR", "city": "NAGPUR"},
    {"code": "TVC", "name": "THIRUVANANTHAPURAM CENTRAL", "city": "THIRUVANANTHAPURAM"},
    {"code": "ERS", "name": "ERNAKULAM JN", "city": "KOCHI"},
]
