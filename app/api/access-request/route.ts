import { NextResponse } from "next/server";

/**
 * Access-request queue for non-whitelisted wallets.
 *
 * Unauthenticated users hit this from /login after a denied wallet login.
 * Requests are appended to data/access-requests.json on the MAIN branch
 * (the file the box-side watcher reads), via the GitHub Contents API.
 *
 * The box watcher picks up new entries, queues a kind="access-request"
 * notify for Dip's phone push, and Dip approves/denies by editing
 * WALLET_ALLOWLIST. Nothing here grants a session, ever.
 */

export const dynamic = "force-dynamic";

const OWNER = "ReactionLabs";
const REPO = "tyck-trade";
const FILE = "data/access-requests.json";
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_NOTE = 500;

// Best-effort per-instance rate limit: 10 requests / minute / IP.
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
}

interface AccessRequest {
  ts: number;
  address: string;
  note: string;
  notified: boolean;
}

async function readQueue(token: string): Promise<{
  sha: string | null;
  items: AccessRequest[];
}> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    }
  );
  if (res.status === 404) return { sha: null, items: [] };
  if (!res.ok) throw new Error(`queue read failed: ${res.status}`);
  const d = (await res.json()) as { sha?: string; content?: string };
  const raw = Buffer.from(d.content ?? "", "base64").toString("utf8");
  const parsed: unknown = JSON.parse(raw);
  return {
    sha: d.sha ?? null,
    items: Array.isArray(parsed) ? (parsed as AccessRequest[]) : [],
  };
}

export async function POST(req: Request) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Request queue is not configured." },
      { status: 503 }
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Slow down." },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  const address =
    typeof body?.address === "string" ? body.address.trim() : "";
  const note =
    typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json(
      { ok: false, error: "Invalid wallet address." },
      { status: 400 }
    );
  }

  // Optimistic-locking append: refetch on sha conflict.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha: string | null;
    let items: AccessRequest[];
    try {
      ({ sha, items } = await readQueue(token));
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not reach the request queue." },
        { status: 502 }
      );
    }

    // Idempotent: an address already in the queue is already queued.
    if (items.some((r) => r.address === address)) {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 202 });
    }

    const next: AccessRequest[] = [
      ...items,
      { ts: Date.now(), address, note, notified: false },
    ];
    const put = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `access-request: ${address.slice(0, 4)}…${address.slice(-4)}`,
          content: Buffer.from(JSON.stringify(next, null, 2)).toString(
            "base64"
          ),
          ...(sha ? { sha } : {}),
          branch: "main",
        }),
      }
    ).catch(() => null);

    if (!put) {
      return NextResponse.json(
        { ok: false, error: "Could not reach the request queue." },
        { status: 502 }
      );
    }
    if (put.status === 422 || put.status === 409) continue; // sha moved: refetch
    if (!put.ok) {
      return NextResponse.json(
        { ok: false, error: "Request queue write failed." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  return NextResponse.json(
    { ok: false, error: "Request queue is busy. Try again." },
    { status: 503 }
  );
}
