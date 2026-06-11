"""Tkinter GUI for the tatkal booker.

Four screens (setup → countdown → captcha → result) over a shared status log.
The Playwright engine runs on its own thread; every callback it makes is
marshalled onto the Tk main loop with ``root.after`` — no widget is ever
touched from the engine thread.
"""

from __future__ import annotations

import io
import re
import threading
import time
import tkinter as tk
from datetime import datetime, timedelta
from tkinter import messagebox, ttk
from typing import Any

from PIL import Image, ImageTk

import presets as preset_store
from engine import BookingEngine, EngineCallbacks
from timing import TimeSync

AC_CLASSES = {"1A", "2A", "3A", "3E", "CC", "EC", "EA", "EV"}
WINDOW_CHOICES = (
    "10:00 AM IST — AC classes (1A 2A 3A CC EC 3E)",
    "11:00 AM IST — Non-AC classes (SL 2S FC)",
)

# Choices offered by the preset editor form.
CLASS_CODES = ("SL", "3A", "2A", "1A", "CC", "EC", "3E", "2S")
QUOTAS = ("TATKAL", "PREMIUM TATKAL", "GENERAL")
GENDERS = ("Male", "Female", "Transgender")
BERTHS = ("Lower", "Middle", "Upper", "Side Lower", "Side Upper", "Window Side")
NO_BERTH = "No preference"
MAX_PASSENGERS = 6  # IRCTC's per-booking limit

FONT_BASE = ("Segoe UI", 10)
FONT_BOLD = ("Segoe UI", 10, "bold")
FONT_BIG = ("Segoe UI", 13, "bold")
FONT_CLOCK = ("Consolas", 44, "bold")
FONT_MONO = ("Consolas", 9)


class App:
    def __init__(self, root: tk.Tk, preset_query: str | None = None,
                 cli_hour: int | None = None) -> None:
        self.root = root
        self.tsync = TimeSync()
        self.engine: BookingEngine | None = None
        self.presets = preset_store.load_presets()
        self._cli_hour = cli_hour

        root.title("IRCTC Tatkal Booker")
        root.geometry("780x680")
        root.minsize(700, 600)
        root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Screen container (all screens stacked; tkraise switches).
        container = ttk.Frame(root)
        container.pack(fill="both", expand=True)
        container.rowconfigure(0, weight=1)
        container.columnconfigure(0, weight=1)
        self.screens: dict[str, ttk.Frame] = {}
        for name, builder in (
            ("setup", self._build_setup),
            ("countdown", self._build_countdown),
            ("captcha", self._build_captcha),
            ("result", self._build_result),
        ):
            frame = ttk.Frame(container, padding=14)
            frame.grid(row=0, column=0, sticky="nsew")
            self.screens[name] = frame
            builder(frame)

        self._build_log(root)
        self.show("setup")
        self._select_initial_preset(preset_query)
        self._start_ntp_sync()
        self._tick_clock()

    # ------------------------------------------------------------------
    # Cross-thread plumbing
    # ------------------------------------------------------------------

    def ui(self, fn, *args) -> None:
        """Run ``fn(*args)`` on the Tk main thread (engine callbacks use this)."""
        try:
            self.root.after(0, lambda: fn(*args))
        except (tk.TclError, RuntimeError):
            pass  # window already closing — drop the late update

    def log(self, msg: str) -> None:
        stamp = self.tsync.now_ist().strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{stamp}] {msg}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def show(self, name: str) -> None:
        self.screens[name].tkraise()
        self._active_screen = name

    # ------------------------------------------------------------------
    # Screen 1 — setup
    # ------------------------------------------------------------------

    def _build_setup(self, f: ttk.Frame) -> None:
        ttk.Label(f, text="IRCTC Tatkal Booker", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        ttk.Label(
            f,
            text="Pre-positions a real Chromium at the search form and fires at the exact "
                 "tatkal second. You log in and type the captcha; everything else is automated.",
            wraplength=720,
        ).pack(anchor="w", pady=(2, 12))

        grid = ttk.Frame(f)
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)

        ttk.Label(grid, text="Preset", font=FONT_BOLD).grid(row=0, column=0, sticky="w", pady=3)
        self.preset_box = ttk.Combobox(
            grid, state="readonly",
            values=[p.get("label", p.get("preset_id", "?")) for p in self.presets],
        )
        self.preset_box.grid(row=0, column=1, sticky="ew", padx=8, pady=3)
        self.preset_box.bind("<<ComboboxSelected>>", self._on_preset_change)

        pbtns = ttk.Frame(grid)
        pbtns.grid(row=0, column=2, sticky="w")
        ttk.Button(pbtns, text="New…", width=6,
                   command=lambda: self._open_preset_dialog(new=True)).pack(side="left", padx=1)
        ttk.Button(pbtns, text="Edit…", width=6,
                   command=self._open_preset_dialog).pack(side="left", padx=1)
        ttk.Button(pbtns, text="Delete", width=7,
                   command=self._delete_preset).pack(side="left", padx=1)

        self.summary_var = tk.StringVar(value="—")
        ttk.Label(grid, textvariable=self.summary_var, justify="left",
                  font=FONT_BASE).grid(row=1, column=1, sticky="w", padx=8, pady=(0, 8))

        ttk.Label(grid, text="Journey date", font=FONT_BOLD).grid(row=2, column=0, sticky="w", pady=3)
        row = ttk.Frame(grid)
        row.grid(row=2, column=1, sticky="w", padx=8, pady=3)
        self.date_entry = ttk.Entry(row, width=14, font=FONT_BASE)
        self.date_entry.pack(side="left")
        ttk.Label(row, text="YYYY-MM-DD").pack(side="left", padx=(6, 12))
        ttk.Button(row, text="Today +1", width=9,
                   command=lambda: self._quick_date(1)).pack(side="left", padx=2)
        ttk.Button(row, text="Today +2", width=9,
                   command=lambda: self._quick_date(2)).pack(side="left", padx=2)

        ttk.Label(grid, text="Tatkal window", font=FONT_BOLD).grid(row=3, column=0, sticky="w", pady=3)
        self.window_box = ttk.Combobox(grid, state="readonly", values=WINDOW_CHOICES, width=48)
        self.window_box.grid(row=3, column=1, sticky="w", padx=8, pady=3)
        self.window_box.current(0)

        ttk.Label(grid, text="Custom fire time", font=FONT_BOLD).grid(row=4, column=0, sticky="w", pady=3)
        row2 = ttk.Frame(grid)
        row2.grid(row=4, column=1, sticky="w", padx=8, pady=3)
        self.custom_time_entry = ttk.Entry(row2, width=14, font=FONT_BASE)
        self.custom_time_entry.pack(side="left")
        ttk.Label(row2, text="HH:MM:SS IST — optional, overrides the window (for testing)").pack(
            side="left", padx=6)

        btns = ttk.Frame(f)
        btns.pack(fill="x", pady=(16, 4))
        self.btn_launch = ttk.Button(btns, text="1 · Launch browser & arm",
                                     command=self._on_launch)
        self.btn_launch.pack(side="left")
        self.btn_login = ttk.Button(btns, text="2 · I have logged in — continue",
                                    command=self._on_login_confirmed, state="disabled")
        self.btn_login.pack(side="left", padx=8)
        self.btn_refill_setup = ttk.Button(btns, text="Re-fill form",
                                           command=self._on_refill, state="disabled")
        self.btn_refill_setup.pack(side="left", padx=8)

        self.ntp_var = tk.StringVar(value="NTP: not synced yet")
        ttk.Label(f, textvariable=self.ntp_var, font=FONT_BASE).pack(anchor="w", pady=(10, 0))
        self.ist_var = tk.StringVar(value="IST —")
        ttk.Label(f, textvariable=self.ist_var, font=FONT_BASE).pack(anchor="w")

    def _select_initial_preset(self, query: str | None) -> None:
        if not self.presets:
            messagebox.showerror("No presets", "data/presets.json has no presets.")
            return
        index = 0
        default = preset_store.get_default_preset()
        if default:
            ids = [p.get("preset_id") for p in self.presets]
            if default.get("preset_id") in ids:
                index = ids.index(default.get("preset_id"))
        if query:
            q = query.lower()
            for i, p in enumerate(self.presets):
                if q == str(p.get("preset_id", "")).lower() or q in str(p.get("label", "")).lower():
                    index = i
                    break
        self.preset_box.current(index)
        self._on_preset_change(initial=True)

    def _current_preset(self) -> dict[str, Any] | None:
        index = self.preset_box.current()
        if index < 0 or index >= len(self.presets):
            return None
        return self.presets[index]

    def _on_preset_change(self, _event=None, initial: bool = False) -> None:
        p = self._current_preset()
        if p is None:
            self.summary_var.set("—  (no preset selected — click New… to create one)")
            return
        pax = ", ".join(
            f"{x.get('name', '?')} ({x.get('age', '?')}{str(x.get('gender', ''))[:1]})"
            for x in p.get("passengers", [])
        )
        self.summary_var.set(
            f"{p['from_station']}  →  {p['to_station']}\n"
            f"Train {p['train_number']}  ·  Class {p['travel_class']}  ·  "
            f"Quota {p.get('quota', 'TATKAL')}\nPassengers: {pax or '—'}"
        )
        self.date_entry.delete(0, "end")
        self.date_entry.insert(0, p.get("journey_date", ""))

        if initial and self._cli_hour in (10, 11):
            self.window_box.current(0 if self._cli_hour == 10 else 1)
        else:
            suggested = 0 if p["travel_class"].upper() in AC_CLASSES else 1
            self.window_box.current(suggested)
            self.log(f"Tatkal window auto-set to {'10:00' if suggested == 0 else '11:00'} "
                     f"for class {p['travel_class']} — change it if needed.")

    def _quick_date(self, days: int) -> None:
        target = (self.tsync.now_ist() + timedelta(days=days)).date()
        self.date_entry.delete(0, "end")
        self.date_entry.insert(0, target.isoformat())

    # ------------------------------------------------------------------
    # Launch / arm
    # ------------------------------------------------------------------

    def _parse_inputs(self):
        """Returns (preset_copy, journey_date, target_datetime) or raises ValueError."""
        if self._current_preset() is None:
            raise ValueError("No preset selected — create one with New… first.")
        raw = self.date_entry.get().strip()
        try:
            journey = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError(f"Journey date '{raw}' is not YYYY-MM-DD.")
        today = self.tsync.now_ist().date()
        if journey < today:
            raise ValueError("Journey date is in the past.")
        if journey > today + timedelta(days=120):
            raise ValueError("Journey date is more than 120 days out.")

        custom = self.custom_time_entry.get().strip()
        if custom:
            m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", custom)
            if not m:
                raise ValueError(f"Custom time '{custom}' is not HH:MM[:SS].")
            h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
            target = self.tsync.next_occurrence(h, mi, s)
        else:
            hour = 10 if self.window_box.current() == 0 else 11
            target = self.tsync.next_occurrence(hour)

        preset = dict(self._current_preset() or {})
        preset["journey_date"] = journey.isoformat()
        return preset, journey, target

    # ------------------------------------------------------------------
    # Preset management (New… / Edit… / Delete)
    # ------------------------------------------------------------------

    def _open_preset_dialog(self, new: bool = False) -> None:
        preset = None if new else self._current_preset()
        PresetDialog(self.root, preset=preset, on_save=self._after_preset_saved)

    def _after_preset_saved(self, saved: dict[str, Any]) -> None:
        self._reload_presets(select_id=saved.get("preset_id"))
        self.log(f"Preset '{saved.get('label')}' saved.")
        if self.engine is not None:
            self.log("Note: an armed run keeps its old values — re-launch to use the edit.")

    def _delete_preset(self) -> None:
        p = self._current_preset()
        if p is None:
            return
        if not messagebox.askyesno("Delete preset",
                                   f"Delete preset '{p.get('label')}'?"):
            return
        preset_store.delete_preset(p.get("preset_id"))
        self._reload_presets()
        self.log(f"Preset '{p.get('label')}' deleted.")

    def _reload_presets(self, select_id: str | None = None) -> None:
        self.presets = preset_store.load_presets()
        labels = [p.get("label", p.get("preset_id", "?")) for p in self.presets]
        self.preset_box.configure(values=labels)
        if not self.presets:
            self.preset_box.set("")
            self.summary_var.set("—  (no presets — click New… to create one)")
            return
        index = 0
        if select_id:
            ids = [p.get("preset_id") for p in self.presets]
            if select_id in ids:
                index = ids.index(select_id)
        self.preset_box.current(index)
        self._on_preset_change()

    def _on_launch(self) -> None:
        try:
            preset, journey, target = self._parse_inputs()
        except ValueError as exc:
            messagebox.showerror("Check inputs", str(exc))
            return

        if self.engine is not None:
            self.log("Closing previous browser…")
            self.engine.shutdown()
            self.engine = None

        # Remember the date so the next run starts from it.
        if preset.get("preset_id"):
            try:
                preset_store.set_journey_date(preset["preset_id"], preset["journey_date"])
            except Exception:
                pass

        self.target_time = target
        self.target_var.set(
            f"Fires at {target.strftime('%H:%M:%S')} IST on {target.strftime('%a %d %b')}"
        )
        self.log(f"Armed: {preset['from_station']} → {preset['to_station']} on "
                 f"{journey.isoformat()}, train {preset['train_number']}, "
                 f"class {preset['travel_class']}.")
        self.log(f"Fire time: {target.strftime('%Y-%m-%d %H:%M:%S')} IST.")

        callbacks = EngineCallbacks(
            on_status=lambda m: self.ui(self.log, m),
            on_phase=lambda ph: self.ui(self._on_phase, ph),
            on_tick=lambda s: self.ui(self._on_tick, s),
            on_login_required=lambda: self.ui(self._on_login_required),
            on_form_status=lambda ok: self.ui(self._on_form_status, ok),
            on_captcha=lambda png: self.ui(self._on_captcha, png),
            on_result=lambda ok, msg, el: self.ui(self._on_result, ok, msg, el),
        )
        self.engine = BookingEngine(preset, journey, target, self.tsync, callbacks)
        self.engine.start()

        self.btn_launch.configure(state="disabled")
        self.btn_refill_setup.configure(state="normal")

    def _on_login_confirmed(self) -> None:
        if self.engine:
            self.engine.confirm_login()
            self.btn_login.configure(state="disabled")
            self.log("Login confirmed — pre-filling now.")

    def _on_refill(self) -> None:
        if self.engine:
            self.engine.request_refill()
            self.log("Re-fill requested.")

    # ------------------------------------------------------------------
    # Screen 2 — countdown
    # ------------------------------------------------------------------

    def _build_countdown(self, f: ttk.Frame) -> None:
        ttk.Label(f, text="Countdown to tatkal", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        self.target_var = tk.StringVar(value="—")
        ttk.Label(f, textvariable=self.target_var, font=FONT_BIG).pack(anchor="w", pady=(4, 14))

        self.countdown_var = tk.StringVar(value="--:--:--")
        tk.Label(f, textvariable=self.countdown_var, font=FONT_CLOCK,
                 fg="#c62828").pack(pady=6)

        self.ntp_var2 = tk.StringVar(value="NTP: not synced yet")
        ttk.Label(f, textvariable=self.ntp_var2).pack(anchor="w")
        self.ist_var2 = tk.StringVar(value="IST —")
        ttk.Label(f, textvariable=self.ist_var2).pack(anchor="w")
        self.form_var = tk.StringVar(value="Form: not verified yet")
        ttk.Label(f, textvariable=self.form_var, font=FONT_BOLD).pack(anchor="w", pady=(6, 12))

        btns = ttk.Frame(f)
        btns.pack(pady=8)
        fire = tk.Button(btns, text="🔥 FIRE NOW", font=("Segoe UI", 14, "bold"),
                         bg="#c62828", fg="white", padx=18, pady=6,
                         command=self._on_fire_now)
        fire.pack(side="left", padx=6)
        ttk.Button(btns, text="Re-fill form", command=self._on_refill).pack(side="left", padx=6)
        ttk.Button(btns, text="Re-sync NTP", command=self._start_ntp_sync).pack(side="left", padx=6)
        ttk.Button(btns, text="Abort run", command=self._on_abort).pack(side="left", padx=6)

        ttk.Label(
            f,
            text="Leave the browser window alone while armed — and do NOT log in to IRCTC "
                 "anywhere else (IRCTC kills duplicate sessions).",
            wraplength=680,
        ).pack(anchor="w", pady=(14, 0))

    def _on_fire_now(self) -> None:
        if self.engine:
            self.engine.fire()
            self.log("FIRE NOW pressed.")

    def _on_abort(self) -> None:
        if self.engine:
            self.engine.cancel_run()
            self.log("Abort requested…")

    def _on_tick(self, seconds: float) -> None:
        h, rem = divmod(int(seconds), 3600)
        m, s = divmod(rem, 60)
        tenths = int((seconds - int(seconds)) * 10)
        self.countdown_var.set(f"{h:02d}:{m:02d}:{s:02d}.{tenths}")

    def _on_form_status(self, ok: bool) -> None:
        self.form_var.set("Form: ✓ filled and verified" if ok else "Form: ✗ NEEDS RE-FILL")

    def _on_phase(self, phase: str) -> None:
        if phase == "countdown":
            self.show("countdown")
        elif phase == "fired":
            self.countdown_var.set("FIRED!")
            self.log("=== FIRED ===")

    def _on_login_required(self) -> None:
        self.btn_login.configure(state="normal")
        self.log("ACTION NEEDED: log in inside the browser, then press "
                 "'I have logged in — continue'.")

    # ------------------------------------------------------------------
    # Screen 3 — captcha
    # ------------------------------------------------------------------

    def _build_captcha(self, f: ttk.Frame) -> None:
        ttk.Label(f, text="Type the captcha — fast!", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        self.captcha_elapsed_var = tk.StringVar(value="")
        ttk.Label(f, textvariable=self.captcha_elapsed_var, font=FONT_BIG,
                  foreground="#c62828").pack(anchor="w", pady=(2, 10))

        self.captcha_img_label = tk.Label(f, text="(waiting for captcha…)",
                                          relief="groove", padx=10, pady=10)
        self.captcha_img_label.pack(pady=6)

        row = ttk.Frame(f)
        row.pack(pady=8)
        self.captcha_entry = tk.Entry(row, width=16, font=("Consolas", 20))
        self.captcha_entry.pack(side="left", padx=4)
        self.captcha_entry.bind("<Return>", lambda _e: self._on_captcha_submit())
        ttk.Button(row, text="Submit ⏎", command=self._on_captcha_submit).pack(side="left", padx=4)
        ttk.Button(row, text="New captcha", command=self._on_captcha_refresh).pack(side="left", padx=4)

        ttk.Label(f, text="Press Enter to submit. If it's unreadable, ask for a new one — "
                          "a wrong guess costs ~3 seconds.").pack(anchor="w", pady=(8, 0))

    def _on_captcha(self, png: bytes) -> None:
        img = Image.open(io.BytesIO(png))
        w, h = img.size
        scale = max(1.0, min(2.5, 480 / max(w, 1)))
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        self._captcha_photo = ImageTk.PhotoImage(img)  # keep a ref or Tk drops it
        self.captcha_img_label.configure(image=self._captcha_photo, text="")
        self.captcha_entry.delete(0, "end")
        self.show("captcha")
        self.captcha_entry.focus_set()
        self.root.bell()
        self.log("Captcha on screen — type it and press Enter.")

    def _on_captcha_submit(self) -> None:
        text = self.captcha_entry.get().strip()
        if not text:
            return
        if self.engine:
            self.engine.submit_captcha(text)
            self.log(f"Captcha submitted ({len(text)} chars).")

    def _on_captcha_refresh(self) -> None:
        if self.engine:
            self.engine.refresh_captcha()
            self.log("New captcha requested.")

    # ------------------------------------------------------------------
    # Screen 4 — result
    # ------------------------------------------------------------------

    def _build_result(self, f: ttk.Frame) -> None:
        self.result_head_var = tk.StringVar(value="—")
        self.result_head = tk.Label(f, textvariable=self.result_head_var,
                                    font=("Segoe UI", 18, "bold"))
        self.result_head.pack(anchor="w", pady=(10, 6))
        self.result_msg_var = tk.StringVar(value="")
        ttk.Label(f, textvariable=self.result_msg_var, wraplength=700,
                  justify="left").pack(anchor="w")
        self.result_elapsed_var = tk.StringVar(value="")
        ttk.Label(f, textvariable=self.result_elapsed_var, font=FONT_BIG).pack(
            anchor="w", pady=(10, 16))

        ttk.Label(
            f,
            text="⚠ Keep THIS app open until you finish paying — closing it closes the "
                 "automated browser too.",
            wraplength=700,
        ).pack(anchor="w", pady=(0, 12))

        btns = ttk.Frame(f)
        btns.pack(anchor="w")
        ttk.Button(btns, text="New run (closes browser)",
                   command=self._on_new_run).pack(side="left", padx=4)
        ttk.Button(btns, text="Quit", command=self._on_close).pack(side="left", padx=4)

    def _on_result(self, ok: bool, msg: str, elapsed: float) -> None:
        self.result_head_var.set("✅ BOOKING SUBMITTED — PAY NOW" if ok else "❌ RUN FAILED")
        self.result_head.configure(fg="#2e7d32" if ok else "#c62828")
        self.result_msg_var.set(msg)
        if elapsed:
            self.result_elapsed_var.set(f"Trigger → here: {elapsed:.1f} s")
        self.show("result")
        self.btn_launch.configure(state="normal")
        self.log(("SUCCESS: " if ok else "FAILED: ") + msg.splitlines()[0])

    def _on_new_run(self) -> None:
        if self.engine:
            self.engine.shutdown()
            self.engine = None
        self.btn_launch.configure(state="normal")
        self.btn_login.configure(state="disabled")
        self.btn_refill_setup.configure(state="disabled")
        self.countdown_var.set("--:--:--")
        self.show("setup")

    # ------------------------------------------------------------------
    # Shared chrome: log + clocks
    # ------------------------------------------------------------------

    def _build_log(self, root: tk.Tk) -> None:
        frame = ttk.Frame(root)
        frame.pack(fill="x", side="bottom")
        ttk.Separator(frame).pack(fill="x")
        self.log_text = tk.Text(frame, height=9, state="disabled", font=FONT_MONO,
                                bg="#1e1e1e", fg="#d4d4d4")
        self.log_text.pack(fill="x", padx=4, pady=4)

    def _start_ntp_sync(self) -> None:
        self.ntp_var.set("NTP: syncing…")
        self.ntp_var2.set("NTP: syncing…")
        self.log("Syncing clock with NTP…")

        def work() -> None:
            ok = self.tsync.sync()
            self.ui(self._ntp_done, ok)

        threading.Thread(target=work, daemon=True, name="ntp-sync").start()

    def _ntp_done(self, ok: bool) -> None:
        if ok:
            delay = self.tsync.last_delay or 0.0
            text = (f"NTP offset: {self.tsync.offset.total_seconds():+.3f}s "
                    f"(synced, round-trip {delay * 1000:.0f} ms)")
        else:
            text = "NTP sync FAILED — falling back to the system clock!"
        self.ntp_var.set(text)
        self.ntp_var2.set(text)
        self.log(text)

    def _tick_clock(self) -> None:
        now = self.tsync.now_ist().strftime("%H:%M:%S.%f")[:-5]
        self.ist_var.set(f"IST now: {now}")
        self.ist_var2.set(f"IST now: {now}")
        if self.engine and self.engine.fired_at:
            self.captcha_elapsed_var.set(
                f"{time.monotonic() - self.engine.fired_at:.1f} s since fire")
        self.root.after(100, self._tick_clock)

    def _on_close(self) -> None:
        if self.engine and self.engine.fired_at and self._active_screen != "result":
            if not messagebox.askokcancel(
                    "Quit?", "A booking run is in progress — quitting closes the browser. Quit?"):
                return
        if self.engine:
            self.engine.shutdown()
            # Give the engine thread a beat to close Chromium cleanly.
            self.root.after(400, self.root.destroy)
        else:
            self.root.destroy()


class PresetDialog(tk.Toplevel):
    """Form editor for one preset — replaces hand-editing data/presets.json.

    Validates everything on save (station format, 5-digit train number,
    date format, passenger ages…) so a typo can't surface at 10:00 AM.
    """

    def __init__(self, parent: tk.Misc, preset: dict[str, Any] | None = None,
                 on_save=None) -> None:
        super().__init__(parent)
        self.title("Edit preset" if preset else "New preset")
        self.resizable(False, False)
        self.result: dict[str, Any] | None = None
        self._base = dict(preset or {})
        self._on_save = on_save

        body = ttk.Frame(self, padding=14)
        body.pack(fill="both", expand=True)
        self._build(body)
        self._populate()

        try:
            self.transient(parent.winfo_toplevel())
            self.geometry(f"+{parent.winfo_rootx() + 60}+{parent.winfo_rooty() + 40}")
            self.grab_set()  # modal
        except tk.TclError:
            pass  # parent not viewable (e.g. during tests) — stay non-modal

    def _build(self, body: ttk.Frame) -> None:
        self.label_var = tk.StringVar()
        self.from_var = tk.StringVar()
        self.to_var = tk.StringVar()
        self.train_var = tk.StringVar()
        self.class_var = tk.StringVar()
        self.quota_var = tk.StringVar()
        self.date_var = tk.StringVar()
        self.mobile_var = tk.StringVar()
        self.email_var = tk.StringVar()
        self.default_var = tk.BooleanVar()

        def add_row(r: int, text: str, widget: tk.Widget, hint: str = "") -> None:
            ttk.Label(body, text=text, font=FONT_BOLD).grid(row=r, column=0, sticky="w", pady=3)
            widget.grid(row=r, column=1, sticky="w", padx=8, pady=3)
            if hint:
                ttk.Label(body, text=hint, foreground="#666").grid(
                    row=r, column=2, sticky="w")

        add_row(0, "Label", ttk.Entry(body, textvariable=self.label_var, width=30),
                "shown in the preset dropdown")
        add_row(1, "From station", ttk.Entry(body, textvariable=self.from_var, width=30),
                "NAME - CODE, e.g. DELHI - DLI")
        add_row(2, "To station", ttk.Entry(body, textvariable=self.to_var, width=30),
                "e.g. KANPUR CENTRAL - CNB")
        add_row(3, "Train number", ttk.Entry(body, textvariable=self.train_var, width=10),
                "5 digits")
        add_row(4, "Class", ttk.Combobox(body, textvariable=self.class_var,
                                         state="readonly", values=CLASS_CODES, width=8))
        add_row(5, "Quota", ttk.Combobox(body, textvariable=self.quota_var,
                                         state="readonly", values=QUOTAS, width=18))
        add_row(6, "Journey date", ttk.Entry(body, textvariable=self.date_var, width=14),
                "YYYY-MM-DD (changeable per run)")
        add_row(7, "Mobile", ttk.Entry(body, textvariable=self.mobile_var, width=16),
                "10 digits, optional")
        add_row(8, "Email", ttk.Entry(body, textvariable=self.email_var, width=30),
                "optional")
        ttk.Checkbutton(body, text="Use as default preset",
                        variable=self.default_var).grid(row=9, column=1, sticky="w",
                                                        padx=8, pady=(3, 8))

        pf = ttk.LabelFrame(body, text=f"Passengers (up to {MAX_PASSENGERS} — "
                                       "leave extra rows blank)", padding=8)
        pf.grid(row=10, column=0, columnspan=3, sticky="ew", pady=(4, 8))
        for col, head in enumerate(("Name", "Age", "Gender", "Berth preference")):
            ttk.Label(pf, text=head, font=FONT_BOLD).grid(row=0, column=col,
                                                          sticky="w", padx=3)
        self.pax_rows: list[tuple[ttk.Entry, ttk.Entry, ttk.Combobox, ttk.Combobox]] = []
        for i in range(MAX_PASSENGERS):
            name_e = ttk.Entry(pf, width=26)
            age_e = ttk.Entry(pf, width=5)
            gender_cb = ttk.Combobox(pf, state="readonly", values=("",) + GENDERS, width=12)
            berth_cb = ttk.Combobox(pf, state="readonly",
                                    values=(NO_BERTH,) + BERTHS, width=15)
            for col, w in enumerate((name_e, age_e, gender_cb, berth_cb)):
                w.grid(row=i + 1, column=col, sticky="w", padx=3, pady=2)
            self.pax_rows.append((name_e, age_e, gender_cb, berth_cb))

        btns = ttk.Frame(body)
        btns.grid(row=11, column=0, columnspan=3, sticky="e")
        ttk.Button(btns, text="Save", command=self._save).pack(side="left", padx=4)
        ttk.Button(btns, text="Cancel", command=self.destroy).pack(side="left", padx=4)

    def _populate(self) -> None:
        b = self._base
        self.label_var.set(b.get("label", ""))
        self.from_var.set(b.get("from_station", ""))
        self.to_var.set(b.get("to_station", ""))
        self.train_var.set(str(b.get("train_number", "")))
        self.class_var.set(b.get("travel_class", "SL"))
        self.quota_var.set(b.get("quota", "TATKAL"))
        self.date_var.set(b.get("journey_date")
                          or (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d"))
        self.mobile_var.set(str(b.get("mobile_number", "")))
        self.email_var.set(b.get("email", ""))
        self.default_var.set(bool(b.get("is_default", False)))
        for pax, (name_e, age_e, gender_cb, berth_cb) in zip(
                b.get("passengers", []), self.pax_rows):
            name_e.insert(0, str(pax.get("name", "")))
            age_e.insert(0, str(pax.get("age", "")))
            gender_cb.set(str(pax.get("gender", "")))
            berth_cb.set(str(pax.get("berth_preference", "")) or NO_BERTH)

    def _collect(self) -> dict[str, Any]:
        """Validated preset dict from the form. Raises ValueError on problems."""
        label = self.label_var.get().strip()
        if not label:
            raise ValueError("Label is required.")
        frm = " ".join(self.from_var.get().split())
        to = " ".join(self.to_var.get().split())
        if not frm or not to:
            raise ValueError("Both stations are required.")
        for which, value in (("From", frm), ("To", to)):
            if " - " not in value:
                raise ValueError(
                    f"{which} station must be 'NAME - CODE', e.g. 'DELHI - DLI'.")
        train = self.train_var.get().strip()
        if not re.fullmatch(r"\d{5}", train):
            raise ValueError("Train number must be exactly 5 digits.")
        cls = self.class_var.get().strip().upper()
        if cls not in CLASS_CODES:
            raise ValueError("Pick a travel class.")
        raw_date = self.date_var.get().strip()
        try:
            datetime.strptime(raw_date, "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"Journey date '{raw_date}' is not YYYY-MM-DD.") from None
        mobile = self.mobile_var.get().strip()
        if mobile and not re.fullmatch(r"\d{10}", mobile):
            raise ValueError("Mobile number must be 10 digits (or left blank).")

        passengers = []
        for i, (name_e, age_e, gender_cb, berth_cb) in enumerate(self.pax_rows, start=1):
            name = name_e.get().strip()
            age = age_e.get().strip()
            gender = gender_cb.get().strip()
            berth = berth_cb.get().strip()
            if not name and not age:
                continue  # untouched row
            if not name:
                raise ValueError(f"Passenger {i}: name is missing.")
            if not age.isdigit() or not 1 <= int(age) <= 125:
                raise ValueError(f"Passenger {i}: age must be a number from 1 to 125.")
            if gender not in GENDERS:
                raise ValueError(f"Passenger {i}: pick a gender.")
            passengers.append({
                "name": name,
                "age": int(age),
                "gender": gender,
                "berth_preference": "" if berth in ("", NO_BERTH) else berth,
            })
        if not passengers:
            raise ValueError("Add at least one passenger.")

        preset = dict(self._base)  # keep unknown keys (booking_url, …) intact
        preset.update({
            "label": label,
            "from_station": frm,
            "to_station": to,
            "journey_date": raw_date,
            "travel_class": cls,
            "quota": self.quota_var.get().strip().upper() or "TATKAL",
            "train_number": train,
            "mobile_number": mobile,
            "email": self.email_var.get().strip(),
            "is_default": bool(self.default_var.get()),
            "passengers": passengers,
        })
        return preset

    def _save(self) -> None:
        try:
            preset = self._collect()
        except ValueError as exc:
            messagebox.showerror("Check the form", str(exc), parent=self)
            return
        saved = preset_store.save_preset(preset)
        self.result = saved
        if self._on_save is not None:
            self._on_save(saved)
        self.destroy()
