"""The Nines. Nine checks, each returns (passed: bool, detail: str).

Checks 1-4 are live via Helius. Checks 6-7 work once Dip supplies the wallet
lists. Check 5 (liquidity) and 8-9 are stubbed with clear TODOs.
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.expanduser("~/workspace/skills/helius/bin"))
import helius_rpc  # noqa: E402

import config

DAS_LIMIT = 5_000_000


def _jup_price(mint):
    url = config.JUP_PRICE_URL + "?ids=" + mint
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
        entry = data.get("data", {}).get(mint) or data.get(mint) or {}
        return entry.get("usdPrice") or entry.get("price")
    except Exception:  # noqa: BLE001
        return None


def _get_asset(mint):
    try:
        return helius_rpc.rpc("getAsset", {"id": mint})
    except Exception:  # noqa: BLE001
        return None


def _links(mint):
    asset = _get_asset(mint) or {}
    content = asset.get("content", {}) or {}
    links = content.get("links", {}) or {}
    meta = content.get("metadata", {}) or {}
    return links, meta


def check_socials(mint, tier="day1"):
    links, meta = _links(mint)
    found = [k for k in ("twitter", "telegram", "discord") if links.get(k)]
    desc = (meta.get("description") or "").lower()
    if not found and ("t.me/" in desc or "twitter.com" in desc or "x.com/" in desc):
        found = ["description"]
    return (bool(found), "socials: " + (", ".join(found) if found else "none found"))


def check_website(mint, tier="day1"):
    links, _ = _links(mint)
    site = links.get("website") or links.get("external_url")
    return (bool(site), "website: " + (site if site else "none found"))


def _market_cap(mint):
    try:
        supply = helius_rpc.rpc("getTokenSupply", [mint])["result"]["value"]
        decimals = supply.get("decimals", 0)
        amount = float(supply.get("amount", 0)) / (10 ** decimals)
    except Exception:  # noqa: BLE001
        return None, "supply unreadable"
    price = _jup_price(mint)
    if price is None:
        return None, "no Jupiter price"
    return amount * float(price), "mc=$%.0f" % (amount * float(price))


def check_mc_min(mint, tier="day1"):
    return _check_mc(mint, tier, "min")


def check_mc_max(mint, tier="day1"):
    return _check_mc(mint, tier, "max")


def _check_mc(mint, tier, which):
    lo, hi = (config.DAY1_MC_MIN_USD, config.DAY1_MC_MAX_USD) if tier == "day1" \
        else (config.DAY2_MC_MIN_USD, config.DAY2_MC_MAX_USD)
    mc, detail = _market_cap(mint)
    if mc is None:
        return (False, "mc: " + detail)
    if which == "min":
        ok = mc > lo
        return (ok, "mc > $%dk: %s ($%.0f)" % (lo // 1000, "PASS" if ok else "FAIL", mc))
    ok = mc < hi
    return (ok, "mc < $%dk: %s ($%.0f)" % (hi // 1000, "PASS" if ok else "FAIL", mc))


def _curve_pda_value(mint_str):
    """Return (pda_str, account_value) for the pump.fun bonding curve, else (None, None)."""
    from solders.pubkey import Pubkey
    program = Pubkey.from_string(config.PUMP_PROGRAM_ID)
    mint = Pubkey.from_string(mint_str)
    for seed in (b"bonding-curve", b"bonding-curve-v2"):
        pda, _ = Pubkey.find_program_address([seed, bytes(mint)], program)
        try:
            acct = helius_rpc.rpc("getAccountInfo", [str(pda), {"encoding": "jsonParsed"}])
        except Exception:  # noqa: BLE001
            continue
        val = (acct.get("result") or {}).get("value")
        if val:
            return str(pda), val
    return None, None


def check_liquidity(mint, tier="day1"):
    _, val = _curve_pda_value(mint)
    if not val:
        return (None, "liquidity: no bonding curve found (graduated? pool read TODO)")
    sol = val.get("lamports", 0) / 1e9
    sol_price = _jup_price(config.SOL_MINT)
    if sol_price is None:
        return (False, "liquidity: no SOL price")
    usd = sol * float(sol_price)
    ok = usd >= config.LIQ_MIN_USD
    return (ok, "liquidity: %s ($%.0f in curve, need $%d)" % ("PASS" if ok else "FAIL", usd, config.LIQ_MIN_USD))


def _holder_overlap(mint, wallets):
    if not wallets:
        return None
    try:
        res = helius_rpc.rpc("getTokenLargestAccounts", [mint])["result"]["value"]
    except Exception:  # noqa: BLE001
        return None
    holders = {h.get("address") for h in res}
    return holders & set(wallets)


def check_whitelist(mint, tier="day1"):
    wallets = config.load_wallets(config.WHITELIST_FILE)
    if not wallets:
        return (None, "whitelist: STUB, wallets/whitelist.txt is empty")
    overlap = _holder_overlap(mint, wallets)
    if overlap is None:
        return (False, "whitelist: holder list unreadable")
    return (bool(overlap), "whitelist: %d of %d tracked whales holding" % (len(overlap), len(wallets)))


def check_blacklist(mint, tier="day1"):
    wallets = config.load_wallets(config.BLACKLIST_FILE)
    if not wallets:
        return (None, "blacklist: STUB, wallets/blacklist.txt is empty")
    overlap = _holder_overlap(mint, wallets)
    if overlap is None:
        return (False, "blacklist: holder list unreadable")
    return (not overlap, "blacklist: %s (%d hits)" % ("CLEAN" if not overlap else "HIT", len(overlap)))


def check_8(mint, tier="day1"):
    return (None, "check 8: TBD by Dip")


def check_9(mint, tier="day1"):
    return (None, "check 9: TBD by Dip")


def bonus_authorities(mint):
    """Informational: mint/freeze authority revoked? Proposed as check 8/9."""
    import base64
    try:
        acct = helius_rpc.rpc("getAccountInfo", [mint, {"encoding": "base64"}])
    except Exception as e:  # noqa: BLE001
        return (None, "authorities: unreadable (%s)" % e)
    val = (acct.get("result") or {}).get("value")
    if not val:
        return (None, "authorities: mint account not found")
    data = base64.b64decode(val["data"][0])
    if len(data) < 82:
        return (None, "authorities: unexpected mint layout")
    mint_revoked = int.from_bytes(data[0:4], "little") == 0
    freeze_revoked = int.from_bytes(data[46:50], "little") == 0
    return ((mint_revoked, freeze_revoked),
            "authorities: mint %s, freeze %s" %
            ("REVOKED" if mint_revoked else "ACTIVE", "REVOKED" if freeze_revoked else "ACTIVE"))


def bonus_concentration(mint):
    """Informational: top-10 holder %. Proposed as check 8/9."""
    try:
        res = helius_rpc.rpc("getTokenLargestAccounts", [mint])["result"]["value"]
        supply = helius_rpc.rpc("getTokenSupply", [mint])["result"]["value"]
    except Exception as e:  # noqa: BLE001
        return (None, "concentration: unreadable (%s)" % e)
    decimals = supply.get("decimals", 0)
    total = float(supply.get("amount", 0)) / (10 ** decimals)
    if not total:
        return (None, "concentration: zero supply")
    top10 = sum(float(h.get("amount", 0)) / (10 ** decimals) for h in res[:10])
    pct = 100.0 * top10 / total
    flag = " (HIGH)" if pct > 50 else ""
    return (pct, "concentration: top-10 hold %.1f%%%s" % (pct, flag))


CHECKS = [
    ("1 socials", check_socials),
    ("2 website", check_website),
    ("3 mc > $20k", check_mc_min),
    ("4 mc < $100k", check_mc_max),
    ("5 liquidity >= $10k", check_liquidity),
    ("6 whitelisted whales", check_whitelist),
    ("7 no blacklisted", check_blacklist),
    ("8 TBD", check_8),
    ("9 TBD", check_9),
]


def run_all(mint, tier="day1"):
    results = []
    for name, fn in CHECKS:
        try:
            passed, detail = fn(mint, tier)
        except Exception as e:  # noqa: BLE001
            passed, detail = False, "%s error: %s" % (name, e)
        results.append((name, passed, detail))
    return results
