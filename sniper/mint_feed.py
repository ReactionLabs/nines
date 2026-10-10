#!/usr/bin/env python3
"""
mint_feed.py: new-mint event sources for the paper sniper.

Two feeds, selected by SNIPER_FEED env (default "ws"):

  ws      Own Helius WebSocket logsSubscribe on the pump.fun program.
          First-seen mint = brand-new pair. Parsing mirrors
          ingestor/ingestor.py (same discriminator + 129-byte prefix).
          Standalone: works even if the ingestor/app are down.

  stream  Tail the local stream JSONL (NINES_STREAM_PATH, default
          <repo>/data-live/stream-events.jsonl) for topic == "pairs"
          events written by the app from the ingestor. Use this when
          running the full local stack so we don't open a second WS.

Both are async generators yielding mint address strings.
"""

import asyncio
import base64
import json
import os
import re
import struct
import sys
import time

PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TRADE_DISC = bytes.fromhex("bddb7fd34ee661ee")
TRADE_PREFIX_LEN = 129
PROGRAM_DATA_RE = re.compile(r"Program data:\s*([A-Za-z0-9+/=]{32,})")
B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = B58_ALPHABET[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


async def feed_ws(api_key: str):
    """Yield new pump.fun mints from our own Helius WebSocket."""
    try:
        import websockets
    except ImportError:
        log("missing dependency: pip install -r sniper/requirements.txt")
        sys.exit(1)

    ws_url = f"wss://mainnet.helius-rpc.com/?api-key={api_key}"
    seen: set = set()
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(
                ws_url, ping_interval=20, ping_timeout=10,
                max_size=4 * 1024 * 1024,
            ) as ws:
                log("sniper WS connected")
                backoff = 1.0
                await ws.send(json.dumps({
                    "jsonrpc": "2.0", "id": 1,
                    "method": "logsSubscribe",
                    "params": [
                        {"mentions": [PUMPFUN_PROGRAM]},
                        {"commitment": "processed"},
                    ],
                }))
                async for msg in ws:
                    try:
                        payload = json.loads(msg)
                    except Exception:
                        continue
                    val = (payload.get("params") or {}).get("result", {}).get("value") or {}
                    if val.get("err"):
                        continue
                    for line in val.get("logs") or []:
                        m = PROGRAM_DATA_RE.search(line)
                        if not m:
                            continue
                        try:
                            raw = base64.b64decode(m.group(1))
                        except Exception:
                            continue
                        if len(raw) < TRADE_PREFIX_LEN or raw[:8] != TRADE_DISC:
                            continue
                        mint = b58encode(raw[8:40])
                        if mint not in seen:
                            seen.add(mint)
                            yield mint
        except Exception as e:
            log(f"sniper WS error, reconnecting in {backoff:.0f}s: {e!r}")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


async def feed_stream(path: str | None = None):
    """Tail the local stream JSONL for pairs (new mint) events."""
    p = path or os.environ.get("NINES_STREAM_PATH") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "data-live", "stream-events.jsonl",
    )
    log(f"sniper tailing stream: {p}")
    seen: set = set()
    # Start at end of file: only new pairs from now on.
    try:
        pos = os.path.getsize(p)
    except OSError:
        pos = 0
    while True:
        try:
            with open(p, "r") as f:
                f.seek(pos)
                for line in f:
                    pos = f.tell()
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    if e.get("topic") != "pairs":
                        continue
                    mint = e.get("mint")
                    if mint and mint not in seen:
                        seen.add(mint)
                        yield mint
        except FileNotFoundError:
            pass
        await asyncio.sleep(1.0)


def get_feed(api_key: str):
    mode = os.environ.get("SNIPER_FEED", "ws").strip().lower()
    if mode == "stream":
        return feed_stream()
    return feed_ws(api_key)
