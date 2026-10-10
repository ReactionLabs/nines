#!/usr/bin/env python3
"""
paper_ledger.py: append-only JSONL ledger for the paper sniper.

One JSON line per event. Event types:
  signal       fast-filter verdict for a new mint
  entry        paper buy simulated ($20 fixed)
  checkpoint   price check at 1m / 5m / 15m / 1h with running PnL
  exit         position closed (reason: checkpoint_done | graduated | error)
  gate_verdict nine-gate scanner verdict for a sniper mint (agreement measure)

Default path: <repo>/data-live/sniper-ledger.jsonl (NINES_LEDGER_PATH
overrides). The directory is created on first write.
"""

import json
import os
import time

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data-live",
    "sniper-ledger.jsonl",
)


class PaperLedger:
    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get("NINES_LEDGER_PATH") or DEFAULT_PATH
        d = os.path.dirname(self.path)
        if d:
            os.makedirs(d, exist_ok=True)

    def _write(self, event: dict):
        event = {"ts": int(time.time() * 1000), **event}
        with open(self.path, "a") as f:
            f.write(json.dumps(event, separators=(",", ":")) + "\n")

    def signal(self, mint: str, verdict: dict):
        self._write({
            "event": "signal",
            "mint": mint,
            "pass": verdict["pass"],
            "score": verdict["score"],
            "filter_ms": verdict["filter_ms"],
            "reject_reason": verdict.get("reject_reason"),
            "checks": verdict.get("checks", {}),
        })

    def entry(self, mint: str, price_usd: float, tokens: float,
              size_usd: float, score: int, filter_ms: float):
        self._write({
            "event": "entry",
            "mint": mint,
            "price_usd": price_usd,
            "tokens": tokens,
            "size_usd": size_usd,
            "filter_score": score,
            "filter_ms": filter_ms,
        })

    def checkpoint(self, mint: str, label: str, price_usd: float | None,
                   pnl_pct: float | None, entry_usd: float):
        self._write({
            "event": "checkpoint",
            "mint": mint,
            "at": label,
            "price_usd": price_usd,
            "pnl_pct": pnl_pct,
            "entry_usd": entry_usd,
        })

    def exit(self, mint: str, reason: str, price_usd: float | None,
             pnl_pct: float | None, entry_usd: float):
        self._write({
            "event": "exit",
            "mint": mint,
            "reason": reason,
            "price_usd": price_usd,
            "pnl_pct": pnl_pct,
            "entry_usd": entry_usd,
        })

    def gate_verdict(self, mint: str, sniper_entered: bool,
                     gate_verdict: str | None, gates_passed: int | None,
                     agree: bool | None):
        self._write({
            "event": "gate_verdict",
            "mint": mint,
            "sniper_entered": sniper_entered,
            "gate_verdict": gate_verdict,
            "gates_passed": gates_passed,
            "agree": agree,
        })


def summarize(path: str | None = None) -> dict:
    """Quick stats over the ledger. For the CLI / README."""
    p = path or os.environ.get("NINES_LEDGER_PATH") or DEFAULT_PATH
    stats = {"signals": 0, "entries": 0, "exits": 0, "wins": 0, "losses": 0,
             "avg_filter_ms": 0.0, "checkpoints": 0}
    fms = []
    try:
        with open(p) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                t = e.get("event")
                if t == "signal":
                    stats["signals"] += 1
                    if isinstance(e.get("filter_ms"), (int, float)):
                        fms.append(e["filter_ms"])
                elif t == "entry":
                    stats["entries"] += 1
                elif t == "checkpoint":
                    stats["checkpoints"] += 1
                elif t == "exit":
                    stats["exits"] += 1
                    pnl = e.get("pnl_pct")
                    if isinstance(pnl, (int, float)):
                        if pnl > 0:
                            stats["wins"] += 1
                        elif pnl < 0:
                            stats["losses"] += 1
    except FileNotFoundError:
        pass
    if fms:
        stats["avg_filter_ms"] = round(sum(fms) / len(fms), 1)
    return stats


if __name__ == "__main__":
    print(json.dumps(summarize(), indent=2))
