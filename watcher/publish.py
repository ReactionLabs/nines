#!/usr/bin/env python3
"""Publish watcher data to GitHub (dual-repo).

- state.json  -> PUBLIC  ReactionLabs/tyck-trade-data (repo root, so it serves
                 at https://raw.githubusercontent.com/ReactionLabs/tyck-trade-data/main/state.json)
- journal.json -> PRIVATE ReactionLabs/tyck-trade at data/journal.json

Skip-if-unchanged: each file is compared byte-for-byte against the repo copy
before pushing; no empty churn commits.

The public state push runs a secrets assertion first (see assert_public_safe).
Wallet whitelist/blacklist files live outside state.json and must NEVER reach
the public repo.

Secrets: uses the connected custom.github credential via surrogate (never raw).
"""
import base64
import json
import os
import re
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.github.com"
PUBLIC_REPO = "ReactionLabs/tyck-trade-data"
PRIVATE_REPO = "ReactionLabs/tyck-trade"
BRANCH = "main"
WATCHER_DIR = "/home/hatch/workspace/trading-bot/watcher"
BOT_DIR = "/home/hatch/workspace/trading-bot"

# Base58 alphabet (no 0, O, I, l) - Solana addresses
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


class GitHubError(RuntimeError):
    def __init__(self, status, method, path, detail):
        super().__init__(f"{method} {path} -> {status}: {detail}")
        self.status = status


def gh(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.github",
                             entry_name="access_token",
                             allowed_hosts=["api.github.com"])
    try:
        with urllib.request.urlopen(req) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            detail = read_json_response(e)
        except Exception:
            detail = e.read().decode(errors="replace")
        raise GitHubError(e.code, method, path, json.dumps(detail)[:300])


def get_remote_file(repo, path):
    """Return current bytes of a file in the repo, or None if absent."""
    try:
        obj = gh("GET", f"/repos/{repo}/contents/{path}?ref={BRANCH}")
    except GitHubError as e:
        if e.status == 404:
            return None
        raise
    if obj.get("type") != "file" or "content" not in obj:
        return None
    return base64.b64decode(obj["content"])


def assert_public_safe(raw_bytes):
    """Fail closed if the state payload looks like it contains secrets.

    The public state.json must hold only public on-chain data: token mints,
    gate results, volume, scanner metadata. Checks:
      1. No secret-like key names anywhere in the JSON tree
         (passphrase/token/secret/private/wallet-list/api-key/auth patterns).
      2. No secret-like value patterns in the raw text (private keys, api
         tokens, bearer tokens, known credential prefixes).
         NOTE: the bare word "token" is deliberately NOT matched as a value:
         state.json legitimately contains on-chain taxonomy terms like
         "TOKEN_MINT" and English like "not token launches".
      3. Every base58 address-like string (32-44 chars) must be a known
         public mint (candidates[]/watchlist[] "mint" fields) or a known
         public launchpad program id ("launchpads" "program" fields).
    """
    text = raw_bytes.decode("utf-8", errors="replace")
    payload = json.loads(text)

    # 1. Secret-like key names.
    key_re = re.compile(
        r"(?i)(passphrase|token|secret|private|api[_-]?key|"
        r"access[_-]?token|auth|seed|mnemonic|wallets?|wallet[-_ ]?list)")

    def walk(o, trail="root"):
        if isinstance(o, dict):
            for k, v in o.items():
                if key_re.search(str(k)):
                    raise AssertionError(
                        f"secret-like key name at {trail}.{k}")
                walk(v, f"{trail}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{trail}[{i}]")
    walk(payload)

    # 2. Secret-like value patterns.
    val_re = re.compile(
        r"(?i)(passphrase|private[_-]?key|api[_-]?key|access[_-]?token|"
        r"bearer\s+[A-Za-z0-9._~-]{8,}|ghp_[A-Za-z0-9]{10,}|"
        r"github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9]{16,}|"
        r"xox[bap]-|AIza[0-9A-Za-z_-]{30,}|"
        r"wallet[-_ ]list\s*[:=])")
    m = val_re.search(text)
    if m:
        ctx = text[max(0, m.start() - 30):m.end() + 10]
        raise AssertionError(f"secret-like value pattern near {ctx!r}")

    # 3. Address allow-list: every address-like string must be a known public
    # token mint (candidates[]/watchlist[] "mint" fields) or a public
    # launchpad program id (the "launchpads" map names programs in "program"
    # fields and in free-text "note" fields; all are public on-chain metadata).
    addr_re = re.compile(rf"[{B58}]{{32,44}}")

    def collect_addrs(o):
        if isinstance(o, str):
            return set(addr_re.findall(o))
        if isinstance(o, dict):
            found = set()
            for v in o.values():
                found |= collect_addrs(v)
            return found
        if isinstance(o, list):
            found = set()
            for v in o:
                found |= collect_addrs(v)
            return found
        return set()

    allowed = set()
    for cand in payload.get("candidates", []) + payload.get("watchlist", []):
        if isinstance(cand, dict) and cand.get("mint"):
            allowed.add(cand["mint"])
    allowed |= collect_addrs(payload.get("launchpads", {}))

    # image_url values are public CDN/IPFS links. IPFS CIDs embedded in
    # them are base58 content hashes (32-44 chars) that trip the address
    # regex but are not secrets and not chain addresses. Exclude any
    # address-like substring that only occurs inside an image_url value.
    def collect_image_urls(o):
        urls = set()
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "image_url" and isinstance(v, str):
                    urls.add(v)
                else:
                    urls |= collect_image_urls(v)
        elif isinstance(o, list):
            for v in o:
                urls |= collect_image_urls(v)
        return urls

    image_urls = collect_image_urls(payload)

    def in_image_url(s):
        return any(s in u for u in image_urls)

    unknown = sorted(
        {s for s in addr_re.findall(text)
         if s not in allowed and not in_image_url(s)})
    if unknown:
        raise AssertionError(
            "non-mint address-like strings outside candidates/watchlist "
            f"mint fields and launchpad metadata: {unknown[:5]}")


def publish_file(repo, path, raw_bytes, message):
    """Push raw_bytes to path in repo (one commit). Skip if byte-identical.

    Returns ("pushed", sha) or ("skipped", None). Retries once on 409/422 by
    re-reading the branch head.
    """
    current = get_remote_file(repo, path)
    if current is not None and current == raw_bytes:
        return "skipped", None

    blob = gh("POST", f"/repos/{repo}/git/blobs",
              {"content": base64.b64encode(raw_bytes).decode(),
               "encoding": "base64"})

    def commit_on_head():
        ref = gh("GET", f"/repos/{repo}/git/refs/heads/{BRANCH}")
        head_sha = ref["object"]["sha"]
        head_commit = gh("GET", f"/repos/{repo}/git/commits/{head_sha}")
        base_tree = head_commit["tree"]["sha"]
        tree = gh("POST", f"/repos/{repo}/git/trees",
                  {"base_tree": base_tree,
                   "tree": [{"path": path, "mode": "100644",
                             "type": "blob", "sha": blob["sha"]}]})
        return gh("POST", f"/repos/{repo}/git/commits",
                  {"message": message, "tree": tree["sha"],
                   "parents": [head_sha]})

    commit = commit_on_head()
    try:
        # PATCH on the plural /git/refs/ path (singular /git/ref/ 404s)
        gh("PATCH", f"/repos/{repo}/git/refs/heads/{BRANCH}",
           {"sha": commit["sha"]})
    except GitHubError as e:
        if e.status not in (409, 422):
            raise
        commit = commit_on_head()  # ref moved under us; retry once
        gh("PATCH", f"/repos/{repo}/git/refs/heads/{BRANCH}",
           {"sha": commit["sha"]})
    return "pushed", commit["sha"]


def load_stream_candidates():
    """Live stream-gated candidates (watcher/live-candidates.json).

    Written by stream_gates.py (Neon stream_events -> $10K floor -> 9 gates).
    Entries carry the full candidate shape plus source="stream". Returns []
    when the file is absent/unreadable - the merge is best-effort and must
    never break the scanner publish.
    """
    path = os.path.join(WATCHER_DIR, "live-candidates.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def merge_stream_candidates(state_obj):
    """Prepend stream candidates (newest first) to the candidates array.

    Dedupes by mint: a mint already in the scanner candidates keeps the
    scanner's entry. Belt and suspenders: stream entries with a known
    sub-$10K mcap (DexScreener quote, or the gate-derived fallback) are
    dropped here too - Dip wants sub-$10K hidden everywhere. Stream entries
    are marked source="stream". Returns the number of stream entries merged.
    """
    stream = load_stream_candidates()
    if not stream:
        return 0
    existing = state_obj.get("candidates", [])
    seen_mints = {c.get("mint") for c in existing if isinstance(c, dict)}
    fresh = []
    dropped = 0
    for e in stream:
        if not (isinstance(e, dict) and e.get("mint")):
            continue
        if e["mint"] in seen_mints:
            continue
        mcap = e.get("mcap")
        if mcap is None:
            mcap = e.get("mcap_usd")
        if mcap is not None and mcap < 10000:
            dropped += 1
            continue
        fresh.append(e)
    if fresh:
        state_obj["candidates"] = fresh + existing
    if dropped:
        print(f"stream merge: dropped {dropped} sub-$10K stream candidate(s)",
              flush=True)
    return len(fresh)


def main():
    state_path = os.path.join(WATCHER_DIR, "state.json")
    with open(state_path, "rb") as f:
        state_bytes = f.read()

    # Merge stream-gated live candidates into the published candidates array
    # (newest first, source="stream") without touching scanner candidates.
    try:
        state_obj = json.loads(state_bytes)
        n_stream = merge_stream_candidates(state_obj)
        if n_stream:
            state_bytes = json.dumps(state_obj, indent=1).encode()
            print(f"stream merge: +{n_stream} stream candidate(s) "
                  f"({len(state_obj['candidates'])} total)", flush=True)
    except Exception as e:  # noqa: BLE001 - never break the publish on merge
        print(f"stream merge skipped: {e}", flush=True)

    journal_path = os.path.join(BOT_DIR, "journal.json")
    if os.path.exists(journal_path):
        with open(journal_path, "rb") as f:
            journal_bytes = f.read()
    else:
        journal_bytes = b"{}"

    # Regenerate whale buys (tracked-wallet detection; empty whitelist ->
    # valid empty payload). Never fatal: whale_buys.py exits 0 always.
    import subprocess
    try:
        subprocess.run([sys.executable,
                        os.path.join(WATCHER_DIR, "whale_buys.py")],
                       timeout=120, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"whale_buys: skipped ({e})", flush=True)
    buys_path = os.path.join(WATCHER_DIR, "whale-buys.json")
    if os.path.exists(buys_path):
        with open(buys_path, "rb") as f:
            buys_bytes = f.read()
    else:
        buys_bytes = b'{"updated_at":0,"wallet_count":0,"buys":[]}'

    # state.json -> PUBLIC repo (safety assertion first)
    try:
        assert_public_safe(state_bytes)
    except AssertionError as e:
        print(f"SAFETY ABORT: state.json NOT pushed to {PUBLIC_REPO}: {e}",
              flush=True)
    else:
        status, sha = publish_file(PUBLIC_REPO, "state.json", state_bytes,
                                   "data: watcher state update")
        print(f"public {PUBLIC_REPO}/state.json: {status} "
              f"({len(state_bytes)}B" +
              (f", {sha[:10]}" if sha else "") + ")", flush=True)

    # journal.json -> PRIVATE repo (journal pushes SHOULD build on Vercel)
    status, sha = publish_file(PRIVATE_REPO, "data/journal.json",
                               journal_bytes, "data: journal update")
    print(f"private {PRIVATE_REPO}/data/journal.json: {status} "
          f"({len(journal_bytes)}B" +
          (f", {sha[:10]}" if sha else "") + ")", flush=True)

    # whale-buys.json -> PRIVATE repo (tracked-wallet buys; wallet
    # membership is Dip's IP, never the public repo)
    status, sha = publish_file(PRIVATE_REPO, "data/whale-buys.json",
                               buys_bytes, "data: whale buys update")
    print(f"private {PRIVATE_REPO}/data/whale-buys.json: {status} "
          f"({len(buys_bytes)}B" +
          (f", {sha[:10]}" if sha else "") + ")", flush=True)

    # watchlist-state.json -> PRIVATE repo (watched-wallet holdings + new
    # buys; wallet membership is Dip's IP, never the public repo)
    try:
        subprocess.run([sys.executable, os.path.join(WATCHER_DIR, "watchlist.py")],
                       timeout=180, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"watchlist: skipped ({e})", flush=True)
    wl_path = os.path.join(WATCHER_DIR, "watchlist-state.json")
    if os.path.exists(wl_path):
        with open(wl_path, "rb") as f:
            wl_bytes = f.read()
    else:
        wl_bytes = b'{"updated_at":0,"wallets":[],"recent_buys":[]}'
    status, sha = publish_file(PRIVATE_REPO, "data/watchlist-state.json",
                               wl_bytes, "data: watchlist state update")
    print(f"private {PRIVATE_REPO}/data/watchlist-state.json: {status} "
          f"({len(wl_bytes)}B" +
          (f", {sha[:10]}" if sha else "") + ")", flush=True)

    # smart-money.json -> PRIVATE repo (discovered wallet rankings;
    # wallet membership is Dip's IP, never the public repo)
    sm_path = os.path.join(WATCHER_DIR, "..", "wallets", "smart-money.json")
    if os.path.exists(sm_path):
        with open(sm_path, "rb") as f:
            sm_bytes = f.read()
    else:
        sm_bytes = b'{"updated_at":0,"wallets":[]}'
    status, sha = publish_file(PRIVATE_REPO, "data/smart-money.json",
                               sm_bytes, "data: smart money update")
    print(f"private {PRIVATE_REPO}/data/smart-money.json: {status} "
          f"({len(sm_bytes)}B" +
          (f", {sha[:10]}" if sha else "") + ")", flush=True)

    # smart-money-buys.json -> PRIVATE repo (tracked smart-money buys)
    smb_path = os.path.join(WATCHER_DIR, "smart-money-buys.json")
    if os.path.exists(smb_path):
        with open(smb_path, "rb") as f:
            smb_bytes = f.read()
    else:
        smb_bytes = b'{"updated_at":0,"buys":[]}'
    status, sha = publish_file(PRIVATE_REPO, "data/smart-money-buys.json",
                               smb_bytes, "data: smart money buys update")
    print(f"private {PRIVATE_REPO}/data/smart-money-buys.json: {status} "
          f"({len(smb_bytes)}B" +
          (f", {sha[:10]}" if sha else "") + ")", flush=True)


if __name__ == "__main__":
    main()
