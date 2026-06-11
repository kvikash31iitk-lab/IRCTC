# IRCTC Tatkal Booker

A Python + Playwright desktop tool that **pre-positions** a real Chromium browser
on the IRCTC search form and fires at the exact tatkal second (10:00:00 IST for
AC classes, 11:00:00 for non-AC) using an NTP-corrected clock — instead of
starting navigation when the window opens.

You stay in the loop for the two things only a human can do: **logging in** and
**typing the captcha**. Everything else (search, train card, class tile,
availability refresh, date cell, Book Now, passenger details) is automated.

## Setup (once per PC)

```
pip install -r requirements.txt
python -m playwright install chromium
```

Python 3.10+ required (tested on 3.14, Windows 10).

## Run

```
python main.py                    # default preset
python main.py --preset kanpur    # pick preset by label substring or id
python main.py --time 11          # force the 11:00 window (default: auto by class)
```

## Presets

Manage presets with the **New… / Edit… / Delete** buttons next to the preset
dropdown — a form for label, route, train, class, quota, contact details and
up to six passengers, validated on save (no more hand-editing JSON). The data
still lives in `data/presets.json` (same schema as the old Flask helper), so
it can be synced between PCs or edited by hand if you prefer.

## A booking run, step by step

1. **Setup screen** — pick the preset, set the journey date (`Today +1` is the
   usual tatkal date), check the window (auto-picked from the travel class),
   then **Launch browser & arm**.
2. Chromium opens. If the saved session (`auth_state.json`) is still valid you
   skip login entirely; otherwise log in inside the browser — the app detects
   it (or press *I have logged in*). The search form is then pre-filled and
   verified. **The search is NOT submitted yet.**
3. **Countdown screen** — big clock, NTP offset, live IST time. Every 30 s the
   form is re-verified (Angular sometimes resets dropdowns on idle) and
   re-filled if it drifted. At T−2 s the TCP/TLS connection is pre-warmed.
   **FIRE NOW** overrides the clock for testing.
4. **T = 0** — search submitted, train card found, class tile clicked,
   availability refreshed, your date cell clicked, **Book Now** clicked,
   passengers filled from the preset, insurance = No, loyalty = Skip.
5. **Captcha screen** — the captcha appears *in the app* (element screenshot,
   no CORS games). Type it, press Enter. Wrong captcha? It re-captures the
   fresh one and asks again.
6. **Result screen** — on success you are on the IRCTC payment page with the
   seat held. **Finish paying in the browser before closing this app** — the
   automated browser dies with the app.

Use the *Custom fire time* field (HH:MM:SS) to rehearse the full flow at any
time of day without waiting for 10:00 — quota GENERAL + a custom time one
minute ahead makes a good dry run.

## Files

| File | Role |
|---|---|
| `main.py` | CLI entry point, launches the GUI |
| `gui.py` | Tkinter app: setup → countdown → captcha → result |
| `engine.py` | All Playwright browser automation (worker thread) |
| `timing.py` | NTP offset measurement, IST clock, millisecond `wait_until` |
| `presets.py` | Reads/writes `data/presets.json` (same schema as the Flask helper) |
| `data/presets.json` | Journeys + passengers |
| `auth_state.json` | Saved IRCTC login cookies (created after first login, gitignored) |
| `logs/` | Screenshot + traceback of any failed run |

**Using a second PC?** Copy `data/presets.json` and `auth_state.json` — that's
the whole state. All paths are relative to the script directory. Run
`python _smoke_test.py` afterwards to verify the install, clock sync, and GUI
in one shot (no browser is opened).

## Troubleshooting

- **Which browser does it use?** Installed Google Chrome, falling back to
  Edge, then Playwright's bundled Chromium. (Real Chrome has the best
  anti-bot fingerprint, and the bundled build fails with a "side-by-side
  configuration" error on some Windows 10 machines.)
- **"NTP sync FAILED"** — UDP port 123 blocked (some office networks). The
  tool falls back to the system clock; sync Windows time manually first.
- **Form shows ✗ during countdown** — the app re-fills automatically; you can
  also press *Re-fill form*.
- **Run fails at T=0** — the browser stays open so you can finish by hand, and
  `logs/error-*.png` shows exactly what the page looked like.
- **Session dies mid-run** — you logged in to IRCTC somewhere else. IRCTC
  allows one active session; don't touch the website on your phone while armed.

## Notes

- The captcha is deliberately **not** OCR'd — IRCTC's captcha resists it and a
  wrong guess costs ~3 s. A prepared human takes ~3–4 s reliably.
- Keep the journey date fresh: tatkal opens one day before travel.
- This automates *your own* single booking with *your own* account, at full
  fare, with a human captcha — but automated interaction is still subject to
  IRCTC's terms of service. Use at your own discretion.
