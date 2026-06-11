"""NTP-synced timing for precise tatkal firing.

The system clock on a laptop can drift by seconds — fatal when the tatkal
window is a 2-3 second race. This module measures the offset between the
local clock and true UTC (via public NTP servers) and exposes an IST clock
that is corrected by that offset, plus a high-resolution ``wait_until`` that
coasts on low CPU when the target is far away and tight-spins the final
moments for millisecond accuracy.

IST has no daylight saving and is permanently UTC+5:30, so we use a fixed
offset instead of a tz database — this avoids the ``tzdata`` dependency that
``zoneinfo`` needs on Windows.
"""

from __future__ import annotations

import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Mapping

try:
    import ntplib
except ImportError:  # Keep the module importable before deps are installed.
    ntplib = None  # type: ignore[assignment]

IST = timezone(timedelta(hours=5, minutes=30), "IST")

# Windows sleeps in ~15.6 ms quanta by default — useless for a 1 ms-resolution
# wait. timeBeginPeriod(1) drops the scheduler quantum to 1 ms process-wide.
if sys.platform == "win32":
    try:
        import ctypes

        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass

# Public NTP pool hosts, tried in order until one answers.
NTP_HOSTS = ("time.google.com", "pool.ntp.org", "time.cloudflare.com", "in.pool.ntp.org")


class TimeSync:
    """Holds the measured offset between the local clock and true UTC.

    ``offset`` is a timedelta to ADD to the local clock to get true time.
    Until :meth:`sync` succeeds, the offset is zero (i.e. trust the system
    clock) and ``synced`` is False.
    """

    def __init__(self) -> None:
        self.offset: timedelta = timedelta(0)
        self.synced: bool = False
        self.last_delay: float | None = None  # Round-trip of the chosen sample.

    def sync(self, samples: int = 5, timeout: float = 2.0) -> bool:
        """Query NTP several times; keep the offset from the lowest-latency
        sample (lowest round-trip delay == most accurate). Returns True on
        success, False if no server answered (offset left unchanged).
        """
        if ntplib is None:
            return False

        client = ntplib.NTPClient()
        best: tuple[float, float] | None = None  # (delay, offset)

        for _ in range(max(1, samples)):
            for host in NTP_HOSTS:
                try:
                    resp = client.request(host, version=3, timeout=timeout)
                except Exception:
                    continue
                if best is None or resp.delay < best[0]:
                    best = (resp.delay, resp.offset)
                break  # Got one host this round; move to next sample.

        if best is None:
            return False

        self.last_delay = best[0]
        self.offset = timedelta(seconds=best[1])
        self.synced = True
        return True

    def now_utc(self) -> datetime:
        """True UTC now, corrected by the NTP offset."""
        return datetime.now(timezone.utc) + self.offset

    def now_ist(self) -> datetime:
        """True IST now, corrected by the NTP offset."""
        return self.now_utc().astimezone(IST)

    def target_today(self, hour: int, minute: int = 0, second: int = 0) -> datetime:
        """Build today's tatkal instant in IST (e.g. 10:00:00 today).

        Uses the NTP-corrected date so it is right even near midnight.
        """
        today = self.now_ist().date()
        return datetime(today.year, today.month, today.day, hour, minute, second, tzinfo=IST)

    def next_occurrence(self, hour: int, minute: int = 0, second: int = 0) -> datetime:
        """Today's ``hour:minute:second`` IST if still ahead, else tomorrow's."""
        target = self.target_today(hour, minute, second)
        if target <= self.now_ist():
            target += timedelta(days=1)
        return target


def wait_until(
    target: datetime,
    now_func: Callable[[], datetime],
    on_tick: Callable[[float], None] | None = None,
    tick_interval: float = 0.1,
    stop_events: Mapping[str, threading.Event] | None = None,
) -> str:
    """Block until ``now_func()`` reaches ``target``.

    Coasts at low CPU when far from the target and progressively tightens,
    tight-spinning only the final ~20 ms so the return lands within a couple
    of milliseconds of the target. ``on_tick(seconds_remaining)`` is called at
    most every ``tick_interval`` seconds for a live countdown; ``remaining``
    is negative-free (clamped at 0 on the final tick).

    ``stop_events`` maps names to events that abort the wait early (e.g. a
    FIRE NOW button or a cancel flag). Returns ``"reached"`` when the target
    time arrived, or the name of whichever event was set first.
    """
    target_ts = target.timestamp()
    last_tick = float("inf")
    stop_events = stop_events or {}

    def check_events() -> str | None:
        for name, event in stop_events.items():
            if event.is_set():
                return name
        return None

    while True:
        if (hit := check_events()) is not None:
            return hit

        remaining = target_ts - now_func().timestamp()

        if on_tick is not None and (last_tick - remaining >= tick_interval or remaining <= 0):
            on_tick(max(0.0, remaining))
            last_tick = remaining

        if remaining <= 0:
            return "reached"

        if remaining > 5:
            time.sleep(0.2)
        elif remaining > 1:
            time.sleep(0.02)
        elif remaining > 0.02:
            time.sleep(0.002)
        else:
            # Final stretch: tight spin for millisecond accuracy.
            while target_ts - now_func().timestamp() > 0:
                if (hit := check_events()) is not None:
                    return hit
            if on_tick is not None:
                on_tick(0.0)
            return "reached"
