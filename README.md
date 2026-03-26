# IRCTC Helper

This project gives you a safe, semi-automatic workflow for IRCTC booking preparation without attempting to bypass CAPTCHA, OTP, queueing, or payment protections.

## What it does

- Saves trip presets and passenger details in a small local web UI
- Opens your saved booking URLs at the configured time, such as `10:00`
- Watches a user-provided availability page for keywords like `AVAILABLE` or `RAC`
- Launches a Selenium browser session that fills simple form fields when possible

## What it does not do

- It does not bypass CAPTCHA
- It does not bypass OTP
- It does not automate payment confirmation
- It does not guarantee IRCTC field selectors will stay the same over time

## Setup

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000` in your browser.

You can also start it with:

```powershell
.\start.ps1
```

Or on Windows with one double-click or one command:

```bat
start.bat
```

`start.bat` launches the app in the background and opens `http://127.0.0.1:5000` in your browser.

## Notes on Selenium

The prefill helper uses Chrome via Selenium and assumes you have a compatible browser/driver available on your machine. If Selenium cannot start Chrome automatically, install a matching ChromeDriver and add it to your `PATH`.

## Recommended workflow

1. Save a preset with your trip, passenger details, booking URL, and optional availability URL.
2. Leave the app running before booking time.
3. At the configured time, the helper opens the saved booking page.
4. If needed, click `Launch Prefill` from the UI to fill easy fields.
5. Complete CAPTCHA, OTP, queueing, and payment manually.

## Tampermonkey Browser Helper

If you prefer to log in manually and let Chrome fill the passenger page afterward, use the userscript at [tampermonkey/irctc-helper.user.js](C:/Users/HP/Documents/irctc/tampermonkey/irctc-helper.user.js).

Setup:

1. Install the Tampermonkey extension in Chrome.
2. Open the script file and paste it into a new Tampermonkey script.
3. Keep this local app running at `http://127.0.0.1:5000`.
4. Save one or more presets in the local IRCTC Helper UI.
5. Log in to IRCTC manually in Chrome.
6. Open the passenger-details page and let the script fill visible fields.

Notes:

- The script fetches preset data from `http://127.0.0.1:5000/api/presets`.
- It only fills visible passenger/contact fields and does not bypass CAPTCHA, OTP, queueing, or payment checks.
- If IRCTC changes its markup, update the selector lists near the top of the userscript.
