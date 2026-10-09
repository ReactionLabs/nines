#!/usr/bin/env python3
"""
nines-ingestor: Solana firehose ingestor for The Nines terminal.

Holds a Helius WebSocket open on the pump.fun program, parses TradeEvent
(new buys/sells) from program logs, normalizes them, and pushes batches
to the local app's stream-ingest endpoint. The frontend gets real-time
updates via SSE from the same machine.

Firehose-ready: one subscription sees EVERY pump.fun trade. Filtering to
the "interesting" mint set happens here at the source so the push stays
lean; when we open the full pipe, the filter set just widens.

Supervision: run.sh starts this alongside the app; systemd unit included
for servers (Restart=always). Inside, the WS loop reconnects with
exponential backoff, so transient Helius hiccups never kill the process.

Env (in .env, chmod 600):
  HELIUS_API_KEY      Helius API key (WS + nothing else)
  STREAM_INGEST_TOKEN bearer token for POST /api/stream-ingest (must match
                      the app's STREAM_INGEST_TOKEN)
  NINES_INGEST_URL    App base URL (default http://localhost:3000)
  NINES_STATE_PATH    Scanner state.json path (default <repo>/watcher/state.json)
"""

import asyncio
import base64
import json
import os
import re
import struct
import sys
import time
import urllib.request

try:
    import websockets
except ImportError:
    sys.stderr.write("missing dependency: pip install -r requirements.txt\n")
    sys.exit(1)

# ---------------------------------------------------------------- config

PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
LAMPORTS = 1_000_000_000

HELIUS_API_KEY = os.environ.get("HELIUS_API_KEY", "")
# Bearer token for POST /api/stream-ingest (STREAM_INGEST_TOKEN in the app's env).
INGEST_TOKEN = os.environ.get("STREAM_INGEST_TOKEN", "")
# Local-first: the ingestor pushes to the app on this machine.
# NINES_INGEST_URL overrides; VERCEL_URL is kept for backward compat.
_INGEST_BASE = os.environ.get("NINES_INGEST_URL") or os.environ.get(
    "VERCEL_URL", "http://localhost:3000"
)
INGEST_BASE = _INGEST_BASE.rstrip("/")
# Local-first: the interesting-mint set is read from the scanner's local
# state.json when NINES_STATE_PATH is set (or the default watcher path);
# STATE_URL remains as a fallback for remote operation.
LOCAL_STATE_PATH = os.environ.get("NINES_STATE_PATH", "")
STATE_URL = os.environ.get(
    "STATE_URL",
    "https://raw.githubusercontent.com/ReactionLabs/tyck-trade-data/main/state.json",
)

if not HELIUS_API_KEY or not INGEST_TOKEN:
    sys.stderr.write("HELIUS_API_KEY and STREAM_INGEST_TOKEN must be set\n")
    sys.exit(1)

WS_URL = f"wss://mainnet.helius-rpc.com/?api-key={HELIUS_API_KEY}"
INGEST_URL = f"{INGEST_BASE}/api/stream-ingest"

# Anchor event discriminators for the current pump.fun program
# (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P).
# NOTE: sha256("global:TradeEvent") does NOT match; the program's IDL
# names the event differently, but the on-chain discriminator is
# bddb7fd34ee661ee and the 129-byte prefix layout is unchanged. The
# program appends extra fields (holder rewards etc.) after byte 129,
# so we require len >= 129 and parse only the prefix we need.
TRADE_DISC = bytes.fromhex("bddb7fd34ee661ee")
TRADE_PREFIX_LEN = 129  # 8 disc + mint(32) + sol(8) + tokens(8) + isBuy(1) + user(32) + ts(8)
PROGRAM_DATA_RE = re.compile(r"Program data:\s*([A-Za-z0-9+/=]{32,})")

# Push cadence / caps
FLUSH_INTERVAL = 1.0          # seconds between POST batches
MAX_BATCH = 200               # events per POST
MAX_QUEUE = 5_000             # drop oldest beyond this
PRICE_MIN_INTERVAL = 5.0      # seconds between price ticks per mint
PRICE_MIN_MOVE = 0.003        # ...unless price moved >0.3%
INTERESTING_REFRESH = 60.0    # seconds between state.json refetches
INTERESTING_CAP = 400         # max mints in the filter set
STATUS_INTERVAL = 30.0        # seconds between ingestor status events

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = B58_ALPHABET[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def parse_trade(raw: bytes):
    """pump.fun TradeEvent prefix -> dict or None.

    Parses the stable 129-byte prefix (mint through timestamp); the
    program appends extra fields after that which we ignore.
    """
    if len(raw) < TRADE_PREFIX_LEN or raw[:8] != TRADE_DISC:
        return None
    o = 8
    mint = b58encode(raw[o:o + 32]); o += 32
    sol_amount = struct.unpack_from("<Q", raw, o)[0] / LAMPORTS; o += 8
    token_amount = struct.unpack_from("<Q", raw, o)[0] / 1e6; o += 8
    is_buy = raw[o] == 1; o += 1
    user = b58encode(raw[o:o + 32]); o += 32
    return {
        "type": "trade", "mint": mint, "isBuy": is_buy,
        "sol": sol_amount, "tokens": token_amount, "user": user,
    }


# ---------------------------------------------------------------- state

interesting: set = set()          # mints we push trades/prices for
seen_mints: set = set()           # every mint seen on the firehose
queue: list = []                  # pending events for Vercel
last_price: dict = {}             # mint -> (price, emitted_at)
stats = {"ws_msgs": 0, "trades": 0, "pairs": 0, "pushed": 0, "dropped": 0,
         "ws_reconnects": 0, "start": time.time()}


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def _load_state():
    """Load the scanner state: local file first, STATE_URL fallback."""
    if LOCAL_STATE_PATH:
        try:
            with open(LOCAL_STATE_PATH) as f:
                return json.load(f), "local"
        except Exception:
            pass
    # Default local path: <repo>/watcher/state.json relative to this file.
    default_local = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "watcher",
        "state.json",
    )
    try:
        with open(default_local) as f:
            return json.load(f), "local"
    except Exception:
        pass
    req = urllib.request.Request(STATE_URL, headers={"User-Agent": "nines-ingestor/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp), "remote"


def refresh_interesting():
    """Pull candidate mints from the scanner state (best-effort)."""
    global interesting
    try:
        st, src = _load_state()
        mints = {c.get("mint") for c in (st.get("candidates") or []) if c.get("mint")}
        mints |= {a.get("mint") for a in (st.get("alerts") or []) if a.get("mint")}
        interesting = set(list(mints)[:INTERESTING_CAP])
        log(f"interesting set: {len(interesting)} mints ({src})")
    except Exception as e:
        log(f"state refresh failed (keeping {len(interesting)}): {e!r}")


def enqueue(topic: str, mint: str | None, data: dict):
    """Queue one event in the /api/stream-ingest envelope shape."""
    ev: dict = {
        "topic": topic,
        "ts": int(time.time() * 1000),
        "data": data,
    }
    if mint:
        ev["mint"] = mint
    if len(queue) >= MAX_QUEUE:
        del queue[: len(queue) - MAX_QUEUE + 1]
        stats["dropped"] += 1
    queue.append(ev)


def handle_notification(payload: dict):
    """One logsSubscribe notification -> zero or more events."""
    stats["ws_msgs"] += 1
    val = (payload.get("params") or {}).get("result", {}).get("value") or {}
    if val.get("err"):
        return
    logs = val.get("logs") or []
    sig = val.get("signature") or ""
    if not sig:
        return
    for line in logs:
        m = PROGRAM_DATA_RE.search(line)
        if not m:
            continue
        try:
            raw = base64.b64decode(m.group(1))
        except Exception:
            continue
        if len(raw) < TRADE_PREFIX_LEN or raw[:8] != TRADE_DISC:
            continue
        t = parse_trade(raw)
        if not t:
            continue
        stats["trades"] += 1
        # First-seen mint on the firehose = brand-new pair. The scanner
        # fills in name/symbol/metrics within minutes via state.json.
        if t["mint"] not in seen_mints:
            seen_mints.add(t["mint"])
            stats["pairs"] += 1
            enqueue("pairs", t["mint"], {"sig": sig})
        if t["mint"] not in interesting:
            continue
        enqueue("trades", t["mint"], {
            "sig": sig,
            "isBuy": t["isBuy"],
            "sol": t["sol"],
            "tokens": t["tokens"],
            "user": t["user"],
        })
        # price tick: per-token SOL price, throttled
        if t["tokens"] > 0:
            price = t["sol"] / t["tokens"]
            prev, prev_at = last_price.get(t["mint"], (0.0, 0.0))
            now = time.time()
            moved = prev > 0 and abs(price - prev) / prev >= PRICE_MIN_MOVE
            if prev == 0.0 or moved or now - prev_at >= PRICE_MIN_INTERVAL:
                last_price[t["mint"]] = (price, now)
                enqueue("prices", t["mint"], {"price": price})


def push_batch() -> bool:
    """POST one batch to Vercel. Returns True on success."""
    if not queue:
        return True
    batch = queue[:MAX_BATCH]
    body = json.dumps({"events": batch}).encode()
    req = urllib.request.Request(
        INGEST_URL, data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {INGEST_TOKEN}",
            "User-Agent": "nines-ingestor/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ok = resp.status == 200
    except Exception as e:
        log(f"ingest POST failed: {e!r}")
        return False
    if ok:
        del queue[: len(batch)]
        stats["pushed"] += len(batch)
    return ok


async def ws_loop():
    backoff = 1.0
    sub_id = 1
    while True:
        try:
            async with websockets.connect(
                WS_URL, ping_interval=20, ping_timeout=10,
                max_size=4 * 1024 * 1024,
            ) as ws:
                log("WS connected")
                stats["ws_reconnects"] += 1 if backoff > 1 else 0
                backoff = 1.0
                await ws.send(json.dumps({
                    "jsonrpc": "2.0", "id": sub_id,
                    "method": "logsSubscribe",
                    "params": [
                        {"mentions": [PUMPFUN_PROGRAM]},
                        {"commitment": "processed"},
                    ],
                }))
                sub_id += 1
                async for msg in ws:
                    try:
                        handle_notification(json.loads(msg))
                    except Exception as e:
                        log(f"parse error: {e!r}")
        except Exception as e:
            log(f"WS error, reconnecting in {backoff:.0f}s: {e!r}")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


async def flush_loop():
    while True:
        await asyncio.sleep(FLUSH_INTERVAL)
        if queue:
            push_batch()


async def status_loop():
    while True:
        await asyncio.sleep(STATUS_INTERVAL)
        uptime = int(time.time() - stats["start"])
        mps = stats["ws_msgs"] / max(uptime, 1)
        enqueue("status", None, {
            "msgPerSec": round(mps, 1),
            "pairsSeen": stats["pairs"],
            "tradesSeen": stats["trades"],
            "pushed": stats["pushed"],
            "dropped": stats["dropped"],
            "interesting": len(interesting),
            "queue": len(queue),
            "uptimeSec": uptime,
        })
        log(f"status: {mps:.0f} msg/s, pairs={stats['pairs']} "
            f"trades={stats['trades']} pushed={stats['pushed']} "
            f"queue={len(queue)} interesting={len(interesting)}")


async def interesting_loop():
    while True:
        refresh_interesting()
        await asyncio.sleep(INTERESTING_REFRESH)


async def main():
    log(f"nines-ingestor starting -> {INGEST_URL}")
    refresh_interesting()
    await asyncio.gather(
        ws_loop(), flush_loop(), status_loop(), interesting_loop(),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
