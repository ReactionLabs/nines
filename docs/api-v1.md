# Lamport Terminal — Bot API v1

Machine API for bots. The dashboard UI is for eyes; this is the interface bots
build on. Every route below is curl-able (CLI-first).

Base URL: `https://tyck-trade.vercel.app` (custom domain coming)

## Authentication

API keys, per bot. Pass via header (preferred) or query param:

```bash
curl -H "X-API-Key: lt_..." https://tyck-trade.vercel.app/api/v1/candidates
# or
curl "https://tyck-trade.vercel.app/api/v1/candidates?key=lt_..."
```

- Missing/invalid key → `401 {ok:false, error:"unauthorized", ...}`
- Keys are `lt_` + 43 chars. Only SHA-256 hashes are stored server-side
  (`BOT_API_KEY_HASHES` env var). The plaintext is shown once at issuance.
- Issuing a key (run by the operator):
  ```bash
  node scripts/issue-api-key.mjs my-bot
  # -> prints the key (once) + the hash to append to BOT_API_KEY_HASHES
  ```

## Rate limits

60 requests/minute per key (per server instance, best-effort). Exceeding it:

```
429 {ok:false, error:"rate_limited", message:"rate limit exceeded (60 req/min)"}
Retry-After: 17
```

## Errors

All errors are JSON: `{ok:false, error:"code", message:"..."}`.

| code | status | meaning |
|---|---|---|
| `unauthorized` | 401 | missing or invalid API key |
| `invalid_mint` | 400 | mint is not a 32–44 char base58 address |
| `invalid_tf` | 400 | unknown timeframe |
| `rate_limited` | 429 | per-key quota exceeded (also from upstream chart provider) |
| `upstream_error` | 502 | scanner state or chart provider unreachable |

## Routes

### GET /api/v1/candidates

Token candidate feed (scanner output).

```bash
curl -H "X-API-Key: $KEY" https://tyck-trade.vercel.app/api/v1/candidates
```

```json
{
  "ok": true,
  "live": true,
  "updated_at": 1791497000,
  "count": 100,
  "candidates": [
    {
      "mint": "9oxWMhM4QN1hLGNutaTFcBjMjJce6QxrvVxAcGW6pump",
      "launchpad": "pump.fun",
      "first_seen": 1791490000,
      "tier": "day1",
      "volume_usd": 3292496.75,
      "image_url": "https://...",
      "gates": [ {"gate": 1, "name": "...", "pass": true, ...} ],
      "verdict": "ALERT",
      "partial": false,
      "alerted": true,
      "alerted_at": 1791490100,
      "reason": "all gates passed"
    }
  ]
}
```

Live price/market-cap per token come from `/api/v1/ticks`; the scanner
record is the source of truth for gates and verdicts.

### GET /api/v1/candles?mint={mint}&tf={tf}

Candles. `tf`: `1m | 5m | 15m | 1H` (history) or `1s | 5s | 15s | 30s` (live ticks).

```bash
curl -H "X-API-Key: $KEY" \
  "https://tyck-trade.vercel.app/api/v1/candles?mint=9oxWMhM4QN1hLGNutaTFcBjMjJce6QxrvVxAcGW6pump&tf=5m"
```

```json
{
  "ok": true, "mint": "...", "tf": "5m",
  "source": "history", "pool": "AbC...",
  "count": 194,
  "candles": [
    { "time": 1791488340, "open": 0.00041, "high": 0.00042,
      "low": 0.00040, "close": 0.000415, "volume": 1234.5 }
  ]
}
```

History candles (`source:"history"`) are complete and reliable. Tick
candles (`source:"ticks"`) aggregate from the live engine; tick sessions are
per server instance, so for sub-minute streaming prefer polling
`/api/v1/ticks` and aggregating client-side (see pattern below).

### GET /api/v1/ticks?mint={mint}

Live price sample. The recommended streaming primitive: poll ~1/s.

```bash
curl -H "X-API-Key: $KEY" \
  "https://tyck-trade.vercel.app/api/v1/ticks?mint=9oxWMhM4QN1hLGNutaTFcBjMjJce6QxrvVxAcGW6pump"
```

```json
{
  "ok": true, "mint": "...",
  "price": 0.0004087, "source": "dexscreener",
  "tickCount": 43, "degraded": false,
  "serverTime": 1791497550000
}
```

`source` is `curve` (bonding curve), `dexscreener`, or `jupiter`.
`degraded:true` means the last upstream fetch failed and the price is stale —
treat with suspicion.

Client-side 5s candle aggregation (Python):

```python
import time, requests
H = {"X-API-Key": KEY}
ticks = []
while True:
    r = requests.get(f"{BASE}/api/v1/ticks", params={"mint": MINT}, headers=H, timeout=10).json()
    ticks.append((time.time(), r["price"]))
    # bucket into 5s candles...
    time.sleep(1)
```

### GET /api/v1/whale-buys?mint={mint}

Tracked-wallet buys, newest first. Empty until the operator supplies the
whitelist — then this lights up without any API change.

```bash
curl -H "X-API-Key: $KEY" \
  "https://tyck-trade.vercel.app/api/v1/whale-buys?mint=9oxWMhM4QN1hLGNutaTFcBjMjJce6QxrvVxAcGW6pump"
```

```json
{
  "ok": true, "mint": "...", "updatedAt": 1791497000,
  "walletCount": 0, "count": 0,
  "buys": [
    { "wallet": "AbC...", "amount": 1500000, "time": 1791496900,
      "signature": "5x..." }
  ]
}
```

### GET /api/v1/alerts

Fired alerts (every gate passed). Newest first. Poll to drive attention;
never trade on an alert without your own checks.

```bash
curl -H "X-API-Key: $KEY" https://tyck-trade.vercel.app/api/v1/alerts
```

```json
{
  "ok": true, "live": true, "updated_at": 1791497000, "count": 2,
  "alerts": [
    { "mint": "...", "tier": "day1", "reason": "all gates passed",
      "at": 1791496900 }
  ]
}
```

## What this API does NOT do

- No trade execution. There is no bot-trading endpoint by design; execution
  stays manual-approval-gated.
- No websocket streams yet (next phase).
- No dashboard login via API key — keys are for `/api/v1/*` only. The
  dashboard keeps its wallet + cookie auth.
