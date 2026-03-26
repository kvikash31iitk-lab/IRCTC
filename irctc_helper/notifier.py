from __future__ import annotations

import platform
import subprocess


def notify(title: str, message: str) -> None:
    try:
        from plyer import notification

        notification.notify(title=title, message=message, timeout=10)
        return
    except Exception:
        pass

    if platform.system() == "Windows":
        try:
            subprocess.run(
                [
                    "powershell",
                    "-Command",
                    (
                        "[console]::beep(1000,400);"
                        f"Write-Host '{title}: {message}'"
                    ),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            return
        except Exception:
            pass

    print(f"{title}: {message}")
