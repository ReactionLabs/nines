#!/usr/bin/env python3
"""tyck.trade 24/7 watcher: discover new mints across launchpads, hold them on
a volume watchlist, promote volume-proven mints through the Nines, and
queue alerts for tier candidates.

Designed to run on a cron every 5 minutes:
    */5 * * * * /usr/bin/python3 /home/hatch/workspace/trading-bot/watcher/scanner.py >> /home/hatch/workspace/trading-bot/watcher/cron.log 2>&1

Discovery: Helius Enhanced Transactions per launchpad program -
  GET api.helius.xyz/v0/addresses/{program}/transactions?type=CREATE
  (newest first). pump.fun is polled every run; the other enabled launchpads
  rotate round-robin (2 per poll, index persisted in state.json) to respect the
  Helius free tier. The new coin's mint comes from tokenTransfers[].mint.
  Per-launchpad sanity filters apply (pump.fun mints end in "pump", bags mints
  end in "BAGS"). All on Helius with the surrogate credential; no keys anywhere
  in files.

Why not getProgramAccounts: the pump.fun program owns millions of
bonding-curve accounts and getProgramAccounts has no pagination, so one
unfiltered call can never complete on a public RPC (multi-GB response,
provider caps). Raw getSignaturesForAddress polling was measured live and is
also infeasible: ~9k program txs/min at peak, creates are <2% of them, and each
getTransaction takes ~1s - finding 10 creates would take 20+ minutes and
thousands of RPC calls. The type=CREATE enhanced-transactions feed is the
rate-friendly equivalent. See RUNBOOK.md.

Volume watchlist: newly discovered mints go to the watchlist (NOT the
candidate feed). Each poll refreshes 24h volume via the DexScreener free API
(batched, 30 mints/call, no key). When a mint's trailing 24h volume crosses
MIN_VOLUME_USD ($1000), it is PROMOTED: full gate verification runs and it
moves to the candidate feed. Sub-$1k mints sit in the watchlist until they
cross or age out (WATCHLIST_TTL_HOURS); aged-out mints stay in seen.json so
they are never re-added.

Verification: reuses checks.run_all() from the existing bot WITHOUT changing
it. Gate policy for the watcher only:
  - gates 1-5 must all pass (any non-stub gate failing -> verdict PASS)
  - gates 6-7 evaluate as STUB (passed=null) while wallets/whitelist.txt and
    wallets/blacklist.txt are empty templates -> verdict ALERT with partial=true
  - gate 5 (liquidity) per launchpad: pump.fun keeps the bonding-curve read
    from checks.py. For other launchpads the read is attempted via the
    mint's best DexScreener pair liquidity; if liquidity is UNREADABLE for
    that launchpad, gate 5 = FAIL-closed (passed=false) - never passes blind.
  - gates 8-9 are informational bonus lines, never block
This does not touch the CLI's strict cleared-the-Nines behavior.

Alerts: calls ../notify.py <mint> <reason>, which appends to alerts.log (the
queue the existing chat cron watches for phone push). One alert per mint ever.
--dry-run skips notify.py (used for testing).

Writes watcher/state.json every run (exact schema in RUNBOOK.md) and maintains
watcher/seen.json (mint -> first_seen epoch).

Anti-goals honored: no buy/sell/signing code, no keys in files (surrogate
helius_rpc only), no changes to existing bot files or journal format.

Exit codes: 0 = ok, 1 = already running (lock held), 2 = scanner error
(state.json records it, no alerts fired).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

WATCHER_DIR = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.path.dirname(WATCHER_DIR)

# --- Helius access. The JSON-RPC wrapper must be installed BEFORE checks.py
# imports helius_rpc, so every RPC checks.py makes (getAsset, getTokenSupply,
# getAccountInfo, ...) goes through the same 429 policy. Existing bot files
# are not modified. ---
#
# Local-first: prefer the portable shims shipped in this directory
# (helius_rpc.py, dynamic_credentials.py — env-var based). The Hatch skill
# paths are kept as fallback so the same file still runs on the Hatch box.
# NOTE: WATCHER_DIR is inserted LAST so it lands at sys.path[0] and wins.
sys.path.insert(0, os.path.expanduser("~/workspace/skills/helius/bin"))
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
sys.path.insert(0, WATCHER_DIR)
import helius_rpc  # noqa: E402

from dynamic_credentials import (  # noqa: E402
    url_with_surrogate_query_param,
    read_json_response,
)

BACKOFF_SECS = 3
MAX_429_EVENTS = 3  # 429s seen this run before we give up entirely


class RateLimited(Exception):
    pass


_429_events = 0


def _note_429():
    global _429_events
    _429_events += 1
    if _429_events >= MAX_429_EVENTS:
        raise RateLimited("Helius 429 rate limit hit %d times this run" % _429_events)
    time.sleep(BACKOFF_SECS)


_orig_rpc = helius_rpc.rpc


def _rpc_with_backoff(method, params):
    """One retry after a short backoff on HTTP 429; repeated 429s abort the run."""
    try:
        return _orig_rpc(method, params)
    except urllib.error.HTTPError as e:
        if getattr(e, "code", None) != 429:
            raise
        _note_429()
        try:
            return _orig_rpc(method, params)
        except urllib.error.HTTPError as e2:
            if getattr(e2, "code", None) == 429:
                _note_429()
                raise RateLimited("Helius 429 persisted after backoff")
            raise


helius_rpc.rpc = _rpc_with_backoff

ENHANCED_HOSTS = ["api.helius.xyz"]


def helius_enhanced(path):
    """GET against the Helius Enhanced Transactions API (surrogate credential)."""
    url = url_with_surrogate_query_param(
        "https://api.helius.xyz" + path, "custom.helius", allowed_hosts=ENHANCED_HOSTS
    )
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    try:
        return read_json_response(urllib.request.urlopen(req, timeout=40))
    except urllib.error.HTTPError as e:
        if getattr(e, "code", None) != 429:
            raise
        _note_429()
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
        try:
            return read_json_response(urllib.request.urlopen(req, timeout=40))
        except urllib.error.HTTPError as e2:
            if getattr(e2, "code", None) == 429:
                _note_429()
                raise RateLimited("Helius 429 persisted after backoff")
            raise


sys.path.insert(0, BOT_DIR)
import checks  # noqa: E402
import config  # noqa: E402

# --- constants ---
SEEN_FILE = os.path.join(WATCHER_DIR, "seen.json")
STATE_FILE = os.path.join(WATCHER_DIR, "state.json")
LOCK_FILE = os.path.join(WATCHER_DIR, ".scanner.lock")

MAX_NEW_MINTS_PER_RUN = 10   # discovery adds AND promotions, each capped at 10
CREATE_FEED_LIMIT = 100
MAX_CANDIDATES = 100
MAX_ALERTS = 50
MAX_WATCHLIST = 500
LOCK_STALE_SECS = 600

# volume watchlist-and-promote
MIN_VOLUME_USD = 1000
# display filter: mints with market cap under this floor are never gate-verified
# and never shown. Separate from the paper-trading experiment bands
# (DAY1_MC_MIN_USD / DAY1_MC_MAX_USD in config.py), which are untouched.
MCAP_FLOOR_USD = 10000
WATCHLIST_TTL_HOURS = 24
WATCHLIST_TTL_SECS = WATCHLIST_TTL_HOURS * 3600
WATCHLIST_REFRESH_PER_POLL = 90  # watchlist volume refreshes per poll (oldest first)
DEXSCREENER_BATCH = 30           # mints per DexScreener call (API max)

DAY1_MIN, DAY1_MAX = config.DAY1_MC_MIN_USD, config.DAY1_MC_MAX_USD
DAY2_MIN, DAY2_MAX = config.DAY2_MC_MIN_USD, config.DAY2_MC_MAX_USD
LIQ_MIN_USD = config.LIQ_MIN_USD

# --- launchpads. Every entry validated on-chain 2026-10-08: getAccountInfo
# exists+executable AND the program emits type=CREATE enhanced transactions
# with usable launch mints. "suffix": mint sanity filter for that launchpad
# (None = accept any created mint). Unvalidated launchpads are tracked in
# PENDING_LAUNCHPADS below and surfaced in the state.json launchpads map as
# enabled=false with a note - they are never polled and their IDs are never
# guessed into this table.
# Validation round 2026-10-08: pump.fun is the ONLY program whose
# type=CREATE feed yields launch mints. Findings for the rest (see
# PENDING_LAUNCHPADS notes + RUNBOOK "Launchpad coverage"):
#  - Meteora DBC emits TOKEN_MINT, not CREATE, in Helius's taxonomy
#  - launchlab / boop / moonshot: no CREATEs in 6+ pages of history
#  - AMMs (pump AMM, raydium, orca, meteora DLMM/DAMM v2): CREATEs are pool
#    creations (LP mints), not token launches - useless for mint discovery
# Next validated batch = per-launchpad tx-type support (e.g. DBC via
# TOKEN_MINT). Until then this table stays pump.fun-only. ---
LAUNCHPAD_PROGRAMS = {
    "pump.fun": {
        "program": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        "suffix": "pump", "enabled": True,
        "note": "bonding-curve liquidity read (checks.py)",
    },
}


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def enabled_launchpads():
    return [(n, lp) for n, lp in LAUNCHPAD_PROGRAMS.items() if lp.get("enabled")]


# --- discovery ---
def discover_for_program(name, lp, seen, cap):
    """One Helius call: newest type=CREATE txs on this launchpad's program.

    Returns [(mint, launchpad_label)] not in `seen`, newest first, up to cap.
    """
    txs = helius_enhanced(
        "/v0/addresses/%s/transactions/?limit=%d&type=CREATE"
        % (lp["program"], CREATE_FEED_LIMIT)
    )
    suffix = lp.get("suffix")
    out = []
    for t in txs:
        if not isinstance(t, dict) or t.get("transactionError"):
            continue
        for tr in t.get("tokenTransfers") or []:
            mint = tr.get("mint")
            if not mint or mint in seen:
                continue
            if suffix and not mint.endswith(suffix):
                continue
            if any(mint == m for m, _ in out):
                break
            label = name
            if name == "dynamic BC" and mint.endswith("BAGS"):
                label = "bags"  # bags.fm launches via Meteora DBC, vanity suffix
            out.append((mint, label))
            break  # one mint per create tx
        if len(out) >= cap:
            break
    return out


def rotation_programs(state):
    """pump.fun every poll + 2 others round-robin; rotation index persists."""
    enabled = enabled_launchpads()
    others = [(n, lp) for n, lp in enabled if n != "pump.fun"]
    # dedupe shared programs (e.g. bags / dynamic BC both use Meteora DBC)
    seen_prog, uniq = set(), []
    for n, lp in others:
        if lp["program"] not in seen_prog:
            seen_prog.add(lp["program"])
            uniq.append((n, lp))
    idx = (state.get("launchpad_rotation") or {}).get("idx", 0)
    picked = []
    if uniq:
        for i in range(min(2, len(uniq))):
            picked.append(uniq[(idx + i) % len(uniq)])
        idx = (idx + len(picked)) % len(uniq)
    pump = [("pump.fun", LAUNCHPAD_PROGRAMS["pump.fun"])]
    return pump + picked, idx


# --- DexScreener volume (free API, no key, 30 mints per call) ---
def dexscreener_volumes(mints):
    """Return {mint: (volume_h24_usd, best_pair_liquidity_usd, best_pair_mcap_usd)}.

    volume/liquidity/mcap None when DexScreener has no pair for the mint (not
    yet indexed). Best pair = highest liquidity.usd. One HTTP call per 30 mints.
    """
    out = {}
    for i in range(0, len(mints), DEXSCREENER_BATCH):
        chunk = mints[i:i + DEXSCREENER_BATCH]
        url = "https://api.dexscreener.com/latest/dex/tokens/" + ",".join(chunk)
        req = urllib.request.Request(url, headers={"User-Agent": "tyck-watcher/1.0"})
        try:
            data = read_json_response(urllib.request.urlopen(req, timeout=30))
        except Exception as e:  # noqa: BLE001
            log("dexscreener batch failed: %s" % e)
            continue
        pairs = (data or {}).get("pairs") or []
        best = {}
        for p in pairs:
            try:
                base = ((p.get("baseToken") or {}).get("address") or "")
            except AttributeError:
                continue
            liq = ((p.get("liquidity") or {}).get("usd")) or 0
            vol = ((p.get("volume") or {}).get("h24")) or 0
            mcap = p.get("marketCap")
            try:
                liq, vol = float(liq), float(vol)
                mcap = float(mcap) if mcap is not None else None
            except (TypeError, ValueError):
                continue
            cur = best.get(base)
            if cur is None or liq > cur[1]:
                best[base] = (vol, liq, mcap)
        for m in chunk:
            if m in best:
                out[m] = best[m]
            else:
                out[m] = (None, None, None)  # not indexed yet
    return out


# --- verification ---
def parse_mc(detail):
    m = re.findall(r"\(\$([\d,]+)\)", detail or "")
    if not m:
        return None
    try:
        return float(m[-1].replace(",", ""))
    except ValueError:
        return None


def _valid_img_url(url):
    """Validate/normalize a candidate image URL. Returns clean https URL or None.

    Only http(s) survives (no data:, javascript:, blob:). ipfs:// and ar://
    are normalized to public gateways. Everything else is rejected — a token
    image must never become a tracking pixel or mixed-content vector.
    """
    if not url or not isinstance(url, str):
        return None
    u = url.strip()
    if len(u) > 500:
        return None
    # Unwrap Helius image CDN proxy (it 403s; use the source URL directly)
    marker = "cdn.helius-rpc.com/cdn-cgi/image//"
    idx = u.find(marker)
    if idx >= 0:
        u = u[idx + len(marker):]
    low = u.lower()
    # Reject known-garbage shapes (tracking/redirect URLs, not images)
    if "lens.google.com/uploadbyurl" in low:
        return None
    if low.startswith("ipfs://"):
        u = "https://gateway.pinata.cloud/ipfs/" + u[7:]
    elif low.startswith("ar://"):
        u = "https://arweave.net/" + u[5:]
    elif not (low.startswith("https://") or low.startswith("http://")):
        return None
    if low.startswith("http://"):
        # upgrade where safe; ipfs gateways and most CDNs serve https
        u = "https://" + u[7:]
    # ipfs.io 403s from most clients; use Pinata gateway instead
    if u.lower().startswith("https://ipfs.io/ipfs/"):
        u = "https://gateway.pinata.cloud/ipfs/" + u[len("https://ipfs.io/ipfs/"):]
    return u


def resolve_image_url(mint):
    """Resolve a token's image from on-chain metadata via Helius DAS getAsset.

    Cascade: files[0].cdn_uri (Helius-proxied) -> files[0].uri ->
    content.links.image -> fetch content.json_uri -> its image field.
    Never raises; returns None when nothing usable is found. One RPC call
    per mint (plus an occasional json_uri fetch), so it is only ever called
    for newly promoted mints, never in a hot loop.
    """
    try:
        asset = helius_rpc.rpc("getAsset", {"id": mint})
    except Exception:
        return None
    try:
        if isinstance(asset, dict) and "result" in asset:
            asset = asset["result"]
        content = (asset or {}).get("content", {}) or {}
        files = content.get("files") or []
        if files and isinstance(files[0], dict):
            for key in ("cdn_uri", "uri"):
                v = _valid_img_url(files[0].get(key))
                if v:
                    return v
        v = _valid_img_url((content.get("links") or {}).get("image"))
        if v:
            return v
        json_uri = content.get("json_uri")
        if json_uri and isinstance(json_uri, str) and \
                json_uri.lower().startswith("https://"):
            try:
                req = urllib.request.Request(
                    json_uri, headers={"User-Agent": "tyck-trade-watcher/1.0"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    meta = json.loads(resp.read(200000).decode("utf-8", "replace"))
                v = _valid_img_url((meta or {}).get("image"))
                if v:
                    return v
            except Exception:
                pass
    except Exception:
        return None
    return None


def verify_mint(mint, launchpad="pump.fun", ds_liquidity_usd=None):
    """Run the Nines, determine tier, apply the watcher gate policy.

    Returns a candidate dict matching the state.json schema. Gate 5
    (liquidity): pump.fun keeps the bonding-curve read from checks.py. For
    other launchpads the read is attempted via the mint's best DexScreener
    pair liquidity; when liquidity is UNREADABLE gate 5 is FAIL-closed
    (passed=false) - it never passes blind.
    """
    results = checks.run_all(mint, "day1")  # [(name, passed, detail)] x9

    mc = None
    for name, passed, detail in results:
        if name.startswith("3 ") or name.startswith("4 "):
            mc = parse_mc(detail)
            if mc is not None:
                break

    tier = "day1"
    gate3 = {"n": 3, "name": "3 mc > $20k"}
    gate4 = {"n": 4, "name": "4 mc < $100k"}
    if mc is not None and mc >= DAY1_MAX:
        # above the day-one ceiling: evaluate as a second-day candidate
        tier = "day2"
        gate3["name"] = "3 mc > $90k"
        gate4["name"] = "4 mc < $450k"
        ok3 = mc > DAY2_MIN
        ok4 = mc < DAY2_MAX
        gate3.update(passed=ok3, detail="mc > $90k: %s ($%.0f)" % ("PASS" if ok3 else "FAIL", mc))
        gate4.update(passed=ok4, detail="mc < $450k: %s ($%.0f)" % ("PASS" if ok4 else "FAIL", mc))
    else:
        for name, passed, detail in results:
            if name.startswith("3 "):
                gate3.update(passed=passed, detail=detail)
            elif name.startswith("4 "):
                gate4.update(passed=passed, detail=detail)

    gates = []
    for i, (name, passed, detail) in enumerate(results):
        n = i + 1
        if n == 3:
            gates.append(gate3)
        elif n == 4:
            gates.append(gate4)
        elif n in (8, 9):
            continue  # replaced below by the informational bonus lines
        else:
            gates.append({"n": n, "name": name, "passed": passed, "detail": detail})

    # gate 5 per launchpad: pump.fun keeps the bonding-curve read above;
    # others use the DexScreener best-pair liquidity read, FAIL-closed when
    # unreadable.
    if launchpad != "pump.fun":
        if ds_liquidity_usd is None:
            gate5 = {"n": 5, "name": "5 liquidity >= $10k", "passed": False,
                     "detail": "liquidity UNREADABLE (%s) - fail-closed" % launchpad}
        else:
            ok5 = ds_liquidity_usd >= LIQ_MIN_USD
            gate5 = {"n": 5, "name": "5 liquidity >= $10k", "passed": ok5,
                     "detail": "liquidity: %s ($%.0f best DexScreener pair, need $%d)"
                     % ("PASS" if ok5 else "FAIL", ds_liquidity_usd, LIQ_MIN_USD)}
        gates = [gate5 if g["n"] == 5 else g for g in gates]

    # gates 8-9: informational bonus lines, never block (passed=null)
    try:
        _, d8 = checks.bonus_authorities(mint)
    except Exception as e:  # noqa: BLE001
        d8 = "authorities: error (%s)" % e
    try:
        _, d9 = checks.bonus_concentration(mint)
    except Exception as e:  # noqa: BLE001
        d9 = "concentration: error (%s)" % e
    gates.append({"n": 8, "name": "8 authorities (info)", "passed": None, "detail": d8})
    gates.append({"n": 9, "name": "9 concentration (info)", "passed": None, "detail": d9})
    gates.sort(key=lambda g: g["n"])

    defined = [g for g in gates if g["n"] <= 7]
    non_stub = [g for g in defined if g["passed"] is not None]
    verdict = "ALERT" if non_stub and all(g["passed"] for g in non_stub) else "PASS"
    partial = any(g["passed"] is None for g in defined)

    n_pass = sum(1 for g in non_stub if g["passed"])
    reason = "%d/%d defined gates, tier %s" % (n_pass, len(non_stub), tier)
    stubs = [str(g["n"]) for g in defined if g["passed"] is None]
    if stubs:
        label = "6-7" if stubs == ["6", "7"] else ",".join(stubs)
        why = "wallet lists" if stubs == ["6", "7"] else "data unavailable"
        reason += " (gates %s pending: %s)" % (label, why)

    return {
        "mint": mint,
        "launchpad": launchpad,
        "first_seen": int(time.time()),
        "tier": tier,
        "volume_usd": None,
        "mcap_usd": mc,  # market cap at gate time (None when unparseable)
        "image_url": resolve_image_url(mint),  # on-chain metadata, None if none
        "gates": gates,
        "verdict": verdict,
        "partial": partial,
        "alerted": False,
        "alerted_at": None,
        "reason": reason,
    }


def send_alert(mint, reason, dry_run):
    """Queue an alert via the existing notify.py mechanism (alerts.log)."""
    if dry_run:
        log("DRY-RUN: would alert %s (%s)" % (mint, reason))
        return False
    notify = os.path.join(BOT_DIR, "notify.py")
    proc = subprocess.run(
        [sys.executable, notify, mint, reason],
        cwd=WATCHER_DIR, capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError("notify.py failed: %s" % (proc.stderr or proc.stdout))
    log("alert queued for %s" % mint)
    return True


def launchpads_state_map():
    """state.json launchpads map: validated batch enabled, the rest pending."""
    m = {}
    for name, lp in LAUNCHPAD_PROGRAMS.items():
        m[name] = {"enabled": bool(lp.get("enabled")), "program": lp["program"],
                   "note": lp.get("note", "")}
    # Axiom launchpad list not yet validated on-chain: tracked pending, never
    # guessed. bags/believe/jupiter studio launch via Meteora DBC under the
    # hood (see RUNBOOK) but stay pending until attribution is verified.
    for name, note in PENDING_LAUNCHPADS.items():
        if name not in m:
            m[name] = {"enabled": False, "program": None, "note": note}
    return m


PENDING_LAUNCHPADS = {
    # Researched 2026-10-08, program IDs confirmed from reputable sources
    # (project docs/SDKs, indexer repos) AND verified executable on-chain via
    # getAccountInfo - but they do NOT emit type=CREATE with usable launch
    # mints, so they stay disabled per the validation rule.
    "launchlab": "program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj verified executable, "
                 "but no type=CREATE in 6+ pages of Helius history (newest 50 txs all SWAP)",
    "boop": "program boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4 verified executable, "
            "but no type=CREATE in 6+ pages of Helius history",
    "moonshot": "program MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG verified executable, "
                "but no type=CREATE found (newest 100 txs: SWAP/TRANSFER/CLOSE/UNKNOWN only)",
    "dynamic BC": "program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN verified executable "
                  "(Meteora official docs), but Helius classifies its launches as TOKEN_MINT, "
                  "not CREATE - needs per-launchpad tx-type support (prime next-batch candidate)",
    "bags": "launches via Meteora DBC (BAGS-suffix mints); blocked on the dynamic BC "
            "TOKEN_MINT taxonomy gap above",
    "pump AMM": "program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA verified executable; "
                "its type=CREATE feed yields pool creations (LP mints + WSOL), not token launches",
    "raydium": "program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 verified executable; "
               "AMM pool creations only, no usable launch-mint discovery feed",
    "meteora AMM": "program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo verified executable; "
                   "AMM pool creations only, no usable launch-mint discovery feed",
    "meteora AMM V2": "program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG verified executable; "
                      "AMM pool creations only, no usable launch-mint discovery feed",
    "orca": "program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc verified executable; "
            "AMM pool creations only, no usable launch-mint discovery feed",
    # Axiom-list launchpads with no verifiable program ID from a reputable
    # source - never guessed.
    "pump offchain": "no on-chain program (offchain service); not pollable",
    "surge": "program ID not verified from a reputable source",
    "candle": "program ID not verified from a reputable source",
    "bonkers": "program ID not verified from a reputable source",
    "soar": "program ID not verified from a reputable source",
    "printr": "program ID not verified from a reputable source",
    "liquidAf": "program ID not verified from a reputable source",
    "liquidAfAmm": "program ID not verified from a reputable source",
    "riseRich": "program ID not verified from a reputable source",
    "stonkfun": "program ID not verified from a reputable source",
    "pve": "program ID not verified from a reputable source",
    "mayhem": "program ID not verified from a reputable source",
    "heaven": "program ID not verified from a reputable source",
    "daos.fun": "program ID not verified from a reputable source",
    "believe": "launches via Meteora DBC per CoinDesk; blocked on the dynamic BC "
               "TOKEN_MINT taxonomy gap",
    "jupiter studio": "program ID not verified from a reputable source; may launch via Meteora infra",
    "moonit": "alias of the moonshot program per indexer sources; tracked under moonshot",
    "usepaid": "program ID not verified from a reputable source",
    "sugar": "program ID not verified from a reputable source",
    "liquid": "program ID not verified from a reputable source",
    "pve.win": "program ID not verified from a reputable source",
    "wavebreak": "program ID not verified from a reputable source",
}


def acquire_lock():
    try:
        with open(LOCK_FILE) as f:
            ts = float(f.read().strip() or 0)
        if time.time() - ts < LOCK_STALE_SECS:
            return False
    except (FileNotFoundError, ValueError):
        pass
    with open(LOCK_FILE, "w") as f:
        f.write(str(time.time()))
    return True


def release_lock():
    try:
        os.remove(LOCK_FILE)
    except FileNotFoundError:
        pass


def main():
    dry_run = "--dry-run" in sys.argv
    if not acquire_lock():
        log("another scan is already running; skipping")
        return 1

    seen = load_json(SEEN_FILE, {})
    state = load_json(STATE_FILE, None) or {
        "updated_at": 0,
        "scanner": {"status": "ok", "last_poll": 0, "mints_seen_total": 0,
                    "new_this_poll": 0, "error": None},
        "candidates": [],
        "alerts": [],
    }
    candidates = state.get("candidates", [])
    # backfill fields added after these candidates were written
    for c in candidates:
        c.setdefault("launchpad", "pump.fun")
        c.setdefault("volume_usd", None)
    alerts = state.get("alerts", [])
    watchlist = state.get("watchlist", [])
    alerted_mints = {c["mint"] for c in candidates if c.get("alerted")}
    alerted_mints |= {a["mint"] for a in alerts}

    scanner = {"status": "ok", "last_poll": 0, "mints_seen_total": len(seen),
               "new_this_poll": 0, "error": None}
    rot_idx = (state.get("launchpad_rotation") or {}).get("idx", 0)
    run_error = None
    exit_code = 0
    promoted = 0
    promoted_mints = []
    filtered_mints = []  # sub-$10K mcap: skipped gates, dropped from watchlist

    try:
        # 1. prune watchlist: TTL expiry (stays in seen.json -> never re-added)
        now = int(time.time())
        before = len(watchlist)
        watchlist = [w for w in watchlist
                     if now - w.get("first_seen", now) <= WATCHLIST_TTL_SECS]
        if len(watchlist) != before:
            log("watchlist TTL: dropped %d aged-out mint(s)" % (before - len(watchlist)))

        # 2. discovery: pump.fun + 2 rotating launchpads -> watchlist
        programs, rot_idx = rotation_programs(state)
        log("polling Helius for creates on: %s"
            % ", ".join(n for n, _ in programs))
        added = 0
        for name, lp in programs:
            if added >= MAX_NEW_MINTS_PER_RUN:
                break
            try:
                fresh = discover_for_program(name, lp, seen,
                                             MAX_NEW_MINTS_PER_RUN - added)
            except RateLimited:
                raise
            except urllib.error.HTTPError as e:
                log("discovery failed for %s: HTTP %s" % (name, getattr(e, "code", "?")))
                continue
            for mint, label in fresh:
                seen[mint] = now
                watchlist.append({"mint": mint, "launchpad": label,
                                  "first_seen": now, "volume_usd": None,
                                  "last_checked": 0})
                added += 1
            log("  %s: %d new" % (name, len(fresh)))
        watchlist = watchlist[-MAX_WATCHLIST:]
        log("discovered %d new mint(s) -> watchlist (%d)" % (added, len(watchlist)))

        # 3. volume refresh: all candidates + watchlist oldest-first (batched)
        refresh_mints = [c["mint"] for c in candidates]
        wl_by_age = sorted(watchlist, key=lambda w: w.get("last_checked", 0))
        for w in wl_by_age:
            if len(refresh_mints) >= len(candidates) + WATCHLIST_REFRESH_PER_POLL:
                break
            if w["mint"] not in refresh_mints:
                refresh_mints.append(w["mint"])
        volumes = dexscreener_volumes(refresh_mints) if refresh_mints else {}
        log("dexscreener: refreshed %d mint(s)" % len(volumes))
        wl_map = {w["mint"]: w for w in watchlist}
        for m, (vol, liq, mcap) in volumes.items():
            if m in wl_map:
                wl_map[m]["volume_usd"] = vol
                wl_map[m]["last_checked"] = now
                wl_map[m]["_liq"] = liq  # transient, stripped before persist
                wl_map[m]["_mcap"] = mcap  # transient, stripped before persist
        cand_map = {c["mint"]: c for c in candidates}
        for m, (vol, liq, mcap) in volumes.items():
            if m in cand_map:
                cand_map[m]["volume_usd"] = vol
                if mcap is not None:
                    cand_map[m]["mcap_usd"] = mcap

        # 4. promote: watchlist mints crossing MIN_VOLUME_USD get full verification
        promotable = [w for w in watchlist
                      if (w.get("volume_usd") or 0) >= MIN_VOLUME_USD]
        promotable.sort(key=lambda w: -(w.get("volume_usd") or 0))
        log("%d watchlist mint(s) above $%d volume" % (len(promotable), MIN_VOLUME_USD))
        for w in promotable[:MAX_NEW_MINTS_PER_RUN]:
            # $10K display floor FIRST: sub-floor mints never get gate cycles.
            w_mcap = w.get("_mcap")
            if w_mcap is not None and w_mcap < MCAP_FLOOR_USD:
                log("mcap-filter: %s ($%.0f) below $%d floor, skipping gates"
                    % (w["mint"], w_mcap, MCAP_FLOOR_USD))
                filtered_mints.append(w["mint"])
                continue
            try:
                cand = verify_mint(w["mint"], w.get("launchpad", "pump.fun"),
                                   w.get("_liq"))
            except RateLimited:
                raise
            except Exception as e:  # noqa: BLE001
                log("verify failed for %s: %s" % (w["mint"], e))
                continue
            cand["volume_usd"] = w.get("volume_usd")
            promoted += 1
            promoted_mints.append(w["mint"])
            if cand["verdict"] == "ALERT" and cand["mint"] not in alerted_mints:
                try:
                    delivered = send_alert(cand["mint"], cand["reason"], dry_run)
                except RateLimited:
                    raise
                except Exception as e:  # noqa: BLE001
                    log("alert failed for %s: %s" % (cand["mint"], e))
                    delivered = False
                if delivered:
                    cand["alerted"] = True
                    cand["alerted_at"] = now
                    alerted_mints.add(cand["mint"])
                    alerts.append({"mint": cand["mint"], "tier": cand["tier"],
                                   "time": now, "reason": cand["reason"],
                                   "delivered": True})
            candidates.insert(0, cand)
        # only successfully verified mints leave the watchlist; a failed verify
        # stays for retry next poll (it is in seen.json, so never re-added).
        # mcap-filtered mints also leave: they are in seen.json and will never
        # be gated or shown.
        dropped = set(promoted_mints) | set(filtered_mints)
        watchlist = [w for w in watchlist if w["mint"] not in dropped]
        scanner["new_this_poll"] = promoted

    except RateLimited as e:
        run_error = "rate limited: %s (backed off, not hammering)" % e
        log(run_error)
        exit_code = 2
    except urllib.error.HTTPError as e:
        run_error = "Helius HTTP %s: %s" % (getattr(e, "code", "?"), e)
        log(run_error)
        exit_code = 2
    except Exception as e:  # noqa: BLE001
        run_error = "%s: %s" % (type(e).__name__, e)
        log(run_error)
        exit_code = 2
    finally:
        now = int(time.time())
        scanner["last_poll"] = now
        scanner["mints_seen_total"] = len(seen)
        if run_error:
            scanner["status"] = "error"
            scanner["error"] = run_error
        for w in watchlist:
            w.pop("_liq", None)  # transient DexScreener liquidity, never persisted
            w.pop("_mcap", None)  # transient DexScreener mcap, never persisted
        # 5. image backfill: candidates missing image_url get up to 5
        # resolutions per poll (self-healing; new mints resolve in verify_mint)
        try:
            missing = [c for c in candidates if not c.get("image_url")]
            for c in missing[:5]:
                c["image_url"] = resolve_image_url(c["mint"])
            if missing[:5]:
                log("images: backfilled %d candidate(s)" % len(missing[:5]))
        except Exception as e:  # noqa: BLE001 - never break the poll on images
            log("image backfill skipped: %s" % e)
        state = {
            "updated_at": now,
            "scanner": scanner,
            "launchpads": launchpads_state_map(),
            "launchpad_rotation": {"idx": rot_idx},
            "watchlist": watchlist,
            # belt and suspenders: even if a sub-$10K mint somehow reached
            # candidates, it never lands in the published state. Unknown
            # mcap (None) is kept - the floor only drops confirmed sub-floor.
            "candidates": [c for c in candidates[:MAX_CANDIDATES]
                           if c.get("mcap_usd") is None
                           or c["mcap_usd"] >= MCAP_FLOOR_USD],
            "alerts": alerts[-MAX_ALERTS:],
        }
        save_json(STATE_FILE, state)
        save_json(SEEN_FILE, seen)
        release_lock()

    log("done: status=%s promoted=%d watchlist=%d total_seen=%d alerts=%d" % (
        scanner["status"], scanner["new_this_poll"],
        len(watchlist), scanner["mints_seen_total"], len(alerts)))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
