import { walletLoginEnabled } from "@/lib/wallet-auth";

/**
 * Public config for the login page: whether wallet login is available and
 * whether the WalletConnect pairing path is configured.
 */
export async function GET() {
  return Response.json({
    enabled: walletLoginEnabled(),
    walletConnect: Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID),
  });
}
