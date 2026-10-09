import { setSessionCookies } from "@/lib/auth";
import { verifyWalletLogin, walletLoginEnabled } from "@/lib/wallet-auth";

/**
 * Wallet login. The client connects a wallet, signs the login message, and
 * posts { address, message, signature }. The server verifies the ed25519
 * signature and the WALLET_ALLOWLIST, then grants the tyck_role / tyck_sig
 * session cookies. Wallet auth is the only login path.
 *
 * No private keys ever touch the server. Signing happens in the user's wallet.
 */
export async function POST(req: Request) {
  if (!walletLoginEnabled()) {
    return Response.json(
      { ok: false, error: "Wallet login is not configured." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => null);
  const result = verifyWalletLogin(
    body?.address,
    body?.message,
    body?.signature
  );

  if (!result.ok || !result.role) {
    return Response.json({ ok: false, error: result.error ?? "Denied." }, { status: 401 });
  }

  try {
    return await setSessionCookies(
      Response.json({ ok: true, role: result.role, address: result.address }),
      result.role
    );
  } catch {
    return Response.json({ ok: false, error: "Server auth not configured." }, { status: 500 });
  }
}
