#!/usr/bin/env python3
"""
paper_sniper.py: paper-mode sniper for The Nines.

Watches new pump.fun mints in real time, runs the instant safety filter,
and simulates $20 buys on mints that pass. Tracks each paper position at
1m / 5m / 15m / 1h and compares against nine-gate verdicts later.

PAPER ONLY. No wallets, no keys, no transactions. The only network calls
are Helius WebSocket/RPC reads and the Jupiter SOL price API.

Usage:
    export HELIUS_API_KEY=...
    python3 sniper/paper_sniper.py

Env:
  HELIUS_API_KEY   required (Helius WS + RPC)
  SNIPER_FEED      "ws" (default) or "stream" (tail local stream JSONL)
  NINES_STATE_PATH scanner state.json (default <repo>/watcher/state.json)
  NINES_LEDGER_PATH ledger path (default <repo>/data-live/sniper-ledger.jsonl)
  SNIPER_SIZE_USD  paper size per snipe (default 20)
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fast_filter import (
    bonding_curve_pdas,
    curve_price_sol_per_token,
    filter_mint,
    parse_curve_account,
    rpc_batch,
)
from mint_feed import get_feed
from paper_ledger import PaperLedger

HELIUS_API_KEY = os.environ.get("HELIUS_API_KEY", "")
SIZE_USD = float(os.environ.get("SNIPER_SIZE_USD", "20"))
SOL_MINT = "So11111111111111111111111111111111111111112"

CHECKPOINTS = [("1m", 60), ("5m", 300), ("15m", 900), ("1h", 3600)]
FILTER_CONCURRENCY = 8
GATE_POLL_SEC = 60.0

_sol_cache: dict = {"at": 0.0, "price": 0.0}


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def sol_price_usd() -> float | None:
    """Jupiter SOL/USD, 60s cache. Last-known fallback on failure."""
    now = time.time()
    if now - _sol_cache["at"] < 60 and _sol_cache["price"] > 0:
        return _sol_cache["price"]
    try:
        req = urllib.request.Request(
            f"https://api.jup.ag/price/v3?ids={SOL_MINT}",
            headers={"Accept": "application/json", "User-Agent": "nines-sniper/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            d = json.load(resp)
        p = (d.get(SOL_MINT) or {}).get("usdPrice")
        if isinstance(p, (int, float)) and p > 0:
            _sol_cache.update(at=now, price=float(p))
            return float(p)
    except Exception as e:
        log(f"sol price fetch failed: {e!r}")
    return _sol_cache["price"] if _sol_cache["price"] > 0 else None


def curve_price_usd_sync(mint: str) -> tuple:
    """(price_usd|None, graduated: bool, error: str|None) from the curve."""
    try:
        pdas = bonding_curve_pdas(mint)
        if not pdas:
            return None, False, "no pda"
        raws = rpc_batch(HELIUS_API_KEY, pdas)
        for raw in raws:
            if not raw:
                continue
            try:
                curve = parse_curve_account(raw)
            except Exception:
                continue
            if curve["complete"]:
                return None, True, None
            sol_per_token = curve_price_sol_per_token(curve)
            if sol_per_token is None:
                return None, False, "no price"
            sol_usd = sol_price_usd()
            if sol_usd is None:
                return None, False, "no sol price"
            return sol_per_token * sol_usd, False, None
        return None, False, "no curve account"
    except Exception as e:
        return None, False, str(e)


async def track_position(mint: str, entry_usd: float, ledger: PaperLedger):
    """Checkpoint a paper position at 1m/5m/15m/1h, then close it."""
    prev_wait = 0
    try:
        for label, wait_sec in CHECKPOINTS:
            await asyncio.sleep(wait_sec - prev_wait)
            prev_wait = wait_sec
            price, graduated, err = await asyncio.to_thread(
                curve_price_usd_sync, mint
            )
            if graduated:
                ledger.checkpoint(mint, label, None, None, entry_usd)
                ledger.exit(mint, "graduated", None, None, entry_usd)
                log(f"[{mint[:8]}] graduated at {label}")
                return
            pnl = ((price - entry_usd) / entry_usd * 100) if price else None
            price_s = f"${price:.10f}" if price else "n/a"
            pnl_s = f"({pnl:+.1f}%)" if pnl is not None else ""
            ledger.checkpoint(mint, label, price, pnl, entry_usd)
            log(f"[{mint[:8]}] {label}: {price_s} {pnl_s}")
        # Final close after the 1h checkpoint.
        price, _, _ = await asyncio.to_thread(curve_price_usd_sync, mint)
        pnl = ((price - entry_usd) / entry_usd * 100) if price else None
        ledger.exit(mint, "checkpoint_done", price, pnl, entry_usd)
        log(f"[{mint[:8]}] closed: {pnl:+.1f}%" if pnl is not None
            else f"[{mint[:8]}] closed: n/a")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log(f"[{mint[:8]}] tracker error: {e!r}")


def load_gate_map() -> dict:
    """mint -> {verdict, gates_passed} from the scanner's local state.json."""
    path = os.environ.get("NINES_STATE_PATH") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "watcher", "state.json",
    )
    try:
        with open(path) as f:
            st = json.load(f)
    except Exception:
        return {}
    out = {}
    for c in st.get("candidates") or []:
        mint = c.get("mint")
        if not mint:
            continue
        gates = c.get("gates") or []
        passed = sum(1 for g in gates if g.get("passed"))
        out[mint] = {
            "verdict": c.get("verdict"),
            "gates_passed": passed,
            "gates_total": len(gates) or 9,
        }
    return out


async def gate_watch(seen: dict, logged: set, ledger: PaperLedger):
    """Every 60s, compare nine-gate verdicts against sniper decisions."""
    while True:
        await asyncio.sleep(GATE_POLL_SEC)
        try:
            gates = load_gate_map()
        except Exception as e:
            log(f"gate watch: state read failed: {e!r}")
            continue
        for mint, entered in seen.items():
            if mint in logged or mint not in gates:
                continue
            g = gates[mint]
            verdict = g["verdict"]
            gp = g["gates_passed"]
            # Agreement: sniper entered AND gates like it (ALERT or 7+/9).
            gate_positive = verdict == "ALERT" or (gp is not None and gp >= 7)
            agree = (entered and gate_positive) or (not entered and not gate_positive)
            logged.add(mint)
            ledger.gate_verdict(mint, entered, verdict, gp, agree)
            log(f"[{mint[:8]}] gates: {verdict} ({gp}/9), "
                f"sniper {'entered' if entered else 'skipped'}, "
                f"agree={agree}")


async def handle_mint(mint: str, sem: asyncio.Semaphore, ledger: PaperLedger,
                      seen: dict):
    """Filter one mint; paper-enter on pass."""
    async with sem:
        verdict = await asyncio.to_thread(filter_mint, mint, HELIUS_API_KEY)
    seen[mint] = verdict["pass"]
    ledger.signal(mint, verdict)
    status = "PASS" if verdict["pass"] else "REJECT"
    log(f"[{mint[:8]}] {status} score={verdict['score']} "
        f"{verdict['filter_ms']}ms "
        f"{verdict.get('reject_reason') or verdict['checks'].get('symbol', '')}")

    if not verdict["pass"]:
        return

    # Entry price from the curve the filter already read.
    curve = verdict.get("curve") or {}
    sol_per_token = curve_price_sol_per_token(curve) if curve else None
    sol_usd = sol_price_usd()
    if sol_per_token is None or sol_usd is None:
        log(f"[{mint[:8]}] entry skipped: no price")
        return
    entry_usd = sol_per_token * sol_usd
    tokens = SIZE_USD / entry_usd
    ledger.entry(mint, entry_usd, tokens, SIZE_USD,
                 verdict["score"], verdict["filter_ms"])
    log(f"[{mint[:8]}] PAPER ENTER ${SIZE_USD:.0f} @ ${entry_usd:.10f} "
        f"({tokens:,.0f} tokens)")
    asyncio.create_task(track_position(mint, entry_usd, ledger))


async def main():
    if not HELIUS_API_KEY:
        log("HELIUS_API_KEY must be set")
        sys.exit(1)
    ledger = PaperLedger()
    seen: dict = {}
    gate_logged: set = set()
    sem = asyncio.Semaphore(FILTER_CONCURRENCY)
    asyncio.create_task(gate_watch(seen, gate_logged, ledger))
    log(f"paper sniper live: feed={os.environ.get('SNIPER_FEED', 'ws')} "
        f"size=${SIZE_USD:.0f} ledger={ledger.path}")
    log("PAPER ONLY. No transactions will ever be built or broadcast.")
    async for mint in get_feed(HELIUS_API_KEY):
        asyncio.create_task(handle_mint(mint, sem, ledger, seen))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("stopped")
