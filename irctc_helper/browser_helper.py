from __future__ import annotations

import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as ec
from selenium.webdriver.support.ui import WebDriverWait

from .storage import load_presets


def _fill_if_present(driver: webdriver.Chrome, selectors: list[tuple[str, str]], value: str) -> None:
    if not value:
        return

    for by, selector in selectors:
        try:
            element = WebDriverWait(driver, 2).until(ec.presence_of_element_located((by, selector)))
            element.clear()
            element.send_keys(value)
            return
        except Exception:
            continue


def launch_prefill(preset_id: str, profile_dir: str | None = None) -> None:
    presets = {preset["preset_id"]: preset for preset in load_presets()}
    preset = presets[preset_id]

    options = Options()
    if profile_dir:
        Path(profile_dir).mkdir(parents=True, exist_ok=True)
        options.add_argument(f"--user-data-dir={profile_dir}")

    driver = webdriver.Chrome(options=options)
    driver.get(preset["booking_url"])

    # These selectors are intentionally conservative and may need adjustment
    # if IRCTC changes its markup. They do not attempt to bypass protected steps.
    time.sleep(5)
    _fill_if_present(
        driver,
        [(By.NAME, "mobileNo"), (By.CSS_SELECTOR, "input[type='tel']")],
        preset.get("mobile_number", ""),
    )
    _fill_if_present(
        driver,
        [(By.NAME, "email"), (By.CSS_SELECTOR, "input[type='email']")],
        preset.get("email", ""),
    )

    passengers = preset.get("passengers", [])
    for index, passenger in enumerate(passengers, start=1):
        _fill_if_present(
            driver,
            [(By.NAME, f"passengerName{index}"), (By.CSS_SELECTOR, f"input[placeholder*='Passenger {index}']")],
            passenger.get("name", ""),
        )
        _fill_if_present(
            driver,
            [(By.NAME, f"passengerAge{index}"), (By.CSS_SELECTOR, f"input[placeholder*='Age {index}']")],
            str(passenger.get("age", "")),
        )

    print("Browser launched. Complete CAPTCHA/OTP/payment manually.")
