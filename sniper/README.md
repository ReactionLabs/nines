# Paper Sniper

Paper-mode sniper for The Nines. Watches new pump.fun mints in real time,
runs an instant on-chain safety filter, and simulates $20 buys on mints
that pass. Tracks each paper position at 1m / 5m / 15m / 1h and compares
against nine-gate verdicts.

**PAPER ONLY. No wallets, no keys, no transactions. Nothing here can move
money.** The only network calls are Helius WebSocket/RPC reads and the
Jupiter SOL price API.

## Run

```bash
export HELIUS_API_KEY=...
python3 sniper/paper_sniper.py
```

Optional env:

| Var | Default | Meaning |
|---|---|---|
| `SNIPER_FEED` | `ws` | `ws` = own Helius WebSocket; `stream` = tail the local stream JSONL (`NINES_STREAM_PATH`) for pairs events from the ingestor |
| `SNIPER_SIZE_USD` | `20` | Paper size per snipe |
| `NINES_STATE_PATH` | `<repo>/watcher/state.json` | Scanner state for gate comparison |
| `NINES_LEDGER_PATH` | `<repo>/data-live/sniper-ledger.jsonl` | Where the ledger is written |

Install the one dependency first: `pip install -r sniper/requirements.txt`

## How it works

1. **Feed** (`mint_feed.py`): new mints from the Helius pump.fun firehose
   (first-seen mint = new pair), or by tailing the ingestor's stream log.
2. **Fast filter** (`fast_filter.py`): one batched `getMultipleAccounts`
   RPC fetches the mint account, both bonding-curve PDAs, and the metadata
   PDA. Target <500ms per mint, actual timing logged per signal.
   - Freeze authority enabled -> hard reject
   - No bonding curve, or curve complete (graduated) -> hard reject
   - Mint authority renounced -> +2 (soft, preferred not required)
   - Metaplex metadata with name/symbol -> +1 (soft)
3. **Paper entry**: price from the bonding curve's virtual reserves
   (`price = virtualSolReserves / virtualTokenReserves / 1000` SOL, times
   Jupiter SOL/USD), fixed $20 size.
4. **Tracking**: each position is checkpointed at 1m, 5m, 15m, 1h with
   running PnL. Graduation closes the position early.
5. **Gate comparison**: every 60s the sniper reads the scanner's
   `state.json`; when the nine gates verdict a sniper mint, it logs
   whether the gates agreed with the sniper's enter/skip decision.

## Ledger

`data-live/sniper-ledger.jsonl`, one JSON object per line:

- `signal` — filter verdict per mint (pass, score, filter_ms, checks)
- `entry` — paper buy (price, tokens, size)
- `checkpoint` — price + PnL at 1m/5m/15m/1h
- `exit` — position closed (checkpoint_done | graduated)
- `gate_verdict` — nine-gate verdict vs sniper decision (agree true/false)

Quick stats: `python3 sniper/paper_ledger.py`

## Design notes

- The sniper never imports the ingestor or watcher; it mirrors the
  ingestor's mint-detection parsing so it can run fully standalone.
- PDA derivation (`find_program_address`) is pure-python (sha256 +
  ed25519 off-curve check), no Solana SDK dependency.
- Filter concurrency is capped at 8 in-flight mints; each filter runs in a
  thread so the event loop never blocks.
- The nine-gate scanner is untouched; the sniper only reads its output.
