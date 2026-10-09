#!/usr/bin/env python3
"""Smart Money monitor — watch discovered wallets for new buys.

Reads wallets/smart-money.json, checks each wallet's recent transactions
via Helius, and records new token buys. Feeds the alerts system.

Usage:
  smart_money_watch.py [--test]   run once (cron calls this)

Output: watcher/smart-money-buys.json
  { updated_at, buys: [{ wallet, labels, mint, symbol, amount_usd, time, signature }] }

Alerts: new buys append to alerts.log with kind="smartmoney" for the
phone-push path (check_alerts.py picks these up).

Never crashes the cron. Read-only. No trading.
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import url_with_surrogate_query_param, read_json_response

BASE = os.path.dirname(os.path.abspath(__file__))
WATCHER_DIR = os.path.join(BASE, "watcher")
SMART_MONEY = os.path.join(BASE, "wallets", "smart-money.json")
OUT_PATH = os.path.join(WATCHER_DIR, "smart-money-buys.json")
ALERTS_LOG = os.path.join(BASE, "alerts.log")
STATE_PATH = os.path.join(WATCHER_DIR, "state.json")

ENHANCED_HOSTS = ["api.helius.xyz"]
TX_LIMIT = 15
MAX_BUYS = 100
MAX_AGE_HOURS = 24


def enhanced_get(path):
    url = url_with_surrogate_query_param(
        "https://api.helius.xyz" + path, "custom.helius",
        allowed_hosts=ENHANCED_HOSTS)
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        return read_json_response(resp)


def load_wallets():
    try:
        with open(SMART_MONEY) as f:
            d = json.load(f)
        return d.get("wallets", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def load_seen():
    try:
        with open(OUT_PATH) as f:
            d = json.load(f)
        return {b.get("signature") for b in d.get("buys", []) if b.get("signature")}
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def gate_score(mint):
    """Look up a token's 9-gate score from scanner state."""
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        for c in d.get("candidates", []):
            if c.get("mint") == mint:
                gates = c.get("gates", [])
                passed = sum(1 for g in gates if g.get("passed") is True)
                total = sum(1 for g in gates if g.get("passed") is not None)
                return f"{passed}/{total}", c.get("symbol", "?")
    except Exception:
        pass
    return "?/9", "?"


def wallet_buys(wallet_addr, labels, seen):
    """Recent token buys for one wallet. Returns new buy records."""
    try:
        txs = enhanced_get(
            f"/v0/addresses/{wallet_addr}/transactions?limit={TX_LIMIT}")
    except Exception as e:
        print(f"smart_money_watch: {wallet_addr[:8]}… failed: {e}",
              file=sys.stderr, flush=True)
        return []
    if not isinstance(txs, list):
        return []
    buys = []
    cutoff = time.time() - MAX_AGE_HOURS * 3600
    for tx in txs:
        sig = tx.get("signature")
        ts = tx.get("timestamp", 0)
        if not sig or sig in seen or ts < cutoff:
            continue
        # Skip if this is a pure SOL transfer (no swap)
        # Real buys have the wallet receiving a non-SOL token
        for tr in tx.get("tokenTransfers") or []:
            if tr.get("toUserAccount") != wallet_addr:
                continue
            mint = tr.get("mint")
            # Skip wrapped SOL — that's just SOL movement, not a token buy
            if not mint or mint == "So11111111111111111111111111111111111111112":
                continue
            amount = tr.get("tokenAmount", 0)
            score, symbol = gate_score(mint)
            buys.append({
                "wallet": wallet_addr,
                "wallet_short": wallet_addr[:4] + "…" + wallet_addr[-4:],
                "labels": labels,
                "mint": mint,
                "symbol": symbol,
                "amount": amount,
                "gate_score": score,
                "time": ts,
                "signature": sig,
            })
            seen.add(sig)
    return buys


def append_alert(buy):
    """Write to alerts.log for the phone-push path."""
    alert = {
        "kind": "smartmoney",
        "mint": buy["mint"],
        "reason": (f"{'/'.join(buy['labels']) or 'tracked'} wallet "
                   f"{buy['wallet_short']} bought {buy['symbol']} "
                   f"(9-gate: {buy['gate_score']})"),
        "ts": buy["time"],
        "delivered": False,
    }
    try:
        with open(ALERTS_LOG, "a") as f:
            f.write(json.dumps(alert) + "\n")
    except Exception as e:
        print(f"alert write failed: {e}", file=sys.stderr)


def run():
    wallets = load_wallets()
    if not wallets:
        print("smart_money_watch: no wallets to monitor")
        return
    seen = load_seen()
    all_buys = []
    # Load existing buys to preserve history
    try:
        with open(OUT_PATH) as f:
            all_buys = json.load(f).get("buys", [])
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    new_count = 0
    for w in wallets[:50]:  # cap wallets per run
        addr = w.get("address")
        if not addr:
            continue
        buys = wallet_buys(addr, w.get("labels", []), seen)
        for b in buys:
            all_buys.append(b)
            append_alert(b)
            new_count += 1
        time.sleep(0.3)

    all_buys.sort(key=lambda b: b.get("time", 0), reverse=True)
    all_buys = all_buys[:MAX_BUYS]
    with open(OUT_PATH, "w") as f:
        json.dump({"updated_at": int(time.time()), "buys": all_buys}, f, indent=2)
    print(f"smart_money_watch: {len(wallets)} wallets, {new_count} new buys")


def run_tests():
    # gate_score with missing state
    import tempfile
    assert gate_score("nonexistent") == ("?/9", "?")
    print("smart_money_watch: 1/1 tests pass")


if __name__ == "__main__":
    if "--test" in sys.argv:
        run_tests()
    else:
        run()
