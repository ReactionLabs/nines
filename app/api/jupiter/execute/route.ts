/**
 * Jupiter Swap API v2 proxy — POST /execute.
 *
 * Takes a wallet-signed transaction and lands it via Jupiter's managed
 * execution pipeline. Body: { signedTransaction (base64), requestId }.
 * Returns Jupiter's execute JSON: { status, signature, code, ... }.
 *
 * The server never signs anything and never sees private keys — the
 * transaction arrives already signed by the user's wallet.
 */

const BASE = process.env.JUPITER_SWAP_BASE ?? "https://lite-api.jup.ag/swap/v2";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const signedTransaction = body?.signedTransaction;
  const requestId = body?.requestId;
  if (typeof signedTransaction !== "string" || signedTransaction.length < 100) {
    return Response.json({ ok: false, error: "Invalid signedTransaction." }, { status: 400 });
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return Response.json({ ok: false, error: "requestId required." }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ signedTransaction, requestId }),
    });
  } catch {
    return Response.json({ ok: false, error: "Jupiter unreachable." }, { status: 502 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    return Response.json(
      { ok: false, error: "Jupiter execute failed.", detail: data },
      { status: 502 }
    );
  }
  return Response.json(data);
}
