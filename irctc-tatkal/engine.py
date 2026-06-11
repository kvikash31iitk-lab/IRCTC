"""Playwright automation engine for the tatkal booker.

Design notes
------------
* The whole flow runs on ONE worker thread because Playwright's sync API is
  thread-affine. The GUI talks to the engine only through ``threading.Event``
  flags and receives progress through the ``EngineCallbacks`` functions (the
  GUI is responsible for marshalling those onto the Tk main thread).
* IRCTC is an Angular SPA whose DOM details drift between deployments
  (PrimeNG ``p-*`` vs legacy ``ui-*`` class prefixes), so every lookup tries
  an ordered list of selectors and text heuristics instead of one brittle
  selector.
* Clicks use Playwright's trusted input events, which Angular's Zone.js sees
  as real user input. Hidden radio inputs (PrimeNG paints its own widget and
  hides the native input) are clicked via ``element.click()`` in page JS —
  a native click works on invisible elements and still triggers Angular.
* The captcha is never OCR'd: the engine screenshots the <img> (bypasses
  CORS), hands the PNG to the GUI, and waits for the human to type it.
"""

from __future__ import annotations

import re
import threading
import time
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from timing import TimeSync, wait_until

BASE_DIR = Path(__file__).resolve().parent
AUTH_STATE_PATH = BASE_DIR / "auth_state.json"
LOGS_DIR = BASE_DIR / "logs"

SEARCH_URL = "https://www.irctc.co.in/nget/train-search"

# Seconds before T=0 at which we fire a throwaway fetch so the TCP+TLS
# connection is already open when the real search goes out.
PREWARM_SECONDS = 2.0
# How often the countdown loop re-verifies the pre-filled form (Angular
# occasionally resets dropdowns on idle).
FORM_CHECK_SECONDS = 30.0

GENDER_VALUES = {"male": ["M"], "female": ["F"], "transgender": ["T"], "other": ["T"]}
BERTH_VALUES = {
    "lower": ["LB"],
    "middle": ["MB"],
    "upper": ["UB"],
    "side lower": ["SL"],
    "side upper": ["SU"],
    "window side": ["WS"],
    "window": ["WS"],
    "cabin": ["CB"],
    "coupe": ["CP"],
}


class EngineError(RuntimeError):
    """A step of the booking flow failed in a way we can report."""


class EngineCancelled(Exception):
    """The user aborted the run."""


def _noop(*_a: Any, **_k: Any) -> None:
    return None


@dataclass
class EngineCallbacks:
    """Progress hooks. Every callback may be invoked from the engine thread."""

    on_status: Callable[[str], None] = _noop          # log line
    on_phase: Callable[[str], None] = _noop           # "login" | "prefill" | "countdown" | "fired" | "parked"
    on_tick: Callable[[float], None] = _noop          # countdown seconds remaining
    on_login_required: Callable[[], None] = _noop     # enable the "I'm logged in" button
    on_form_status: Callable[[bool], None] = _noop    # periodic form verification result
    on_captcha: Callable[[bytes], None] = _noop       # PNG of the captcha image
    on_result: Callable[[bool, str, float], None] = _noop  # success, message, seconds since fire


class BookingEngine:
    """One booking attempt: launch → login → prefill → wait → fire → captcha."""

    def __init__(
        self,
        preset: dict[str, Any],
        journey_date: date,
        target_time: datetime,
        tsync: TimeSync,
        callbacks: EngineCallbacks | None = None,
    ) -> None:
        self.preset = preset
        self.journey_date = journey_date
        self.target_time = target_time
        self.tsync = tsync
        self.cb = callbacks or EngineCallbacks()

        # GUI → engine signals.
        self.login_confirmed = threading.Event()
        self.fire_now = threading.Event()
        self.refill_requested = threading.Event()
        self.captcha_submitted = threading.Event()
        self.captcha_refresh = threading.Event()
        self.cancel = threading.Event()
        self.shutdown_requested = threading.Event()

        self.captcha_text: str = ""
        self.fired_at: float | None = None  # time.monotonic() at T=0

        self._thread: threading.Thread | None = None
        self._pw = None
        self._browser = None
        self._context = None
        self.page = None
        self._persistent_ctx = False  # True when using launch_persistent_context

    # ------------------------------------------------------------------
    # Public API (called from the GUI thread)
    # ------------------------------------------------------------------

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name="booking-engine", daemon=True)
        self._thread.start()

    def confirm_login(self) -> None:
        self.login_confirmed.set()

    def fire(self) -> None:
        self.fire_now.set()

    def request_refill(self) -> None:
        self.refill_requested.set()

    def submit_captcha(self, text: str) -> None:
        self.captcha_text = text.strip()
        self.captcha_submitted.set()

    def refresh_captcha(self) -> None:
        self.captcha_refresh.set()

    def cancel_run(self) -> None:
        self.cancel.set()

    def shutdown(self) -> None:
        """Ask the engine thread to close the browser and exit."""
        self.cancel.set()
        self.shutdown_requested.set()

    # ------------------------------------------------------------------
    # Main flow (engine thread)
    # ------------------------------------------------------------------

    def run(self) -> None:
        elapsed = 0.0
        try:
            self._launch_browser()
            recoveries = 0
            while True:
                try:
                    self._ensure_login()
                    self.cb.on_phase("prefill")
                    self._prefill_search_form()
                    break
                except (EngineCancelled, EngineError):
                    raise
                except Exception as exc:
                    recoveries += 1
                    if recoveries > 2 or not self._is_target_closed(exc):
                        raise
                    self._status("⚠ The browser/tab closed mid-step — recovering and retrying…")
                    self._recover_session("during login/prefill")
            self.cb.on_phase("countdown")
            self._countdown()

            self.fired_at = time.monotonic()
            self.cb.on_phase("fired")
            self._submit_and_find_train()
            self._fill_passenger_page()
            self._handle_captcha_page()

            elapsed = time.monotonic() - self.fired_at
            self._save_auth_state()
            self.cb.on_result(
                True,
                "Reached the payment page — finish the payment in the browser window. "
                "The seat is held while you pay.",
                elapsed,
            )
        except EngineCancelled:
            self._status("Run cancelled.")
            self.cb.on_result(False, "Cancelled by user.", self._elapsed())
        except Exception as exc:  # noqa: BLE001 — anything here must reach the GUI
            detail = self._capture_failure(exc)
            self.cb.on_result(
                False,
                f"{exc}\n\nThe browser stays open so you can finish manually. {detail}",
                self._elapsed(),
            )
        finally:
            self.cb.on_phase("parked")
            self._park_until_shutdown()

    def _elapsed(self) -> float:
        return (time.monotonic() - self.fired_at) if self.fired_at else 0.0

    def _status(self, msg: str) -> None:
        self.cb.on_status(msg)

    def _check_cancel(self) -> None:
        if self.cancel.is_set():
            raise EngineCancelled()

    # ------------------------------------------------------------------
    # Browser lifecycle
    # ------------------------------------------------------------------

    @staticmethod
    def _chrome_user_data_dir() -> "Path | None":
        """Return Chrome's user-data directory for the current OS user, or None."""
        import os
        if os.name == "nt":
            base = os.environ.get("LOCALAPPDATA", "")
            if base:
                p = Path(base) / "Google" / "Chrome" / "User Data"
                return p if p.exists() else None
        else:
            for p in (
                Path.home() / "Library" / "Application Support" / "Google" / "Chrome",
                Path.home() / ".config" / "google-chrome",
            ):
                if p.exists():
                    return p
        return None

    def _launch_browser(self) -> None:
        """Launch browser and set self.page to a live tab on the train-search URL.

        Strategy 1 (preferred): Playwright ``launch_persistent_context`` with the
        user's real Chrome profile. IRCTC cannot distinguish this from a normal
        browsing session — real cookies, real fingerprint, real user-agent — so
        bot-detection / "Unable to Process Request" errors don't fire. If the
        profile is locked (Chrome already open), falls through to Strategy 2.

        Strategy 2 (fallback): clean-launch Chrome/Edge/Chromium with the saved
        ``auth_state.json`` session. Warn the user if bot-detection is a concern.
        """
        self._persistent_ctx = False
        self._status("Launching browser…")
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise EngineError(
                "Playwright is not installed. Run:  pip install playwright  "
                "then:  python -m playwright install chromium"
            ) from exc

        self._pw = sync_playwright().start()
        _LAUNCH_ARGS = [
            "--disable-blink-features=AutomationControlled",
            "--start-maximized",
        ]
        _INIT_SCRIPT = (
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
        )

        # ── Strategy 1: real Chrome profile ──────────────────────────────────
        chrome_base = self._chrome_user_data_dir()
        if chrome_base:
            for profile_name in ("Default", "Profile 1", "Profile 2", "Profile 3"):
                prof = chrome_base / profile_name
                if not prof.exists():
                    continue
                try:
                    self._context = self._pw.chromium.launch_persistent_context(
                        user_data_dir=str(prof),
                        channel="chrome",
                        headless=False,
                        args=_LAUNCH_ARGS,
                        no_viewport=True,
                    )
                    self._context.add_init_script(_INIT_SCRIPT)
                    try:
                        self._context.on("page", self._on_new_page_event)
                    except Exception:
                        pass
                    self._browser = None
                    self._persistent_ctx = True
                    self._status(
                        f"Browser: Chrome with real profile '{profile_name}' — "
                        "IRCTC login bot-detection bypassed."
                    )
                    # Use a fresh tab so existing Chrome tabs are untouched.
                    self.page = self._context.new_page()
                    self._wire_page()
                    return
                except Exception as exc:
                    self._status(
                        f"Chrome profile '{profile_name}' unavailable "
                        f"({str(exc)[:100]}) — trying next."
                    )

        # ── Strategy 2: clean launch ──────────────────────────────────────────
        self._status(
            "Using clean-launch mode (Chrome profile locked or not found). "
            "If IRCTC blocks login with 'Unable to Process Request', "
            "close Chrome and restart the app so it can use your real profile."
        )
        last_error: Exception | None = None
        for channel, label in (
            ("chrome", "installed Google Chrome"),
            ("msedge", "installed Microsoft Edge"),
            (None, "bundled Chromium"),
        ):
            try:
                self._browser = self._pw.chromium.launch(
                    headless=False,
                    channel=channel,
                    args=_LAUNCH_ARGS,
                )
                self._status(f"Browser: {label}.")
                break
            except Exception as exc:
                last_error = exc
        else:
            raise EngineError(
                f"No launchable browser (tried Chrome, Edge, bundled Chromium). "
                f"Last error: {last_error}"
            )
        ctx_kwargs: dict[str, Any] = {"no_viewport": True}
        if AUTH_STATE_PATH.exists():
            ctx_kwargs["storage_state"] = str(AUTH_STATE_PATH)
            self._status("Loaded saved IRCTC session (auth_state.json).")
        self._context = self._browser.new_context(**ctx_kwargs)
        self._context.add_init_script(_INIT_SCRIPT)
        try:
            self._browser.on("disconnected", self._on_browser_disconnected)
        except Exception:
            pass
        try:
            self._context.on("page", self._on_new_page_event)
        except Exception:
            pass
        self.page = self._context.new_page()
        self._wire_page()

    def _save_auth_state(self) -> None:
        try:
            self._context.storage_state(path=str(AUTH_STATE_PATH))
        except Exception:
            self._status("Could not save the IRCTC session (browser window gone?).")

    # -- session self-healing --------------------------------------------

    def _wire_page(self) -> None:
        self.page.set_default_timeout(15000)
        try:
            self.page.on("close", self._on_page_closed_event)
        except Exception:
            pass

    def _on_page_closed_event(self, _page=None) -> None:
        if not self.shutdown_requested.is_set():
            self._status("⚠ The automated tab was closed — will auto-recover at the next step.")

    def _on_browser_disconnected(self, _browser=None) -> None:
        if not self.shutdown_requested.is_set():
            self._status("⚠ Browser window closed or crashed — will relaunch at the next step.")

    def _on_new_page_event(self, _page=None) -> None:
        # self.page is None only while _recover_session is opening its own tab.
        if self.page is not None and not self.shutdown_requested.is_set():
            self._status("Site opened a new browser tab.")

    def _page_alive(self) -> bool:
        try:
            return self.page is not None and not self.page.is_closed()
        except Exception:
            return False

    @staticmethod
    def _is_target_closed(exc: Exception) -> bool:
        """True for Playwright's page/context/browser-died family of errors."""
        text = f"{type(exc).__name__}: {exc}"
        return any(s in text for s in (
            "has been closed",
            "Target closed",
            "TargetClosedError",
            "browser has been disconnected",
            "Connection closed",
        ))

    def _recover_session(self, during: str) -> None:
        """Bring ``self.page`` back to a live train-search tab.

        Tier 1: adopt another open tab in the same browser (login flows can
        strand the user in a second tab). Tier 2: open a fresh tab. Tier 3:
        the whole browser died — relaunch it; auth_state.json restores the
        login whenever it was saved. Leaves the page on SEARCH_URL with the
        search form rendered, so login-wait/prefill can resume directly.
        """
        self._status(f"⚠ Lost the browser tab {during} — recovering…")
        self.page = None
        try:
            pages = [p for p in self._context.pages if not p.is_closed()]
            adopted = bool(pages)
            self.page = pages[-1] if pages else self._context.new_page()
            self._wire_page()
            self._status("Recovered: switched to a surviving tab." if adopted
                         else "Recovered: opened a fresh tab in the same browser.")
        except Exception:
            self.page = None
        if self.page is None:
            for closer in (
                lambda: self._context and self._context.close(),
                lambda: self._browser and self._browser.close(),
                lambda: self._pw and self._pw.stop(),
            ):
                try:
                    closer()
                except Exception:
                    pass
            self._context = self._browser = self._pw = None
            self._launch_browser()
            self._status("Recovered: relaunched the browser (saved session reloaded).")
        url = ""
        try:
            url = self.page.url or ""
        except Exception:
            pass
        if "irctc.co.in/nget" not in url:
            self.page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=90000)
        self._wait_any(["input[role='searchbox']", "p-autocomplete input"], 60)
        self._dismiss_dialogs()

    def _park_until_shutdown(self) -> None:
        """Keep the browser alive (user may be mid-payment) until told to quit."""
        while not self.shutdown_requested.wait(timeout=0.25):
            pass
        for closer in (
            lambda: self._context and self._context.close(),
            lambda: self._browser and self._browser.close(),
            lambda: self._pw and self._pw.stop(),
        ):
            try:
                closer()
            except Exception:
                pass

    def _capture_failure(self, exc: Exception) -> str:
        """Screenshot + traceback into logs/ so 10:00 AM failures are debuggable."""
        try:
            LOGS_DIR.mkdir(exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            shot = LOGS_DIR / f"error-{stamp}.png"
            txt = LOGS_DIR / f"error-{stamp}.txt"
            try:
                open_pages = (len([p for p in self._context.pages if not p.is_closed()])
                              if self._context else 0)
            except Exception:
                open_pages = -1
            url = "?"
            if self._page_alive():
                try:
                    url = self.page.url
                except Exception:
                    pass
            txt.write_text(
                f"url: {url}\npage_alive: {self._page_alive()}  "
                f"open_pages: {open_pages}\n\n{traceback.format_exc()}",
                encoding="utf-8",
            )
            if self._page_alive():
                self.page.screenshot(path=str(shot))
                return f"(Diagnostics saved to {shot.name})"
            return f"(Traceback saved to {txt.name})"
        except Exception:
            return ""

    # ------------------------------------------------------------------
    # Generic DOM helpers
    # ------------------------------------------------------------------

    def _wait_any(self, selectors: list[str], timeout_s: float, scope=None):
        """First visible match among ``selectors``, polling until ``timeout_s``."""
        scope = scope or self.page
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._check_cancel()
            for sel in selectors:
                try:
                    loc = scope.locator(sel)
                    if loc.count() and loc.first.is_visible():
                        return loc.first
                except Exception:
                    continue
            self.page.wait_for_timeout(60)
        raise EngineError(f"Timed out waiting for any of: {selectors}")

    def _type_slow(self, locator, text: str, delay_ms: int = 25) -> None:
        """Keystroke-by-keystroke typing so Angular autocomplete sees input events."""
        try:
            locator.press_sequentially(text, delay=delay_ms)
        except AttributeError:  # Playwright < 1.38
            locator.type(text, delay=delay_ms)

    def _js_click(self, css: str) -> bool:
        """element.click() in page JS — works on PrimeNG's hidden radio inputs."""
        try:
            return bool(
                self.page.evaluate(
                    "sel => { const el = document.querySelector(sel);"
                    " if (!el) return false; el.click(); return true; }",
                    css,
                )
            )
        except Exception:
            return False

    def _click_innermost(self, scope, css: str, pattern: re.Pattern,
                         timeout_ms: int = 2500) -> bool:
        """Click the innermost element under ``scope`` whose text matches.

        Descendants follow ancestors in DOM order, so the last match is the
        innermost; the click bubbles up to whichever element Angular bound.
        """
        try:
            cand = scope.locator(css).filter(has_text=pattern)
            n = cand.count()
            if n == 0:
                return False
            cand.nth(n - 1).click(timeout=timeout_ms)
            return True
        except Exception:
            return False

    def _dismiss_dialogs(self) -> bool:
        """Accept any blocking popup (IRCTC's disclaimer / confirm dialogs)."""
        dismissed = False
        for label in ("OK", "Yes", "Confirm", "I Agree", "Agree"):
            for container in (".p-dialog", ".ui-dialog", "p-confirmdialog", ".modal"):
                try:
                    btn = self.page.locator(f"{container} button:has-text(\"{label}\")")
                    if btn.count() and btn.first.is_visible():
                        btn.first.click()
                        dismissed = True
                        self.page.wait_for_timeout(150)
                except Exception:
                    continue
        return dismissed

    # ------------------------------------------------------------------
    # Login
    # ------------------------------------------------------------------

    def _ensure_login(self) -> None:
        self.cb.on_phase("login")
        self._status(f"Opening {SEARCH_URL} …")
        self.page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=90000)
        # Angular boot can take a while on IRCTC; wait for the search form.
        self._wait_any(["input[role='searchbox']", "p-autocomplete input"], 60)
        self._dismiss_dialogs()

        if self._is_logged_in():
            self._status("Already logged in (saved session worked).")
            self._save_auth_state()
            return

        self.cb.on_login_required()
        self._status("Not logged in. Log in inside the browser window, then press "
                     "'I have logged in' — or the engine will detect it automatically.")
        while not self.login_confirmed.is_set():
            self._check_cancel()
            if not self._page_alive():
                self._recover_session("while waiting for login")
                continue
            if self._is_logged_in():
                self._status("Login detected.")
                break
            time.sleep(1.0)
        if not self._page_alive():
            # The window died and the user pressed the button anyway.
            self._recover_session("after login confirmation")
        self._save_auth_state()

    def _is_logged_in(self) -> bool:
        try:
            if self.page.locator("a:has-text('Logout')").count():
                return True
        except Exception:
            pass
        try:
            login = self.page.locator("a:has-text('LOGIN'), button:has-text('LOGIN')")
            for i in range(min(login.count(), 4)):
                if login.nth(i).is_visible():
                    return False
        except Exception:
            pass
        return False

    # ------------------------------------------------------------------
    # Search-form prefill (all of this happens BEFORE the tatkal window)
    # ------------------------------------------------------------------

    def _prefill_search_form(self) -> None:
        self._status("Pre-filling the search form…")
        self._dismiss_dialogs()
        self._fill_station(0, self.preset["from_station"])
        self._fill_station(1, self.preset["to_station"])
        self._fill_date()
        self._set_class_dropdown()
        self._set_quota_dropdown()
        ok = self._verify_form()
        self.cb.on_form_status(ok)
        if not ok:
            raise EngineError("Search form did not verify after pre-fill — see browser window.")
        self._status("Search form pre-filled and verified. NOT submitting yet.")

    @staticmethod
    def _split_station(station: str) -> tuple[str, str | None]:
        """'NEW DELHI - NDLS' → ('NEW DELHI', 'NDLS')."""
        if "-" in station:
            name, _, code = station.rpartition("-")
            return name.strip(), code.strip() or None
        return station.strip(), None

    def _station_box(self, index: int):
        boxes = self.page.locator("input[role='searchbox']")
        if boxes.count() > index:
            return boxes.nth(index)
        boxes = self.page.locator("p-autocomplete input")
        if boxes.count() > index:
            return boxes.nth(index)
        raise EngineError(f"Station input #{index} not found")

    def _fill_station(self, index: int, station: str) -> None:
        name, code = self._split_station(station)
        label = "From" if index == 0 else "To"
        box = self._station_box(index)
        box.click()
        box.fill("")
        # The station code is the most selective query; fall back to the name.
        self._type_slow(box, code or name[:4])
        needles = [station, f"- {code}" if code else "", code or "", name[:6]]
        if not self._pick_autocomplete_item([n for n in needles if n], timeout_s=5.0):
            # Retry once with the name prefix (some codes don't match-as-typed).
            box.fill("")
            self._type_slow(box, name[:4])
            if not self._pick_autocomplete_item([n for n in needles if n], timeout_s=5.0):
                raise EngineError(f"{label} station '{station}': no autocomplete match")
        value = box.input_value() or ""
        if code and code.upper() not in value.upper():
            raise EngineError(f"{label} station did not stick (input shows '{value}')")
        self._status(f"{label} station set: {value or station}")

    def _pick_autocomplete_item(self, needles: list[str], timeout_s: float) -> bool:
        items_sel = (
            ".p-autocomplete-panel li, .ui-autocomplete-panel li, "
            "p-autocomplete-panel li, ul[role='listbox'] li"
        )
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._check_cancel()
            try:
                items = self.page.locator(items_sel)
                n = items.count()
                if n:
                    texts = []
                    for i in range(min(n, 25)):
                        try:
                            texts.append(items.nth(i).inner_text(timeout=500))
                        except Exception:
                            texts.append("")
                    for needle in needles:
                        for i, text in enumerate(texts):
                            if needle.upper() in text.upper():
                                items.nth(i).click()
                                return True
            except Exception:
                pass
            self.page.wait_for_timeout(100)
        return False

    # -- date ----------------------------------------------------------

    _MONTHS = ["january", "february", "march", "april", "may", "june", "july",
               "august", "september", "october", "november", "december"]

    def _fill_date(self) -> None:
        d = self.journey_date
        inp = self._wait_any(
            ["p-calendar input", ".ui-calendar input", "input#jDate"], 8
        )
        inp.click()
        picked = False
        try:
            panel = self._wait_any([".p-datepicker", ".ui-datepicker"], 4)
            picked = self._calendar_pick_day(panel, d)
        except EngineError:
            picked = False  # picker never opened — fall through to direct write

        if not picked:
            # Fallback: write dd/mm/yyyy via the native value setter + input
            # event (the Angular-safe write pattern from the spec).
            self._status("Calendar navigation failed — typing the date directly.")
            inp.evaluate(
                """(el, val) => {
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value').set;
                    setter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                d.strftime("%d/%m/%Y"),
            )
            self.page.keyboard.press("Escape")

        self._status(f"Journey date set: {d.strftime('%d/%m/%Y')}")

    def _calendar_pick_day(self, panel, d: date) -> bool:
        try:
            for _ in range(24):  # never more than ~13 month hops needed
                month, year = self._read_calendar_title(panel)
                if month is None:
                    return False
                if (year, month) == (d.year, d.month):
                    break
                direction = "next" if (year, month) < (d.year, d.month) else "prev"
                arrow = panel.locator(
                    f".p-datepicker-{direction}, .ui-datepicker-{direction}, "
                    f"a[aria-label='{direction.title()} Month'], "
                    f"button[aria-label='{direction.title()} Month']"
                )
                if not arrow.count():
                    return False
                arrow.first.click()
                self.page.wait_for_timeout(120)
            else:
                return False

            day_pat = re.compile(rf"^\s*{d.day}\s*$")
            cells = panel.locator("table td a, table td span").filter(has_text=day_pat)
            for i in range(cells.count()):
                cell = cells.nth(i)
                td_class = cell.evaluate("el => el.closest('td')?.className || ''") or ""
                own_class = cell.get_attribute("class") or ""
                blob = f"{td_class} {own_class}".lower()
                if "other-month" in blob or "disabled" in blob:
                    continue
                cell.click()
                return True
            return False
        except Exception:
            return False

    def _read_calendar_title(self, panel) -> tuple[int | None, int | None]:
        """Current (month, year) shown by the picker, tolerant of both PrimeNG skins."""
        try:
            month_el = panel.locator(".p-datepicker-month, .ui-datepicker-month")
            year_el = panel.locator(".p-datepicker-year, .ui-datepicker-year")
            if month_el.count() and year_el.count():
                month_txt = month_el.first.inner_text().strip().lower()
                year_txt = re.sub(r"\D", "", year_el.first.inner_text())
            else:
                title = panel.locator(".p-datepicker-title, .ui-datepicker-title").first
                parts = title.inner_text().strip().lower().split()
                month_txt = parts[0] if parts else ""
                year_txt = re.sub(r"\D", "", parts[-1]) if parts else ""
            for idx, name in enumerate(self._MONTHS, start=1):
                if name.startswith(month_txt[:3]) and month_txt:
                    return idx, int(year_txt)
        except Exception:
            pass
        return None, None

    # -- dropdowns -------------------------------------------------------

    _PANEL_SEL = ".p-dropdown-panel, .ui-dropdown-panel"

    def _visible_dropdown_panel(self):
        """The currently-open dropdown overlay, or None."""
        try:
            panels = self.page.locator(self._PANEL_SEL)
            for i in range(panels.count()):
                if panels.nth(i).is_visible():
                    return panels.nth(i)
        except Exception:
            pass
        return None

    def _open_dropdown(self, control_names: list[str], current_label_hint: str | None):
        """Open the dropdown and return its overlay panel.

        Clicking a p-dropdown TOGGLES it, so a panel left open by an earlier
        step must be closed first or our 'open' click would close it mid-pick.
        """
        dd = None
        for name in control_names:
            loc = self.page.locator(f"p-dropdown[formcontrolname='{name}']")
            if loc.count():
                dd = loc.first
                break
        if dd is None and current_label_hint:
            # Fallback: find the dropdown by what its label currently says
            # (e.g. the untouched defaults "All Classes" / "GENERAL").
            dds = self.page.locator("p-dropdown")
            for i in range(dds.count()):
                try:
                    if re.search(current_label_hint, dds.nth(i).inner_text(), re.I):
                        dd = dds.nth(i)
                        break
                except Exception:
                    continue
        if dd is None:
            raise EngineError(f"Dropdown not found: {control_names}")

        if self._visible_dropdown_panel() is not None:
            self.page.keyboard.press("Escape")
            self.page.wait_for_timeout(150)

        for _ in range(3):
            dd.click()
            self.page.wait_for_timeout(200)
            panel = self._visible_dropdown_panel()
            if panel is not None:
                return panel
        raise EngineError(f"Dropdown {control_names} did not open")

    def _pick_dropdown_item(self, panel, exact: list[str], contains: list[str],
                            avoid: list[str] | None = None) -> str:
        """Click the matching item inside the open ``panel``.

        Matches on aria-label first (PrimeNG sets it to the option label and
        it needs no layout), then rendered text. Falls back to a JS click if
        the overlay animation makes the element 'unstable' for Playwright.
        """
        avoid = avoid or []
        deadline = time.monotonic() + 5.0
        last_seen: list[str] = []
        while time.monotonic() < deadline:
            self._check_cancel()
            items = panel.locator("li")
            entries: list[tuple[int, str]] = []
            for i in range(min(items.count(), 30)):
                item = items.nth(i)
                label = ""
                try:
                    label = item.get_attribute("aria-label", timeout=300) or ""
                except Exception:
                    pass
                if not label:
                    try:
                        label = item.inner_text(timeout=300)
                    except Exception:
                        pass
                entries.append((i, " ".join(label.split())))
            last_seen = [t for _, t in entries if t]

            pick: tuple[int, str] | None = None
            for want in exact:
                pick = next(((i, t) for i, t in entries if t.upper() == want.upper()), None)
                if pick:
                    break
            if pick is None:
                for want in contains:
                    pick = next(
                        ((i, t) for i, t in entries
                         if want.upper() in t.upper()
                         and not any(a.upper() in t.upper() for a in avoid)),
                        None,
                    )
                    if pick:
                        break

            if pick is not None:
                i, text = pick
                try:
                    items.nth(i).click(timeout=2000)
                except Exception:
                    try:
                        items.nth(i).evaluate("el => el.click()")
                    except Exception:
                        self.page.wait_for_timeout(120)
                        continue  # list re-rendered under us — rescan
                return text
            self.page.wait_for_timeout(120)
        raise EngineError(
            f"Dropdown item not found (wanted {exact or contains}; saw {last_seen[:12]})"
        )

    def _set_class_dropdown(self) -> None:
        cls = self.preset["travel_class"].upper()
        panel = self._open_dropdown(["journeyClass"], r"All Classes|\(\w{1,2}\)")
        picked = self._pick_dropdown_item(panel, exact=[], contains=[f"({cls})"])
        self._status(f"Class set: {picked}")

    def _set_quota_dropdown(self) -> None:
        quota = (self.preset.get("quota") or "TATKAL").upper()
        panel = self._open_dropdown(["journeyQuota"], r"GENERAL|TATKAL")
        avoid = ["PREMIUM"] if quota == "TATKAL" else []
        picked = self._pick_dropdown_item(panel, exact=[quota], contains=[quota], avoid=avoid)
        self._status(f"Quota set: {picked}")

    # -- verification ----------------------------------------------------

    def _verify_form(self) -> bool:
        """True when all four fields still hold the preset values."""
        problems: list[str] = []
        _, from_code = self._split_station(self.preset["from_station"])
        _, to_code = self._split_station(self.preset["to_station"])
        try:
            if from_code and from_code.upper() not in (self._station_box(0).input_value() or "").upper():
                problems.append("from")
            if to_code and to_code.upper() not in (self._station_box(1).input_value() or "").upper():
                problems.append("to")
        except Exception:
            problems.append("stations")

        try:
            date_val = self.page.locator("p-calendar input, .ui-calendar input").first.input_value() or ""
            d = self.journey_date
            if not any(s in date_val for s in (d.strftime("%d/%m/%Y"), d.strftime("%d-%m-%Y"))):
                problems.append("date")
        except Exception:
            problems.append("date")

        cls = self.preset["travel_class"].upper()
        if not self._dropdown_label_contains("journeyClass", f"({cls})"):
            problems.append("class")
        quota = (self.preset.get("quota") or "TATKAL").upper()
        if not self._dropdown_label_contains("journeyQuota", quota):
            problems.append("quota")

        if problems:
            self._status(f"Form check failed: {', '.join(problems)}")
        return not problems

    def _dropdown_label_contains(self, control_name: str, needle: str) -> bool:
        try:
            dd = self.page.locator(f"p-dropdown[formcontrolname='{control_name}']")
            label = dd.first.inner_text() if dd.count() else ""
            if not label:
                # Fall back to scanning every dropdown label on the page.
                label = " | ".join(
                    self.page.locator("p-dropdown").nth(i).inner_text()
                    for i in range(self.page.locator("p-dropdown").count())
                )
            return needle.upper() in label.upper()
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Countdown
    # ------------------------------------------------------------------

    def _countdown(self) -> None:
        self._status(
            f"Armed. Firing at {self.target_time.strftime('%H:%M:%S')} IST "
            f"({self.target_time.strftime('%d %b')}). FIRE NOW overrides."
        )
        stop = {"fire": self.fire_now, "cancel": self.cancel, "refill": self.refill_requested}

        while True:
            now = self.tsync.now_ist()
            remaining = (self.target_time - now).total_seconds()
            if remaining <= PREWARM_SECONDS:
                break
            chunk = min(remaining - PREWARM_SECONDS, FORM_CHECK_SECONDS)
            reason = wait_until(
                now + timedelta(seconds=chunk),
                self.tsync.now_ist,
                self._tick_with_offset,
                stop_events=stop,
            )
            if reason == "cancel":
                raise EngineCancelled()
            if reason == "fire":
                self._status("Manual FIRE override!")
                return
            if reason == "refill":
                self.refill_requested.clear()
                self._refill()
                continue
            # Chunk elapsed normally → periodic form-drift check.
            if (self.target_time - self.tsync.now_ist()).total_seconds() > 5:
                if not self._page_alive():
                    self._refill()  # recovers the session first, then re-fills
                    continue
                ok = self._verify_form()
                self.cb.on_form_status(ok)
                if not ok:
                    self._status("Form drifted — re-filling…")
                    self._refill()

        self._prewarm()
        reason = wait_until(
            self.target_time,
            self.tsync.now_ist,
            self.cb.on_tick,
            stop_events={"fire": self.fire_now, "cancel": self.cancel},
        )
        if reason == "cancel":
            raise EngineCancelled()

    def _tick_with_offset(self, _seconds_to_chunk_end: float) -> None:
        """The wait runs in ≤30 s chunks; report remaining time to the REAL target."""
        remaining = (self.target_time - self.tsync.now_ist()).total_seconds()
        self.cb.on_tick(max(0.0, remaining))

    def _refill(self) -> None:
        try:
            if not self._page_alive():
                self._recover_session("before re-fill")
            self._prefill_search_form()
        except Exception as exc:
            self.cb.on_form_status(False)
            self._status(f"Re-fill failed: {exc}")

    def _prewarm(self) -> None:
        """Open the TCP/TLS connection ~2 s early so the search pays no handshake."""
        try:
            self.page.evaluate(
                "fetch(location.origin + '/nget/assets/favicon.ico?_=' + Date.now(),"
                " {cache: 'no-store'}).catch(() => {})"
            )
            self._status("Connection pre-warmed.")
        except Exception:
            pass

    # ------------------------------------------------------------------
    # T=0: search → train card → class → availability → Book Now
    # ------------------------------------------------------------------

    def _submit_and_find_train(self) -> None:
        if not self._page_alive():
            self._status("⚠ Tab lost at fire time — emergency recovery (costs precious seconds)…")
            self._recover_session("at fire time")
            self._prefill_search_form()
        self._status("T=0 — submitting search.")
        btn = self._wait_any(
            [
                "button.train_Search",
                "button[type='submit']:has-text('Search')",
                "button:has-text('Search Trains')",
                "button:has-text('Search')",
            ],
            5,
        )
        try:
            btn.click(timeout=4000)
        except Exception:
            btn.evaluate("el => el.click()")  # never stall the race on this click

        if not self._wait_url(r".*/train-list", 15):
            raise EngineError("Train list page did not load after search")
        # NOTE: app-train-avl-enq host elements report a zero-size box, which
        # fails Playwright's visibility check — wait on real layout elements.
        self._wait_any([".train-heading", "div.pre-avl"], 12)
        self._status(f"Train list loaded (+{self._elapsed():.1f}s)")

        card = self._find_train_card()
        self._status(f"Train ({self.preset['train_number']}) found (+{self._elapsed():.1f}s)")

        tile = self._click_class_tile(card)
        if not self._availability_visible(card):
            self._activate_pre_avl(card, tile)
        self._wait_availability(card)
        self._status(f"Availability visible (+{self._elapsed():.1f}s)")

        self._click_date_cell(card)
        self._click_book_now(card)
        self._status(f"Book Now clicked (+{self._elapsed():.1f}s)")

    def _wait_url(self, pattern: str, timeout_s: float) -> bool:
        try:
            self.page.wait_for_url(re.compile(pattern), timeout=timeout_s * 1000)
            return True
        except Exception:
            return False

    def _find_train_card(self, timeout_s: float = 12.0):
        """Locate the card for our train, scrolling (virtual list) as needed."""
        needle = f"({self.preset['train_number']})"
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._check_cancel()
            card = self.page.locator(f"app-train-avl-enq:has-text(\"{needle}\")")
            if card.count():
                # Scroll the heading (the host element has no box of its own).
                for target in (card.first.locator(".train-heading").first, card.first):
                    try:
                        target.scroll_into_view_if_needed(timeout=1500)
                        break
                    except Exception:
                        continue
                return card.first
            try:
                self.page.mouse.wheel(0, 1400)
            except Exception:
                pass
            self.page.wait_for_timeout(150)
        raise EngineError(f"Train {needle} not found in the results list")

    def _click_class_tile(self, card):
        """Click our class's tile; returns the tile locator (or None).

        On the live site each class tile IS a ``div.pre-avl`` reading e.g.
        "Sleeper (SL)" with a "Refresh" link — clicking it triggers the
        availability fetch. Matching uses the parenthesised code: a bare
        "3A" would also hit the "3A Economy (3E)" tile.
        """
        cls = self.preset["travel_class"].upper()
        code_pat = re.compile(re.escape(f"({cls})"), re.I)

        tiles = card.locator("div.pre-avl").filter(has_text=code_pat)
        if tiles.count():
            tile = tiles.first
            link = tile.locator(".link")
            try:
                (link.first if link.count() else tile).click(timeout=3000)
            except Exception:
                tile.click(timeout=3000)
            return tile

        # Legacy layout: a cell whose entire text is the bare class code.
        exact = re.compile(rf"^\s*{re.escape(cls)}\s*$")
        if self._click_innermost(card, "td, div, span, strong", exact):
            return None

        # Last resort: shortest element mentioning "(CLS)".
        cand = card.locator("td, div, span").filter(has_text=code_pat)
        best_i, best_len = -1, 10**9
        for i in range(cand.count()):
            try:
                text = cand.nth(i).inner_text(timeout=400)
            except Exception:
                continue
            if len(text) < best_len:
                best_i, best_len = i, len(text)
        if best_i >= 0 and best_len < 60:
            cand.nth(best_i).click()
            return None
        raise EngineError(f"Class tile '({cls})' not found on the train card")

    _AVAIL_RE = r"AVAILABLE|RAC|WL|REGRET|NOT AVAILABLE|CURR|DEPARTED|CHARTING"

    def _availability_visible(self, card) -> bool:
        try:
            return card.locator(f"text=/{self._AVAIL_RE}/i").count() > 0
        except Exception:
            return False

    def _activate_pre_avl(self, card, tile=None) -> None:
        """Re-trigger the availability refresh; tries the spec's 4 strategies."""
        pre = card.locator("div.pre-avl")
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline and pre.count() == 0:
            self.page.wait_for_timeout(80)
        if pre.count() == 0:
            return  # availability may already be loading without a refresh box

        # Prefer the tile we already clicked — unless it went stale (after a
        # refresh the class strip re-renders as tabs and the locator empties).
        target = tile
        try:
            if target is None or target.count() == 0:
                target = None
        except Exception:
            target = None
        if target is None:
            cls = self.preset["travel_class"].upper()
            target = pre.first
            for pat in (f"({cls})", *self._date_label_patterns()):
                dated = pre.filter(has_text=re.compile(re.escape(pat), re.I))
                if dated.count():
                    target = dated.first
                    break

        # Short timeouts everywhere: a stale element must cost milliseconds,
        # not the 15 s default, in the middle of the tatkal race.
        attempts = (
            lambda: self.page.evaluate(
                "el => { el.focus(); el.dispatchEvent(new KeyboardEvent('keydown',"
                " {bubbles: true, cancelable: true, key: 'Enter', keyCode: 13})); }",
                target.element_handle(timeout=800),
            ),
            lambda: target.click(timeout=1200),
            lambda: target.locator(".link").first.click(timeout=1200),
            lambda: (target.focus(timeout=800), self.page.keyboard.press("Enter")),
        )
        for attempt in attempts:
            self._check_cancel()
            try:
                attempt()
            except Exception:
                continue
            try:
                end = time.monotonic() + 1.2
                while time.monotonic() < end:
                    if self._availability_visible(card):
                        return
                    self.page.wait_for_timeout(80)
            except Exception:
                pass

    def _wait_availability(self, card, timeout_s: float = 8.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._check_cancel()
            if self._availability_visible(card):
                return
            self.page.wait_for_timeout(80)
        raise EngineError("Availability cells never appeared after refresh")

    def _date_label_patterns(self) -> list[str]:
        d = self.journey_date
        wd, mon = d.strftime("%a"), d.strftime("%b")
        patterns = [
            f"{wd}, {d.day:02d} {mon}",
            f"{wd}, {d.day} {mon}",
            f"{d.day:02d} {mon}",
            f"{d.day} {mon}",
        ]
        return list(dict.fromkeys(patterns))  # dedup (day ≥ 10 has no 0-pad variant)

    def _click_date_cell(self, card) -> None:
        # Availability cells are div.pre-avl boxes ("Sat, 13 Jun" + status).
        # Match those first — the card HEADER also contains the date string.
        for pat in self._date_label_patterns():
            rx = re.compile(re.escape(pat), re.I)
            cells = card.locator("div.pre-avl").filter(has_text=rx)
            try:
                if cells.count():
                    cells.first.click(timeout=2500)
                    self._status(f"Date cell '{pat}' clicked")
                    return
            except Exception:
                pass
            if self._click_innermost(card, "td.link, div, td", rx):
                self._status(f"Date cell '{pat}' clicked (fallback path)")
                return
        # Single-date layouts: click whichever cell shows a bookable status.
        rx = re.compile(r"AVAILABLE|RAC|WL", re.I)
        cells = card.locator("div.pre-avl").filter(has_text=rx)
        try:
            if cells.count():
                cells.first.click(timeout=2500)
                self._status("Clicked the first availability cell (date label not matched)")
                return
        except Exception:
            pass
        self._status("WARNING: no date cell matched — trying Book Now anyway")

    def _click_book_now(self, card, timeout_s: float = 8.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._check_cancel()
            for scope in (card, self.page):
                try:
                    btn = scope.locator("button:has-text('Book Now')")
                    if not btn.count():
                        continue
                    b = btn.first
                    cls = (b.get_attribute("class") or "").lower()
                    if b.is_enabled() and "disable" not in cls:
                        b.click(timeout=3000)
                        return
                except Exception:
                    continue
            self.page.wait_for_timeout(80)
        raise EngineError("'Book Now' never became clickable (tatkal may not be open yet)")

    # ------------------------------------------------------------------
    # Passenger page
    # ------------------------------------------------------------------

    def _fill_passenger_page(self) -> None:
        if not self._wait_url(r".*psgninput", 20):
            # A confirm dialog may have eaten the Book Now click.
            self._dismiss_dialogs()
            if not self._wait_url(r".*psgninput", 8):
                raise EngineError("Passenger page did not load after Book Now")
        self._status(f"Passenger page (+{self._elapsed():.1f}s)")

        self._wait_any(
            ["p-autocomplete input", "input[placeholder='Name']",
             "input[placeholder='Passenger Name']"],
            15,
        )
        # Skip loyalty points (value 3 = Skip; 'loyality' is IRCTC's own typo).
        self._js_click("input[name='loyalityOperationType'][value='3']")

        for i, pax in enumerate(self.preset.get("passengers", [])):
            self._fill_one_passenger(i, pax)

        mobile = self.preset.get("mobile_number")
        if mobile:
            try:
                mob = self.page.locator(
                    "input[formcontrolname='mobileNumber'], input#mobileNumber"
                )
                if mob.count():
                    mob.first.fill(str(mobile))
            except Exception:
                self._status("Mobile number field not fillable (skipping)")

        # Loyalty sometimes resets after passenger edits; insurance = No.
        self._js_click("input[name='loyalityOperationType'][value='3']")
        self._js_click("input[name^='travelInsuranceOpted'][value='false']")
        self._dismiss_dialogs()

        cont = self._wait_any(["button:has-text('Continue')", "button[type='submit']"], 8)
        try:
            cont.click(timeout=4000)
        except Exception:
            cont.evaluate("el => el.click()")
        self._status(f"Passenger page submitted (+{self._elapsed():.1f}s)")

    def _fill_one_passenger(self, index: int, pax: dict[str, Any]) -> None:
        page = self.page
        if index > 0:
            add = page.locator(
                "a:has-text('+ Add Passenger'), span:has-text('+ Add Passenger'), "
                "a:has-text('Add Passenger')"
            )
            if add.count():
                add.first.click()
                page.wait_for_timeout(400)

        rows = page.locator("app-passenger")
        scope = rows.nth(index) if rows.count() > index else page

        name_sel = ("p-autocomplete input, input[placeholder='Name'], "
                    "input[placeholder='Passenger Name']")
        names = scope.locator(name_sel)
        box = names.first if scope is not page else names.nth(index)
        box.click()
        box.fill("")
        # 4 chars triggers the saved-passenger master list.
        self._type_slow(box, pax["name"][:4])
        picked = self._pick_autocomplete_item([pax["name"]], timeout_s=1.5)
        if picked:
            self._status(f"Passenger '{pax['name']}' picked from master list")
        else:
            box.fill("")
            self._type_slow(box, pax["name"], delay_ms=15)
            page.keyboard.press("Tab")  # close any empty suggestion overlay

        # Master-list picks auto-fill these; setting again is harmless.
        try:
            age = scope.locator("input[formcontrolname='passengerAge'], input[placeholder='Age']")
            if age.count() and pax.get("age") is not None:
                age.first.fill(str(pax["age"]))
        except Exception:
            pass

        gender_key = str(pax.get("gender", "")).strip().lower()
        self._select_option(
            scope,
            ["passengerGender"],
            GENDER_VALUES.get(gender_key, []),
            [pax.get("gender", "")],
        )

        berth = str(pax.get("berth_preference", "")).strip()
        if berth:
            values = BERTH_VALUES.get(berth.lower(), [])
            if not values and re.fullmatch(r"[A-Z]{2}", berth.upper()):
                values = [berth.upper()]  # already a code like 'LB'
            self._select_option(
                scope,
                ["passengerBerthChoice", "berthChoice"],
                values,
                [berth.title(), berth],
            )

    def _select_option(self, scope, control_names: list[str],
                       values: list[str], labels: list[str]) -> bool:
        for name in control_names:
            sel = scope.locator(f"select[formcontrolname='{name}']")
            if not sel.count():
                continue
            for value in values:
                try:
                    sel.first.select_option(value=value)
                    return True
                except Exception:
                    continue
            for label in labels:
                if not label:
                    continue
                try:
                    sel.first.select_option(label=label)
                    return True
                except Exception:
                    continue
        return False

    # ------------------------------------------------------------------
    # Review page: human-in-the-loop captcha
    # ------------------------------------------------------------------

    def _handle_captcha_page(self) -> None:
        if not self._wait_url(r".*reviewBooking", 25):
            self._dismiss_dialogs()
            if not self._wait_url(r".*reviewBooking", 10):
                raise EngineError("Review/captcha page did not load")
        self._status(f"Review page — captcha needed (+{self._elapsed():.1f}s)")

        for attempt in range(1, 6):
            img = self._wait_any(
                ["img.captcha-img", "img[src*='captcha']", "app-captcha img"], 15
            )
            self.page.wait_for_timeout(200)  # let the PNG finish painting
            self.cb.on_captcha(img.screenshot())

            text = self._await_captcha_input()
            if text is None:  # user asked for a fresh captcha
                self._try_refresh_captcha()
                continue

            inp = self._wait_any(
                ["input#captcha", "input[formcontrolname*='aptcha']",
                 "input[placeholder*='aptcha']"],
                8,
            )
            inp.fill(text)
            btn = self._wait_any(["button:has-text('Continue')", "button[type='submit']"], 8)
            try:
                btn.click(timeout=4000)
            except Exception:
                btn.evaluate("el => el.click()")

            if self._wait_url(r".*(bkgPaymentOptions|payment)", 12):
                return  # success — payment page reached
            self._dismiss_dialogs()
            if self._wait_url(r".*(bkgPaymentOptions|payment)", 4):
                return
            self._status(f"Captcha attempt {attempt} rejected — a fresh captcha is loading.")
            self.page.wait_for_timeout(600)

        raise EngineError("Captcha was rejected 5 times")

    def _await_captcha_input(self) -> str | None:
        """Wait for the GUI: returns the typed text, or None on refresh request."""
        self.captcha_submitted.clear()
        while True:
            self._check_cancel()
            if self.captcha_refresh.is_set():
                self.captcha_refresh.clear()
                return None
            if self.captcha_submitted.is_set():
                self.captcha_submitted.clear()
                return self.captcha_text
            time.sleep(0.05)

    def _try_refresh_captcha(self) -> None:
        for sel in (
            "a[aria-label*='efresh']", "span[title*='efresh']",
            ".captcha_div a", "a:has(.fa-repeat)", "a:has(.fa-sync)",
        ):
            try:
                loc = self.page.locator(sel)
                if loc.count() and loc.first.is_visible():
                    loc.first.click()
                    self.page.wait_for_timeout(500)
                    return
            except Exception:
                continue
        # No refresh control found — re-screenshot whatever is showing now.
