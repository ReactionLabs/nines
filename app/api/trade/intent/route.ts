import { cookies } from "next/headers";

/**
 * Trade intent intake. PHASE 2 DESIGN ONLY.
 *
 * Contract:
 *   POST /api/trade/intent  { mint: string, tier?: string, size_usd?: number }
 *   -> 200 { status: "stubbed", message: "...", received: {...} }
 *   -> 403 { status: "denied", ... } when role is not dip
 *   -> 400 { status: "error", ... } on malformed body
 *
 * There is deliberately NO signing code, NO key handling, and NO private
 * keys anywhere in this codebase. The stub returns "stubbed"
 * unconditionally; execution will be wired in a later phase with its own
 * approval flow.
 */
export async function POST(req: Request) {
  const role = cookies().get("tyck_role")?.value;
  if (role !== "dip") {
    return Response.json(
      { status: "denied", message: "Trade intents are restricted to the dip role." },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.mint !== "string" || body.mint.length === 0) {
    return Response.json(
      { status: "error", message: "mint is required." },
      { status: 400 }
    );
  }

  const sizeUsd =
    typeof body.size_usd === "number" && Number.isFinite(body.size_usd)
      ? body.size_usd
      : 100;

  return Response.json({
    status: "stubbed",
    message: "Execution not wired — paper week. No funds moved.",
    received: {
      mint: body.mint,
      tier: typeof body.tier === "string" ? body.tier : null,
      size_usd: sizeUsd,
    },
  });
}
