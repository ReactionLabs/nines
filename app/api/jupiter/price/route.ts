/**
 * Jupiter Price API v3 proxy — GET ?ids=<mint,mint>.
 * Used to convert the fixed USD trade size into SOL lamports.
 */

const BASE = "https://lite-api.jup.ag/price/v3";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ids = url.searchParams.get("ids") ?? "";
  if (!ids || ids.length > 500) {
    return Response.json({ ok: false, error: "ids required." }, { status: 400 });
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}?ids=${encodeURIComponent(ids)}`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return Response.json({ ok: false, error: "Jupiter unreachable." }, { status: 502 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    return Response.json({ ok: false, error: "Price lookup failed." }, { status: 502 });
  }
  return Response.json(data);
}
