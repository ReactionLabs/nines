# The Nines — local-first trading terminal

The full Nines stack on one machine. No Vercel, no Hostinger, no GitHub-as-a-data-pipe.
This is the powerhouse rig: real-time ingestion, the nine-gate scanner, and the
dashboard all run locally.

```
nines/
  app/          Next.js dashboard (app router)
  components/   UI components
  lib/          server libs (local-first state + stream bus)
  public/       static assets
  data/         bundled snapshots (fallback when the scanner hasn't run yet)
  ingestor/     Helius WebSocket firehose -> local app (/api/stream-ingest)
  watcher/      nine-gate scanner + smart-money watch + alerts (cron-driven)
  scripts/      one-off utilities
  run.sh        starts the app + ingestor
```

## Prerequisites

- Node 20+, Python 3.10+
- A Helius API key (ingestor WebSocket + watcher RPC)

## Quick start

```bash
cp .env.example .env && chmod 600 .env
# fill in HELIUS_API_KEY, STREAM_INGEST_TOKEN, ROLE_SECRET

./run.sh          # build + start app (http://localhost:3000) + ingestor
./run.sh dev      # dev mode with hot reload
./run.sh stop     # stop everything
```

## The 5-minute scanner cron

The watcher discovers new mints and runs nine-gate verification. It is cron-driven,
not a daemon:

```cron
*/5 * * * * cd /opt/nines && ./watcher/venv/bin/python watcher/scanner.py >> watcher/scanner.log 2>&1
*/5 * * * * cd /opt/nines && ./watcher/venv/bin/python watcher/smart_money_watch.py >> watcher/smart-money.log 2>&1
*/5 * * * * cd /opt/nines && ./watcher/venv/bin/python watcher/check_alerts.py >> watcher/alerts-cron.log 2>&1
```

(The watcher is stdlib-only + local shims; no venv is strictly required, but one
keeps things tidy. `python3 -m venv watcher/venv` if you want it.)

Adjust `/opt/nines` to your clone path. The scanner writes `watcher/state.json`;
the app reads it straight off disk via `NINES_STATE_PATH` — no network hop.

## How the pieces fit

1. **ingestor/ingestor.py** holds a Helius WebSocket on the pump.fun program,
   parses trades, and POSTs batches to `http://localhost:3000/api/stream-ingest`
   (auth: `STREAM_INGEST_TOKEN`). The app fans events out over SSE and appends
   them to `data-live/stream-events.jsonl`.
2. **watcher/scanner.py** (cron, every 5 min) discovers new mints via Helius,
   promotes mints crossing the volume threshold, and runs the nine-gate
   verification (`checks.py` — untouched). Output: `watcher/state.json`.
3. **The Next.js app** serves `/api/state` from `watcher/state.json` on disk
   (`NINES_STATE_PATH`), falling back to the bundled `data/state.json` snapshot.
4. **watcher/smart_money_watch.py** tracks smart-money wallets (cron).
   **watcher/check_alerts.py** evaluates alert prefs and sends pushes (cron).
   **watcher/publish.py** is optional: pushes state to GitHub repos (needs
   `GITHUB_TOKEN`); not required for local operation.

## Environment

See `.env.example` for the full list. The essentials:

| Var | Used by | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | ingestor, watcher | Helius WS + RPC |
| `STREAM_INGEST_TOKEN` | ingestor, app | ingestor -> app auth |
| `ROLE_SECRET` | app | session cookie signing |
| `NINES_STATE_PATH` | app, ingestor | scanner state.json (default `./watcher/state.json`) |
| `NINES_STREAM_PATH` | app | local event log (default `./data-live/stream-events.jsonl`) |
| `WALLET_ALLOWLIST` | app | wallet login (`address:role,...`) |
| `BIRDEYE_API_KEY` | app | chart candles (optional; falls back to GeckoTerminal) |

## Relationship to the cloud version

The Vercel deployment (tyck-trade) remains as a lightweight always-on monitor.
The two do not sync and do not need to: this repo is the serious local rig,
the cloud is the glanceable dashboard.
