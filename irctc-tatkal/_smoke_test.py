"""Throwaway smoke test — exercises every module without opening a browser."""

import threading
import time
from datetime import date, timedelta

import timing
import presets
import engine
import gui

# --- timing: landing precision -------------------------------------------
ts = timing.TimeSync()
target = ts.now_ist() + timedelta(seconds=0.4)
res = timing.wait_until(target, ts.now_ist)
err_ms = abs((ts.now_ist() - target).total_seconds()) * 1000
assert res == "reached", res
print(f"[1] wait_until reached target, landing error {err_ms:.2f} ms")
assert err_ms < 15, f"landing error too big: {err_ms} ms"

# --- timing: FIRE NOW interrupt -------------------------------------------
ev = threading.Event()
threading.Timer(0.15, ev.set).start()
t0 = time.perf_counter()
res = timing.wait_until(ts.now_ist() + timedelta(seconds=5), ts.now_ist,
                        stop_events={"fire": ev})
dt = time.perf_counter() - t0
assert res == "fire" and dt < 1.0, (res, dt)
print(f"[2] stop_events interrupt works ({dt * 1000:.0f} ms latency)")

# --- timing: next_occurrence rolls to tomorrow -----------------------------
past_hour = (ts.now_ist() - timedelta(hours=1)).hour
nxt = ts.next_occurrence(past_hour)
assert nxt > ts.now_ist()
print(f"[3] next_occurrence({past_hour}:00) -> {nxt.isoformat()}")

# --- presets ----------------------------------------------------------------
ps = presets.load_presets()
assert ps and ps[0]["train_number"] == "12312", ps
assert presets.get_default_preset()["preset_id"] == "6be5202f"
print(f"[4] presets ok: '{ps[0]['label']}' with {len(ps[0]['passengers'])} passenger(s)")

# --- bundled IRCTC station list (backs the preset station pickers) ----------
sts = presets.load_stations()
assert len(sts) > 1000 and "NEW DELHI - NDLS" in sts, f"stations look wrong: {len(sts)}"
assert "OLD DELHI - DLI" in sts and "KANPUR CENTRAL - CNB" in sts
print(f"[4b] station list loaded: {len(sts)} IRCTC stations")

# --- real NTP sync (network) ------------------------------------------------
ok = ts.sync()
if ok:
    print(f"[5] NTP synced: offset {ts.offset.total_seconds():+.3f}s, "
          f"round-trip {ts.last_delay * 1000:.0f} ms")
else:
    print("[5] NTP sync failed (UDP 123 blocked?) — graceful fallback confirmed")

# --- engine constructs; date-label patterns ---------------------------------
be = engine.BookingEngine(ps[0], date(2026, 6, 13),
                          ts.now_ist() + timedelta(hours=1), ts,
                          engine.EngineCallbacks())
pats = be._date_label_patterns()
assert pats[0] == "Sat, 13 Jun", pats
assert be._split_station("NEW DELHI - NDLS") == ("NEW DELHI", "NDLS")
print(f"[6] engine ok: date patterns {pats}")

# --- full GUI build (window withdrawn, no browser) ---------------------------
import tkinter as tk

root = tk.Tk()
root.withdraw()
app = gui.App(root, preset_query="kanpur", cli_hour=None)
for _ in range(25):  # pump events so the NTP thread + clock ticks run
    root.update()
    time.sleep(0.1)
assert "kanpur" in app.preset_box.get().lower()
assert app.date_entry.get() == "2026-04-09"
assert app.window_box.current() == 1  # SL class -> 11:00 suggested
print(f"[7] GUI built. NTP label: {app.ntp_var.get()!r}")
print(f"    IST clock: {app.ist_var.get()!r}")
app._quick_date(1)
print(f"    Today+1 button -> {app.date_entry.get()}")

# --- preset editor dialog: populate, collect, validate -----------------------
dlg = gui.PresetDialog(root, preset=ps[0])
root.update()
collected = dlg._collect()
assert collected["train_number"] == "12312"
assert collected["travel_class"] == "SL"
assert collected["passengers"][0] == {
    "name": "vikash kumar", "age": 38, "gender": "Male", "berth_preference": "Lower"}
assert collected["preset_id"] == ps[0]["preset_id"]  # edit keeps identity
dlg.destroy()
print("[8] preset dialog round-trips the existing preset")

dlg2 = gui.PresetDialog(root)
root.update()
dlg2.label_var.set("test")
dlg2.from_var.set("DELHI - DLI")
dlg2.to_var.set("KANPUR CENTRAL - CNB")
dlg2.train_var.set("123")  # invalid on purpose
try:
    dlg2._collect()
    raise AssertionError("expected ValueError for a 3-digit train number")
except ValueError as exc:
    print(f"[9] dialog validation works: {exc}")
dlg2.destroy()

root.destroy()

print("ALL SMOKE TESTS PASSED")
