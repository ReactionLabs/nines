#!/usr/bin/env python3
"""
fast_filter.py: instant on-chain safety filter for new pump.fun mints.

Target: <500ms per mint. One batched getMultipleAccounts RPC call fetches
the mint account, both bonding-curve PDAs, and the metadata PDA; everything
is parsed locally.

Checks:
  - freeze authority MUST be disabled (hard reject if present)
  - bonding curve MUST exist and NOT be complete (hard reject otherwise;
    a complete/missing curve means not a fresh pump.fun snipe)
  - mint authority renounced (None) scores +2; present scores 0 (soft)
  - metaplex metadata with non-empty name/symbol scores +1 (soft)

Paper only. No transaction building, signing, or broadcasting anywhere here.

The PDA derivation below is pure-python (sha256 + ed25519 off-curve check)
so this module has zero Solana SDK dependencies.
"""

import base64
import hashlib
import json
import struct
import time
import urllib.request

# ---------------------------------------------------------------- constants

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TOKEN_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
SOL_MINT = "So11111111111111111111111111111111111111112"

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# ed25519 field prime for the off-curve check
_P = 2**255 - 19
# d = -121665 * inv(121666) mod p
_D = (_P - 121665) * pow(121666, _P - 2, _P) % _P


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = B58_ALPHABET[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + B58_ALPHABET.index(ch)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + raw


def _is_on_curve(s: bytes) -> bool:
    """True if 32 bytes decode to a point on ed25519 (i.e. NOT a valid PDA)."""
    if len(s) != 32:
        return False
    y = int.from_bytes(s, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    y2 = (y * y) % _P
    # x^2 = (y^2 - 1) / (d*y^2 + 1)
    num = (y2 - 1) % _P
    den = (_D * y2 + 1) % _P
    x2 = num * pow(den, _P - 2, _P) % _P
    if x2 == 0:
        return True
    # quadratic residue check: x2^((p-1)/2) == 1
    return pow(x2, (_P - 1) // 2, _P) == 1


def find_program_address(seeds: list, program_id: str) -> tuple:
    """Return (pda_base58, bump). Mirrors Solana's findProgramAddress."""
    prog = b58decode(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256()
        for s in seeds:
            h.update(s)
        h.update(bytes([bump]))
        h.update(prog)
        h.update(b"ProgramDerivedAddress")
        addr = h.digest()
        if not _is_on_curve(addr):
            return b58encode(addr), bump
    raise RuntimeError("no PDA found")


def bonding_curve_pdas(mint: str) -> list:
    """Both candidate bonding-curve PDAs (v1 then v2 seed)."""
    mint_b = b58decode(mint)
    out = []
    for seed in (b"bonding-curve", b"bonding-curve-v2"):
        try:
            pda, _ = find_program_address([seed, mint_b], PUMP_PROGRAM)
            out.append(pda)
        except Exception:
            continue
    return out


def metadata_pda(mint: str) -> str:
    pda, _ = find_program_address(
        [b"metadata", b58decode(TOKEN_METADATA_PROGRAM), b58decode(mint)],
        TOKEN_METADATA_PROGRAM,
    )
    return pda


# ---------------------------------------------------------------- parsers


def parse_mint_account(raw: bytes) -> dict:
    """SPL Token Mint layout (82 bytes). Returns authority info."""
    if len(raw) < 82:
        raise ValueError(f"mint account too short: {len(raw)}")
    mint_tag = struct.unpack_from("<I", raw, 0)[0]
    mint_authority = b58encode(raw[4:36]) if mint_tag == 1 else None
    supply = struct.unpack_from("<Q", raw, 36)[0]
    decimals = raw[44]
    freeze_tag = struct.unpack_from("<I", raw, 46)[0]
    freeze_authority = b58encode(raw[50:82]) if freeze_tag == 1 else None
    return {
        "mint_authority": mint_authority,
        "mint_authority_renounced": mint_authority is None,
        "freeze_authority": freeze_authority,
        "freeze_disabled": freeze_authority is None,
        "supply": supply,
        "decimals": decimals,
    }


def parse_curve_account(raw: bytes) -> dict:
    """pump.fun bonding curve: disc(8) + vTR(8) + vSR(8) + ... + complete@48."""
    if len(raw) < 49:
        raise ValueError(f"curve account too short: {len(raw)}")
    vtr = struct.unpack_from("<Q", raw, 8)[0]
    vsr = struct.unpack_from("<Q", raw, 16)[0]
    return {
        "virtual_token_reserves": vtr,
        "virtual_sol_reserves": vsr,
        "complete": raw[48] != 0,
    }


def parse_metadata_name_symbol(raw: bytes) -> tuple:
    """Metaplex metadata: key(1) + update_auth(32) + mint(32), then
    rust strings for name, symbol, uri. Returns (name, symbol)."""
    try:
        o = 1 + 32 + 32
        out = []
        for _ in range(2):  # name, symbol
            (ln,) = struct.unpack_from("<I", raw, o)
            o += 4
            out.append(raw[o:o + ln].decode("utf-8", "replace").strip("\x00").strip())
            o += ln
        return out[0], out[1]
    except Exception:
        return "", ""


def curve_price_sol_per_token(curve: dict) -> float | None:
    """SOL per token from virtual reserves. None if unusable."""
    vtr = curve["virtual_token_reserves"]
    vsr = curve["virtual_sol_reserves"]
    if not vtr or not vsr:
        return None
    # (vsr / 1e9) / (vtr / 1e6) = vsr / vtr / 1000
    p = vsr / vtr / 1000.0
    return p if p > 0 else None


# ---------------------------------------------------------------- RPC


def rpc_batch(api_key: str, addresses: list, timeout: float = 10.0) -> list:
    """One getMultipleAccounts call. Returns list of base64 data or None."""
    url = f"https://mainnet.helius-rpc.com/?api-key={api_key}"
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getMultipleAccounts",
        "params": [addresses, {"encoding": "base64", "commitment": "processed"}],
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json", "User-Agent": "nines-sniper/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    if payload.get("error"):
        raise RuntimeError(f"rpc error: {payload['error']}")
    values = payload["result"]["value"]
    out = []
    for v in values:
        if not v or not v.get("data"):
            out.append(None)
        else:
            out.append(base64.b64decode(v["data"][0]))
    return out


# ---------------------------------------------------------------- filter


def filter_mint(mint: str, api_key: str) -> dict:
    """Run the fast safety filter. Returns verdict dict with timing.

    Verdict: {"mint", "pass", "score", "checks": {...}, "filter_ms",
              "reject_reason" (if not pass), "curve": {...}|None}
    """
    t0 = time.perf_counter()
    checks: dict = {}
    score = 0

    try:
        curve_pdas = bonding_curve_pdas(mint)
        meta_pda = metadata_pda(mint)
    except Exception as e:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": 0, "checks": {},
                "filter_ms": round(ms, 1), "reject_reason": f"pda: {e}"}

    addrs = [mint] + curve_pdas + [meta_pda]
    try:
        raws = rpc_batch(api_key, addrs)
    except Exception as e:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": 0, "checks": {},
                "filter_ms": round(ms, 1), "reject_reason": f"rpc: {e}"}

    mint_raw = raws[0]
    curve_raws = raws[1:1 + len(curve_pdas)]
    meta_raw = raws[-1]

    # --- mint account: freeze authority is the hard gate
    try:
        mi = parse_mint_account(mint_raw or b"")
        checks["freeze_disabled"] = mi["freeze_disabled"]
        checks["mint_renounced"] = mi["mint_authority_renounced"]
        checks["decimals"] = mi["decimals"]
    except Exception as e:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": 0, "checks": checks,
                "filter_ms": round(ms, 1),
                "reject_reason": f"mint parse: {e}"}

    if not mi["freeze_disabled"]:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": score, "checks": checks,
                "filter_ms": round(ms, 1),
                "reject_reason": f"freeze authority enabled: {mi['freeze_authority']}"}

    if mi["mint_authority_renounced"]:
        score += 2
        checks["mint_score"] = 2
    else:
        checks["mint_score"] = 0
        checks["mint_authority"] = mi["mint_authority"]

    # --- bonding curve: must exist and be incomplete (fresh snipe)
    curve = None
    for cr in curve_raws:
        if not cr:
            continue
        try:
            c = parse_curve_account(cr)
        except Exception:
            continue
        curve = c
        break
    checks["curve_found"] = curve is not None
    if curve is None:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": score, "checks": checks,
                "filter_ms": round(ms, 1), "reject_reason": "no bonding curve"}
    checks["curve_complete"] = curve["complete"]
    if curve["complete"]:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": score, "checks": checks,
                "filter_ms": round(ms, 1), "reject_reason": "curve complete (graduated)"}
    price_sol = curve_price_sol_per_token(curve)
    checks["curve_price_sol"] = price_sol
    if price_sol is None:
        ms = (time.perf_counter() - t0) * 1000
        return {"mint": mint, "pass": False, "score": score, "checks": checks,
                "filter_ms": round(ms, 1), "reject_reason": "curve has no price"}

    # --- metadata: soft signal
    name, symbol = parse_metadata_name_symbol(meta_raw or b"")
    checks["metadata_found"] = bool(name or symbol)
    checks["name"] = name[:32]
    checks["symbol"] = symbol[:16]
    if name and symbol:
        score += 1
        checks["metadata_score"] = 1
    else:
        checks["metadata_score"] = 0

    ms = (time.perf_counter() - t0) * 1000
    return {"mint": mint, "pass": True, "score": score, "checks": checks,
            "filter_ms": round(ms, 1), "curve": curve}
