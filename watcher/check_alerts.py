#!/usr/bin/env python3
"""Check alerts.log for undelivered cleared-the-Nines alerts and print them.

Intended to run on a cron every 15 minutes. Printed alerts surface to Dip
in chat (which pushes to his phone). Printed alerts are marked delivered.

Alert prefs (data/alert-prefs.json in the private repo, managed from the
app's OWNER-only Alert Settings panel) are enforced before printing:
  - kind "nines" suppressed when the 9/9 category toggle is off
  - kind "watchlist" suppressed when the watched-wallet category is off,
    or when that specific wallet is toggled off
  - kind "smartmoney" suppressed when the smart-money category is off
  - EVERYTHING suppressed during quiet hours (America/New_York)
Suppressed alerts are marked delivered (so they never pile up) but not
printed; each suppression is logged to stderr for debugging.

If the prefs file can't be fetched for any reason, this FAILS OPEN and
delivers everything: infra trouble must never silently drop alerts.
"""
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

REPO = "ReactionLabs/tyck-trade"
PREFS_FILE = "data/alert-prefs.json"
GH_PY = "/home/hatch/workspace/skills/github/bin/gh.py"
QUIET_TZ = "America/New_York"

try:
    from zoneinfo import ZoneInfo
except ImportError:  # very old python: quiet hours can't be evaluated
    ZoneInfo = None


def _key(a):
    return (a.get("mint"), a.get("ts", a.get("time")))


def load_alert_prefs():
    """Fetch alert prefs from the private repo. None = fail open."""
    try:
        r = subprocess.run(
            [GH_PY, "GET", f"/repos/{REPO}/contents/{PREFS_FILE}"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=30,
        )
        d = json.loads(r.stdout)
        if "content" not in d:
            return None  # 404 (no prefs yet) or API error: fail open
        return json.loads(base64.b64decode(d["content"]).decode("utf-8"))
    except Exception as e:  # noqa: BLE001 - any failure means fail open
        print("alert-prefs fetch failed (%s); failing open" % e,
              file=sys.stderr, flush=True)
        return None


def in_quiet_hours(prefs):
    """True when quiet hours are enabled and now (America/New_York) is in the window."""
    qh = (prefs or {}).get("quiet_hours") or {}
    if not qh.get("enabled"):
        return False
    if ZoneInfo is None:
        return False  # can't evaluate tz: fail open
    try:
        now = datetime.now(ZoneInfo(QUIET_TZ))
        cur = now.hour * 60 + now.minute

        def mins(s):
            h, m = str(s).split(":")
            return int(h) * 60 + int(m)

        start, end = mins(qh.get("start", "23:00")), mins(qh.get("end", "07:00"))
    except Exception:  # noqa: BLE001 - malformed prefs: fail open
        return False
    if start == end:
        return False
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end  # overnight window


def wallet_label(reason):
    """Extract the wallet label from a watchlist reason like 'frank bought X'."""
    m = re.match(r"^(.+?)\s+bought\s", reason or "")
    return m.group(1).strip() if m else ""


def suppression_reason(a, prefs):
    """Why this alert should be suppressed, or None to deliver it."""
    if prefs is None:
        return None  # fail open
    kind = a.get("kind", "nines")
    cats = (prefs.get("categories") or {}) if isinstance(prefs, dict) else {}
    if kind == "nines" and not cats.get("nines", True):
        return "9/9 category off"
    if kind == "smartmoney" and not cats.get("smartmoney", True):
        return "smart-money category off"
    if kind == "watchlist":
        if not cats.get("watchlist", True):
            return "watchlist category off"
        label = wallet_label(a.get("reason") or "")
        wallets = prefs.get("wallets") or {}
        for w in wallets.values():
            if isinstance(w, dict) and w.get("label") == label:
                if not w.get("enabled", True):
                    return "wallet %s off" % label
                break
        # unknown label: fail open (deliver)
    return None


def apply_prefs(alerts, prefs, quiet):
    """Split alerts into (visible, suppressed); suppressed get marked
    delivered and logged to stderr."""
    visible, n_suppressed = [], 0
    for a in alerts:
        reason = "quiet hours" if quiet else suppression_reason(a, prefs)
        if reason:
            a["delivered"] = True
            n_suppressed += 1
            print("alert suppressed (%s): %s %s" % (
                reason, a.get("kind", "nines"), a.get("mint", "?")),
                file=sys.stderr, flush=True)
        else:
            visible.append(a)
    return visible, n_suppressed


def main():
    if not os.path.exists(config.ALERTS_LOG):
        return
    with open(config.ALERTS_LOG) as f:
        lines = f.readlines()
    pending = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            a = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not a.get("delivered"):
            pending.append(a)
    if not pending:
        return
    prefs = load_alert_prefs()
    quiet = in_quiet_hours(prefs)
    if quiet:
        print("quiet hours active (%s); suppressing all alerts" % QUIET_TZ,
              file=sys.stderr, flush=True)
    nines = [a for a in pending if a.get("kind", "nines") == "nines"]
    watched = [a for a in pending if a.get("kind") == "watchlist"]
    smartmoney = [a for a in pending if a.get("kind") == "smartmoney"]
    accessreq = [a for a in pending if a.get("kind") == "access-request"]
    nines, _ = apply_prefs(nines, prefs, quiet)
    watched, _ = apply_prefs(watched, prefs, quiet)
    smartmoney, _ = apply_prefs(smartmoney, prefs, quiet)
    accessreq, _ = apply_prefs(accessreq, prefs, quiet)
    pending_keys = set(_key(p) for p in pending)
    if nines:
        print("BOT ALERT: %d coin(s) cleared the Nines:" % len(nines))
        for a in nines:
            print("  - %s (%s)" % (a.get("mint", "?"), a.get("reason", "9/9")))
            a["delivered"] = True
    if watched:
        print("WATCHLIST ALERT: %d watched-wallet buy(s):" % len(watched))
        for a in watched:
            print("  - %s" % (a.get("reason") or a.get("mint", "?")))
            a["delivered"] = True
    if smartmoney:
        print("SMARTMONEY ALERT: %d smart-money wallet buy(s):" % len(smartmoney))
        for a in smartmoney:
            print("  - %s" % (a.get("reason") or a.get("mint", "?")))
            a["delivered"] = True
    if accessreq:
        print("ACCESS REQUEST: %d wallet(s) asked for terminal access:" % len(accessreq))
        for a in accessreq:
            print("  - %s" % (a.get("reason") or a.get("mint", "?")))
            a["delivered"] = True
    # Atomic rewrite: write temp, then rename, so a crash mid-write
    # can never truncate the log and drop undelivered alerts.
    # PID-suffixed to avoid races if two cycles overlap.
    tmp = config.ALERTS_LOG + f".tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                a = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not a.get("delivered") and _key(a) in pending_keys:
                a["delivered"] = True
            f.write(json.dumps(a) + "\n")
    try:
        os.replace(tmp, config.ALERTS_LOG)
    except FileNotFoundError:
        pass  # another overlapping cycle already replaced it
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    main()
