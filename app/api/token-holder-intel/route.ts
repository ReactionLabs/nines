/**
 * Token holder intel + security flags — GET /api/token-holder-intel
 *
 * Read-only on-chain holder intelligence for one or more Solana token mints,
 * served from Helius RPC. Two modes:
 *
 *   Compact (default):  ?mints=<mint>[,<mint>...]   (max 10)
 *     Top holder %, holder count (+growth vs previous scan), dev wallet %,
 *     mint/freeze authority flags. Light enough to render under every
 *     scanner feed card.
 *
 *   Detail:             ?mint=<mint>&detail=1
 *     Everything in compact plus: sniper count, burned supply %, LP burn
 *     status, and a simulation-based honeypot check (Jupiter-built sell
 *     from a real holder, executed via simulateTransaction with signature
 *     verification off — nothing is signed, nothing moves).
 *
 * Honesty contract (matches the rest of the app): any metric that cannot be
 * verified on-chain is returned as null and rendered as "unavailable" —
 * never a placeholder number. Methodology notes ride along in `notes`.
 *
 * Auth: dashboard cookie auth via middleware (dip + johnny roles), same as
 * every other /api/* route. In-memory cache: 120s TTL per mint.
 *
 * Helius key: HELIUS_API_KEY when set, else parsed from
 * NEXT_PUBLIC_SOLANA_RPC_URL (already public), else the public cluster URL.
 * Read-only RPC calls only; the key is never logged.
 */

import type {
  DevInfo,
  HolderGrowth,
  HoneypotInfo,
  IntelBase,
  IntelDetail,
  TopEntry,
} from "@/lib/holder-intel";

export const dynamic = "force-dynamic";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS = 10;
const CACHE_TTL_MS = 120_000;
const SIG_PAGE = 1000;
const SIG_PAGES_MAX = 5;
const SNIPER_WINDOW_SEC = 60;
const SNIPER_TX_CAP = 50;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";

/* ------------------------------------------------------------------ */
/* rpc plumbing                                                        */
/* ------------------------------------------------------------------ */

function rpcUrl(): string {
  const direct = (process.env.HELIUS_API_KEY ?? "").trim();
  if (direct) return `https://mainnet.helius-rpc.com/?api-key=${direct}`;
  const pub = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "";
  if (pub) return pub;
  return "https://api.mainnet-beta.solana.com";
}

async function rpc<T>(method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await res.json().catch(() => null)) as {
    result?: T;
    error?: { message?: string };
  } | null;
  if (!j || j.error) throw new Error(j?.error?.message ?? "rpc failed");
  return j.result as T;
}

/** Never throws: returns null on any failure (timeout, RPC error, ...). */
async function tryRpc<T>(method: string, params: unknown[], timeoutMs = 20000): Promise<T | null> {
  try {
    return await rpc<T>(method, params, timeoutMs);
  } catch {
    return null;
  }
}

type CacheEntry = { data: IntelBase | IntelDetail; exp: number };
const cache = new Map<string, CacheEntry>();

/** Holder-count observations for growth: mint -> [{ts, count}]. */
const holderObs = new Map<string, Array<{ ts: number; count: number }>>();

function recordHolders(mint: string, count: number): HolderGrowth {
  const now = Math.floor(Date.now() / 1000);
  const arr = holderObs.get(mint) ?? [];
  arr.push({ ts: now, count });
  while (arr.length > 48) arr.shift();
  // prune older than 7 days
  while (arr.length > 1 && now - arr[0].ts > 7 * 24 * 3600) arr.shift();
  holderObs.set(mint, arr);
  let prev: { ts: number; count: number } | null = null;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (now - arr[i].ts >= 300) {
      prev = arr[i];
      break;
    }
  }
  if (!prev && arr.length >= 2) prev = arr[arr.length - 2];
  const growthPct =
    prev && prev.count > 0 ? ((count - prev.count) / prev.count) * 100 : null;
  return {
    count,
    prevCount: prev ? prev.count : null,
    prevAt: prev ? prev.ts : null,
    growthPct,
  };
}

function emptyGrowth(): HolderGrowth {
  return { count: null, prevCount: null, prevAt: null, growthPct: null };
}

function pctOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** Run async tasks with at most `limit` in flight. Keeps the batch endpoint
 *  from firing hundreds of concurrent RPC calls at Helius (which throttles
 *  into 429s that surface as "unavailable" metrics). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* on-chain readers                                                    */
/* ------------------------------------------------------------------ */

interface MintParsed {
  decimals: number;
  supplyUi: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  program: string;
}

async function readMint(mint: string): Promise<MintParsed | null> {
  const r = await tryRpc<{
    value: {
      owner: string;
      data: { parsed: { info: Record<string, unknown> } };
    } | null;
  }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const v = r?.value;
  const info = v?.data?.parsed?.info;
  if (!v || !info) return null;
  const decimals = Number(info.decimals);
  const supplyRaw = Number(info.supply);
  if (!Number.isFinite(decimals) || !Number.isFinite(supplyRaw)) return null;
  return {
    decimals,
    supplyUi: supplyRaw / 10 ** decimals,
    mintAuthority: (info.mintAuthority as string) ?? null,
    freezeAuthority: (info.freezeAuthority as string) ?? null,
    program: v.owner,
  };
}

interface LargestAcct {
  address: string;
  uiAmount: number;
}

async function readLargest(mint: string): Promise<LargestAcct[]> {
  const r = await tryRpc<{ value: Array<{ address: string; uiAmount: number | null }> }>(
    "getTokenLargestAccounts",
    [mint, { commitment: "confirmed" }]
  );
  return (r?.value ?? []).map((a) => ({
    address: a.address,
    uiAmount: typeof a.uiAmount === "number" ? a.uiAmount : 0,
  }));
}

async function tokenAccountOwner(tokenAccount: string): Promise<string | null> {
  const r = await tryRpc<{
    value: { data: { parsed: { info: { owner: string } } } } | null;
  }>("getAccountInfo", [tokenAccount, { encoding: "jsonParsed", commitment: "confirmed" }], 12000);
  return r?.value?.data?.parsed?.info?.owner ?? null;
}

async function isExecutable(address: string): Promise<boolean> {
  const r = await tryRpc<{ value: { executable: boolean } | null }>(
    "getAccountInfo",
    [address, { encoding: "base64", commitment: "confirmed" }],
    12000
  );
  return r?.value?.executable === true;
}

async function buildTopEntries(
  largest: LargestAcct[],
  supplyUi: number
): Promise<{ top: TopEntry | null; top5: TopEntry[] }> {
  const slice = largest.slice(0, 5);
  const owners = await Promise.all(slice.map((a) => tokenAccountOwner(a.address)));
  // Classify every resolved owner (executable => program-owned account such
  // as an AMM/bonding curve). The kinds feed both the card row and the
  // honeypot taker selection, so this runs once here instead of twice.
  const execFlags = await Promise.all(
    owners.map((o) => (o ? isExecutable(o).catch(() => null) : Promise.resolve(null)))
  );
  const top5: TopEntry[] = slice.map((a, i) => ({
    address: a.address,
    owner: owners[i] ?? "unknown",
    pct: pctOf(a.uiAmount, supplyUi),
    kind:
      owners[i] === null || owners[i] === undefined
        ? "unknown"
        : execFlags[i] === null
          ? "unknown"
          : execFlags[i]
            ? "program"
            : "wallet",
  }));
  return { top: top5[0] ?? null, top5 };
}

/** Count of token accounts with nonzero balance for this mint. Uses Helius
 *  getProgramAccountsV2 with cursor pagination: the plain getProgramAccounts
 *  is blocked by Helius on the classic Token program ("too many accounts"),
 *  and V2's memcmp filter on the classic program only matches when paired
 *  with a dataSize:165 filter (all classic token accounts are 165 bytes).
 *  The mint's owner program decides which program's accounts to scan
 *  (pump.fun mints may be classic Token or Token-2022). */
async function countHolders(mint: string, program: string): Promise<number | null> {
  const filters: unknown[] = [{ memcmp: { offset: 0, bytes: mint } }];
  if (program === TOKEN_PROGRAM) filters.push({ dataSize: 165 });
  let pkey: string | undefined;
  let n = 0;
  let pages = 0;
  const buf = Buffer.alloc(8);
  while (pages < 40) {
    const cfg: Record<string, unknown> = {
      encoding: "base64",
      dataSlice: { offset: 64, length: 8 },
      filters,
      commitment: "confirmed",
      limit: 5000,
    };
    if (pkey) cfg.paginationKey = pkey;
    const r = await tryRpc<{
      accounts: Array<{ account: { data: [string, string] } }>;
      paginationKey?: string;
    }>("getProgramAccountsV2", [program, cfg], 30000);
    if (!r) return null;
    pages++;
    for (const a of r.accounts) {
      try {
        const raw = Buffer.from(a.account.data[0], "base64");
        if (raw.length < 8) continue;
        raw.copy(buf, 0, 0, 8);
        if (buf.readBigUInt64LE(0) > BigInt(0)) n++;
      } catch {
        /* skip malformed */
      }
    }
    pkey = r.paginationKey;
    if (!pkey || r.accounts.length === 0) break;
  }
  return n;
}

interface SigInfo {
  signature: string;
  blockTime: number | null;
}

/** Page back through the mint's transaction history (newest first). Returns
 *  all fetched signatures and whether we reached the true oldest (genesis). */
async function readHistory(mint: string): Promise<{ sigs: SigInfo[]; genesisReached: boolean }> {
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  let genesisReached = false;
  for (let page = 0; page < SIG_PAGES_MAX; page++) {
    const params: Record<string, unknown> = { limit: SIG_PAGE };
    if (before) params.before = before;
    const r = await tryRpc<SigInfo[]>(
      "getSignaturesForAddress",
      [mint, params],
      20000
    );
    const arr = Array.isArray(r) ? r : [];
    if (arr.length === 0) {
      genesisReached = true;
      break;
    }
    sigs.push(...arr);
    if (arr.length < SIG_PAGE) {
      genesisReached = true;
      break;
    }
    before = arr[arr.length - 1].signature;
  }
  return { sigs, genesisReached };
}

function feePayerOf(tx: {
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
} | null): string | null {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return null;
  const k0 = keys[0];
  return typeof k0 === "string" ? k0 : k0?.pubkey ?? null;
}

async function readDevWallet(mint: string, sigs: SigInfo[]): Promise<string | null> {
  if (sigs.length === 0) return null;
  const oldest = sigs[sigs.length - 1];
  const tx = await tryRpc("getTransaction", [
    oldest.signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ], 15000);
  return feePayerOf(tx as Parameters<typeof feePayerOf>[0]);
}

async function walletMintBalanceUi(owner: string, mint: string): Promise<number | null> {
  const r = await tryRpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }>;
  }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }], 15000);
  if (!r) return null;
  let sum = 0;
  for (const a of r.value) {
    const v = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof v === "number") sum += v;
  }
  return sum;
}

/* ------------------------------------------------------------------ */
/* intel builders                                                      */
/* ------------------------------------------------------------------ */

const NOTES_COMPACT = [
  "Top holder % = largest single token account's share of total supply (getTokenLargestAccounts).",
  "Holder count = token accounts with nonzero balance (getProgramAccounts scan).",
  "Dev wallet = fee payer of the token's earliest indexed transaction; share = its current holdings.",
  "LP burn % is unavailable: LP-token attribution across AMM variants is not implemented.",
  "Bundled supply % is unavailable: funding-graph clustering is not implemented.",
];

interface Core {
  parsed: MintParsed;
  largest: LargestAcct[];
  holderCount: number | null;
  history: { sigs: SigInfo[]; genesisReached: boolean };
}

/** The shared on-chain fetch used by both compact and detail builds, so the
 *  detail path never re-fetches what compact already pulled. */
async function fetchCore(mint: string): Promise<Core | null> {
  const parsed = await readMint(mint);
  if (!parsed) return null;
  const [largest, holderCount, history] = await Promise.all([
    readLargest(mint),
    countHolders(mint, parsed.program),
    readHistory(mint),
  ]);
  return { parsed, largest, holderCount, history };
}

async function buildCompact(mint: string): Promise<{ intel: IntelBase; core: Core | null }> {
  const fetchedAt = Math.floor(Date.now() / 1000);
  const core = await fetchCore(mint);
  const intel = await buildCompactFromCore(mint, core, fetchedAt);
  return { intel, core };
}

async function buildCompactFromCore(
  mint: string,
  core: Core | null,
  fetchedAt: number
): Promise<IntelBase> {
  const notes = [...NOTES_COMPACT];
  const fail = (reason: string): IntelBase => ({
    mint,
    ok: false,
    reason,
    fetchedAt,
    cached: false,
    decimals: null,
    supply: null,
    holders: emptyGrowth(),
    topHolder: null,
    top5: [],
    dev: null,
    mintAuthority: null,
    mintAuthorityRenounced: null,
    freezeAuthority: null,
    freezeAuthorityRenounced: null,
    lpBurnPct: null,
    notes,
  });

  if (!core) return fail("mint account not found or not a token mint");
  const { parsed, largest, holderCount, history } = core;

  const { top, top5 } = await buildTopEntries(largest, parsed.supplyUi);

  let dev: DevInfo | null = null;
  let devUnavailableReason: string | undefined;
  if (history.genesisReached && history.sigs.length > 0) {
    const wallet = await readDevWallet(mint, history.sigs);
    if (wallet) {
      const bal = await walletMintBalanceUi(wallet, mint);
      dev = {
        wallet,
        pct: bal === null ? null : pctOf(bal, parsed.supplyUi),
        method: "fee payer of earliest indexed mint transaction",
      };
      if (dev.pct === null) notes.push("Dev wallet found but its balance could not be read.");
    } else {
      devUnavailableReason = "earliest transaction could not be fetched";
    }
  } else {
    devUnavailableReason =
      "transaction history too deep to reach the token's first transaction; dev wallet unverifiable";
  }

  return {
    mint,
    ok: true,
    fetchedAt,
    cached: false,
    decimals: parsed.decimals,
    supply: parsed.supplyUi,
    holders:
      holderCount === null
        ? emptyGrowth()
        : recordHolders(mint, holderCount),
    topHolder: top,
    top5,
    dev,
    devUnavailableReason,
    mintAuthority: parsed.mintAuthority,
    mintAuthorityRenounced: parsed.mintAuthority === null,
    freezeAuthority: parsed.freezeAuthority,
    freezeAuthorityRenounced: parsed.freezeAuthority === null,
    lpBurnPct: null,
    notes: [
      ...notes,
      holderCount === null
        ? "Holder count unavailable: holder scan timed out or failed."
        : `Holder scan: ${holderCount.toLocaleString()} nonzero-balance accounts.`,
      history.genesisReached
        ? `History scan reached the token's first on-chain transaction (${history.sigs.length} signatures indexed).`
        : `History scan hit the ${(SIG_PAGES_MAX * SIG_PAGE).toLocaleString()}-signature cap before the first transaction; early-holder metrics are unavailable.`,
    ],
  };
}

/* ---------------- detail-only sections ---------------- */

async function countSnipers(
  mint: string,
  sigs: SigInfo[],
  genesisReached: boolean
): Promise<IntelDetail["snipers"]> {
  const base = {
    count: null as number | null,
    windowSec: SNIPER_WINDOW_SEC,
    method: `distinct fee-payer wallets with transactions in the first ${SNIPER_WINDOW_SEC}s after the token's first on-chain activity`,
  };
  if (!genesisReached) return { ...base, reason: "first transaction unreachable; sniper window unverifiable" };
  const oldest = sigs[sigs.length - 1];
  if (!oldest || typeof oldest.blockTime !== "number") {
    return { ...base, reason: "earliest transaction has no block time" };
  }
  const cutoff = oldest.blockTime + SNIPER_WINDOW_SEC;
  const window = sigs.filter(
    (s) => typeof s.blockTime === "number" && (s.blockTime as number) <= cutoff
  );
  // oldest-first for the cap
  window.sort((a, b) => (a.blockTime as number) - (b.blockTime as number));
  const sample = window.slice(0, SNIPER_TX_CAP);
  const payers = new Set<string>();
  let fetched = 0;
  for (let i = 0; i < sample.length; i += 10) {
    const batch = sample.slice(i, i + 10);
    const txs = await Promise.all(
      batch.map((s) =>
        tryRpc("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ], 15000)
      )
    );
    for (const tx of txs) {
      const p = feePayerOf(tx as Parameters<typeof feePayerOf>[0]);
      if (p) {
        payers.add(p);
        fetched++;
      }
    }
  }
  const reason =
    window.length > SNIPER_TX_CAP
      ? `window holds ${window.length} transactions; first ${SNIPER_TX_CAP} sampled`
      : undefined;
  return { ...base, count: payers.size, reason };
}

/**
 * Simulation-based honeypot check: build a small Jupiter sell order from a
 * real holder's wallet, then simulateTransaction it with signature
 * verification off. Nothing is signed; nothing moves. A clean simulation
 * means the token can be sold right now through Jupiter routing.
 */
async function checkHoneypot(
  mint: string,
  decimals: number,
  supplyUi: number,
  top5: TopEntry[]
): Promise<HoneypotInfo> {
  const method =
    "Jupiter sell order (token -> SOL) simulated via simulateTransaction with sigVerify off; unsigned, nothing moves";
  // Candidate takers: largest holders whose owner is a plain wallet (not a
  // program). Kinds were already classified when the top entries were built,
  // so no extra RPC here. Jupiter sometimes rejects a specific taker (400),
  // so try up to three before giving up.
  const candidates = top5
    .filter((t) => t.kind === "wallet" && t.owner !== "unknown" && (t.pct ?? 0) > 0)
    .slice(0, 3)
    .map((t) => ({ taker: t.owner, balUi: ((t.pct ?? 0) / 100) * supplyUi }));
  if (candidates.length === 0) {
    return { sellable: null, method, reason: "no suitable holder wallet found to simulate from" };
  }

  const simulatedAt = Math.floor(Date.now() / 1000);
  let lastReason = "Jupiter order failed";
  for (const c of candidates) {
    const sellUi = Math.min(c.balUi * 0.001, 50);
    const amount = Math.floor(sellUi * 10 ** decimals);
    if (amount <= 0) continue;
    let txB64: string | null = null;
    try {
      const u =
        `${JUPITER_ORDER}?` +
        new URLSearchParams({
          inputMint: mint,
          outputMint: SOL_MINT,
          amount: String(amount),
          taker: c.taker,
        });
      const res = await fetch(u, {
        headers: { Accept: "application/json", "User-Agent": "tyck-trade/1.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 404 || /route not found/i.test(body)) {
          return { sellable: null, method, reason: "no Jupiter route for this token (illiquid or unroutable); cannot test the sell path" };
        }
        lastReason = `Jupiter order failed (HTTP ${res.status})`;
        continue; // try the next holder as taker
      }
      const j = (await res.json().catch(() => null)) as {
        transaction?: string;
        outAmount?: string;
      } | null;
      txB64 = j?.transaction ?? null;
      if (!txB64) {
        lastReason = "Jupiter returned no transaction";
        continue;
      }
    } catch {
      return { sellable: null, method, reason: "Jupiter unreachable" };
    }
    const sim = await tryRpc<{ value: { err: unknown } }>(
      "simulateTransaction",
      [
        txB64,
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
      ],
      25000
    );
    if (!sim) {
      lastReason = "simulation RPC failed";
      continue;
    }
    const err = sim.value?.err;
    if (err === null || err === undefined) {
      return { sellable: true, method, simulatedAt };
    }
    let errStr = "";
    try {
      errStr = JSON.stringify(err);
    } catch {
      /* ignore */
    }
    if (/InsufficientFundsForRent|insufficient funds|AccountNotFound/i.test(errStr)) {
      // Simulation artifact: the taker wallet lacks SOL for rent on an
      // account the swap creates. Says nothing about the token — try the
      // next holder.
      lastReason = "simulation inconclusive (taker lacked SOL for rent)";
      continue;
    }
    return {
      sellable: false,
      method,
      reason: `simulated sell reverted: ${errStr.slice(0, 160)}`,
      simulatedAt,
    };
  }
  return { sellable: null, method, reason: lastReason };
}

async function buildDetail(mint: string, core: Core, compact: IntelBase): Promise<IntelDetail> {
  const notes = [...compact.notes];
  const history = core.history;
  const firstSeenOnchain =
    history.genesisReached && history.sigs.length > 0
      ? history.sigs[history.sigs.length - 1].blockTime
      : null;

  const [snipers, burnedBal, honeypot] = await Promise.all([
    countSnipers(mint, history.sigs, history.genesisReached),
    walletMintBalanceUi(INCINERATOR, mint),
    compact.decimals !== null && compact.supply !== null
      ? checkHoneypot(mint, compact.decimals, compact.supply, compact.top5)
      : Promise.resolve<HoneypotInfo>({
          sellable: null,
          method: "honeypot simulation",
          reason: "decimals unknown; cannot size the simulated sell",
        }),
  ]);

  const burnedPct =
    burnedBal === null || compact.supply === null ? null : pctOf(burnedBal, compact.supply);

  notes.push(
    "Sniper count = distinct fee-payer wallets transacting within 60s of the token's first on-chain activity (bounded sample when the window is large).",
    "Burned % = share of supply sitting in the incinerator address.",
    honeypot.sellable === true
      ? "Honeypot check: a Jupiter-built sell from a real holder simulated clean — the token is sellable through Jupiter routing right now."
      : honeypot.sellable === false
        ? "Honeypot check: the simulated sell REVERTED — treat as unsellable until verified otherwise."
        : `Honeypot check unavailable: ${honeypot.reason ?? "unknown"}.`
  );

  return {
    ...compact,
    genesisReached: history.genesisReached,
    firstSeenOnchain,
    snipers,
    bundledPct: null,
    burnedPct,
    honeypot,
    notes: [
      ...notes,
      "Bundled supply % is unavailable: funding-graph clustering of linked wallets is not implemented; any number here would be a guess.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const detail = searchParams.get("detail") === "1";
  const single = searchParams.get("mint") ?? "";
  const raw = detail
    ? [single]
    : (searchParams.get("mints") ?? "").split(",").filter(Boolean);
  const mints = Array.from(new Set(raw)).slice(0, MAX_MINTS);

  if (mints.length === 0) {
    return Response.json({ ok: false, reason: "mint(s) required" }, { status: 400 });
  }
  if (!mints.every((m) => MINT_RE.test(m))) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }
  if (detail && mints.length !== 1) {
    return Response.json(
      { ok: false, reason: "detail=1 takes a single mint" },
      { status: 400 }
    );
  }

  const out: Record<string, IntelBase | IntelDetail> = {};
  // At most 3 mints scan concurrently; each mint fans out to ~10 RPC calls
  // internally, so this keeps total concurrency in a range Helius tolerates.
  await mapLimit(mints, 3, async (mint) => {
      const key = `${detail ? "detail" : "compact"}:${mint}`;
      const hit = cache.get(key);
      if (hit && hit.exp > Date.now()) {
        out[mint] = { ...hit.data, cached: true };
        return;
      }
      try {
        const { intel: compact, core } = await buildCompact(mint);
        const data =
          detail && compact.ok && core
            ? await buildDetail(mint, core, compact)
            : compact;
        cache.set(key, { data, exp: Date.now() + CACHE_TTL_MS });
        out[mint] = data;
      } catch (e) {
        out[mint] = {
          mint,
          ok: false,
          reason: e instanceof Error ? e.message : "intel fetch failed",
          fetchedAt: Math.floor(Date.now() / 1000),
          cached: false,
          decimals: null,
          supply: null,
          holders: emptyGrowth(),
          topHolder: null,
          top5: [],
          dev: null,
          mintAuthority: null,
          mintAuthorityRenounced: null,
          freezeAuthority: null,
          freezeAuthorityRenounced: null,
          lpBurnPct: null,
          notes: [],
        };
      }
    }
  );

  return Response.json(
    { ok: true, detail, tokens: out },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}
