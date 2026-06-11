"""IRCTC Tatkal Booker — entry point.

Usage:
    python main.py                     # default preset, window auto-picked by class
    python main.py --preset kanpur     # pick preset by label substring (or id)
    python main.py --time 11           # force the 11:00 (non-AC) window
"""

from __future__ import annotations

import argparse
import tkinter as tk

from gui import App


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-positioned IRCTC tatkal booking with NTP-precise firing."
    )
    parser.add_argument("--preset", help="preset label substring or preset id")
    parser.add_argument(
        "--time",
        type=int,
        choices=(10, 11),
        default=None,
        help="tatkal hour IST: 10 (AC) or 11 (non-AC). Default: auto from travel class.",
    )
    args = parser.parse_args()

    root = tk.Tk()
    App(root, preset_query=args.preset, cli_hour=args.time)
    root.mainloop()


if __name__ == "__main__":
    main()
