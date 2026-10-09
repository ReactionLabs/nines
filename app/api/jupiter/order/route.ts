/**
 * Jupiter Swap API v2 proxy — GET /order.
 *
 * Forwards quote/order requests to Jupiter's current API (keyless lite
 * endpoint). Kept server-side so the app pins the API host and shields the
 * public endpoint from direct browser traffic.
 *
 * Query: inputMint, outputMint, amount (base units), taker (wallet address).
 * Returns Jupiter's order JSON unchanged: { transaction, requestId,
 * outAmount, inAmount, router, ... }.
 */

const BASE = process.env.JUPITER_SWAP_BASE ?? "https://lite-api.jup.ag/swap/v2";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inputMint = url.searchParams.get("inputMint") ?? "";
  const outputMint = url.searchParams.get("outputMint") ?? "";
  const amount = url.searchParams.get("amount") ?? "";
  const taker = url.searchParams.get("taker") ?? "";

  if (!B58.test(inputMint) || !B58.test(outputMint)) {
    return Response.json({ ok: false, error: "Invalid mints." }, { status: 400 });
  }
  if (!/^\d+$/.test(amount) || amount === "0") {
    return Response.json({ ok: false, error: "Invalid amount." }, { status: 400 });
  }
  if (!B58.test(taker)) {
    return Response.json({ ok: false, error: "Invalid taker address." }, { status: 400 });
  }

  const upstream = `${BASE}/order?` + new URLSearchParams({ inputMint, outputMint, amount, taker });
  let res: Response;
  try {
    res = await fetch(upstream, { headers: { Accept: "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "Jupiter unreachable." }, { status: 502 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    return Response.json(
      { ok: false, error: "Jupiter order failed.", detail: data },
      { status: 502 }
    );
  }
  return Response.json(data);
}
