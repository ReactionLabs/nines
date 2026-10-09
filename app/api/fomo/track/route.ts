/**
 * Track a FOMO wallet in our smart money watchlist.
 *
 * POST /api/fomo/track
 * Body: { address: string, handle?: string, label?: string }
 * -> { ok: true, tracked: boolean, reason?: string }
 *
 * Appends the wallet to data/fomo-tracked.json in the private repo via the
 * GitHub API. The box-side Smart Money Tracker reads this file as an
 * additional wallet source (see docs/HARNESS_SPEC.md).
 *
 * - Only Solana addresses accepted (32-44 char base58).
 * - Idempotent: tracking the same address twice is a no-op.
 * - OWNER only (middleware enforces role; this route double-checks).
 *
 * Requires GITHUB_TOKEN. Without it, returns 503 with a clear reason —
 * the wallet is NOT tracked.
 */
export const dynamic = "force-dynamic";

const REPO = "ReactionLabs/tyck-trade";
const TRACKED_PATH = "data/fomo-tracked.json";
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TrackedWallet {
  address: string;
  handle?: string;
  label?: string;
  source: "fomo";
  tracked_at: number;
  tracked_by: string;
}

async function ghGet(path: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "nines-app",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github GET ${res.status}`);
  return res.json();
}

async function ghPut(path: string, token: string, content: string, sha: string | null, message: string) {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "nines-app",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`github PUT ${res.status}`);
  return res.json();
}

export async function POST(req: Request) {
  // Role check: OWNER only. Middleware gates the route, but double-check
  // the role cookie here since this writes to the repo.
  const role = req.headers.get("cookie")?.match(/(?:^|;\s*)tyck_role=([^;]+)/)?.[1];
  if (role !== "dip") {
    return Response.json({ ok: false, reason: "owner only" }, { status: 403 });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return Response.json(
      { ok: false, reason: "GITHUB_TOKEN not configured — wallet not tracked" },
      { status: 503 }
    );
  }

  let body: { address?: string; handle?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" }, { status: 400 });
  }

  const address = (body.address ?? "").trim();
  if (!ADDR_RE.test(address)) {
    return Response.json({ ok: false, reason: "invalid Solana address" }, { status: 400 });
  }

  try {
    const existing = await ghGet(TRACKED_PATH, token);
    let wallets: TrackedWallet[] = [];
    let sha: string | null = null;

    if (existing) {
      sha = existing.sha;
      const decoded = Buffer.from(existing.content, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      wallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
    }

    // Idempotent: already tracked → no-op success.
    if (wallets.some((w) => w.address === address)) {
      return Response.json({ ok: true, tracked: true, already: true });
    }

    wallets.push({
      address,
      handle: body.handle?.trim() || undefined,
      label: body.label?.trim() || body.handle?.trim() || "FOMO",
      source: "fomo",
      tracked_at: Math.floor(Date.now() / 1000),
      tracked_by: "dip",
    });

    const content = JSON.stringify(
      { updated_at: Math.floor(Date.now() / 1000), wallets },
      null,
      2
    );

    await ghPut(
      TRACKED_PATH,
      token,
      content,
      sha,
      `Track FOMO wallet ${address.slice(0, 8)}... (${body.handle ?? "unknown"})`
    );

    return Response.json({ ok: true, tracked: true });
  } catch (e) {
    return Response.json(
      { ok: false, reason: e instanceof Error ? e.message : "track failed" },
      { status: 502 }
    );
  }
}
