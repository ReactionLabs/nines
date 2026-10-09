# Nines Trading Harness — Box Agent Spec

This is the build spec for the persistent trading harness running on the Hostinger box.
The harness is the engine room. Vercel is the API + frontend. The box never sleeps.

## Architecture

```
Hostinger Box (always-on)          Vercel (serverless)
─────────────────────────          ────────────────────
│ Stream Ingestor        │──push──▶│ /api/stream-ingest │
│ 9-Gate Evaluator       │──push──▶│ /api/stream-ingest │
│ Token Metadata Service │──push──▶│ /api/stream-ingest │
│ Smart Money Tracker    │──push──▶│ /api/stream-ingest │
│ Candle Builder         │──push──▶│ /api/stream-ingest │
─────────────────────────          ────────────────────
```

All services push normalized events to `POST https://nines.getbag.app/api/stream-ingest`
with `Authorization: Bearer <STREAM_INGEST_TOKEN>`.

## 1. Stream Ingestor ✅ DONE

**Status:** Live on Hostinger as `nines-harness` systemd service.

- 5 parallel Helius WebSocket connections (one per launchpad)
- Programs:
  - pumpfun: `6EF8rrecthR5Dad8TK9pTp8BFSQStVffw9DL8D6k`
  - pumpamm: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
  - raydium: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
  - orca: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
  - meteora: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
- Parses TradeEvents, pushes `{topic: "trades"}` and `{topic: "pairs"}` events
- Dropped (unverified IDs): moonshot, bonkfun, stonk, bags — add when verified

## 2. 9-Gate Evaluator 🔨 BUILD

**Goal:** Score every new pair the instant it's detected. No cron, no polling delay.

- Trigger: stream `pairs` event → run 9 gates immediately
- The 9 gates are sacred — do not change the logic, only the trigger
- Push result as `{topic: "gate-score", mint, data: {score: "7/9", passed: [...], failed: [...]}}`
- Must complete in <2 seconds per pair

**Done means:** New pair appears in dashboard with gate score within 2 seconds of on-chain creation.

## 3. Token Metadata Service 🔨 BUILD

**Goal:** No more "?" — every token shows name, symbol, image.

- Trigger: stream `pairs` event → fetch metadata immediately
- Sources (in order): Metaplex on-chain metadata → pump.fun API → Jupiter token list
- Extract: name, symbol, image URL, description
- Push as `{topic: "metadata", mint, data: {name, symbol, image, description}}`
- Cache aggressively — don't refetch known mints

**Done means:** Every new pair shows real name, symbol, and logo within 5 seconds.

## 4. Smart Money Tracker 🔨 BUILD

**Goal:** Track smart wallets, resolve symbols properly, kill the junk alerts.

- Watch the configured smart money wallets via Helius
- On buy: resolve token symbol + gate score BEFORE creating alert
- **Never emit an alert with "?" symbol** — skip it, log it, move on
- Exclude: USDC, wSOL, program accounts, system addresses
- Dedupe by signature (durable, not capped at 100)
- Push as `{topic: "smartmoney", mint, data: {wallet, symbol, amount, price, gate_score}}`

**Done means:** Smart money alerts have real symbols, real gate scores, zero "?" entries.

## 5. Candle Builder 🔨 BUILD

**Goal:** Aggregate the trade stream into OHLCV candles for charts.

- Input: stream `trades` events
- Output timeframes: 1s, 5s, 15s, 1m, 5m, 15m, 1h
- Push as `{topic: "candles", mint, data: {timeframe: "1s", o, h, l, c, v, ts}}}`
- Keep last 1000 candles per mint per timeframe in memory
- New pairs start building candles from first trade

**Done means:** Charts can request any timeframe and get live-updating candles.

## Event Envelope

All pushes use this format:

```json
{
  "topic": "trades" | "pairs" | "gate-score" | "metadata" | "smartmoney" | "candles",
  "ts": 1728470400000,
  "mint": "<token mint address>",
  "data": { ... topic-specific ... }
}
```

Batch pushes: up to 100 events per POST, flush every ~1 second.

## Service Requirements

- Each service: systemd unit, auto-restart, start on boot
- Directory: `/opt/nines-harness/<service-name>/`
- Logs: journald, structured (timestamp, service, msg/s, errors)
- Environment: `/opt/nines-harness/.env` with `HELIUS_API_KEY` and `STREAM_INGEST_TOKEN`
- Health check: each service logs a heartbeat every 30s
- Coexists with NewsLiar — don't touch its files

## Build Order

1. ✅ Stream Ingestor (done)
2. 9-Gate Evaluator (highest impact — makes scores real-time)
3. Token Metadata Service (kills the "?" problem)
4. Candle Builder (unblocks the chart rework)
5. Smart Money Tracker (fixes the junk alerts)

## What Done Looks Like

- All 5 services running as systemd units, zero errors
- New pair → metadata + gate score + candles all live within 5 seconds
- Dashboard shows live data with no "?" anywhere
- Smart money alerts have real symbols or don't fire
- `systemctl status nines-*` all green
