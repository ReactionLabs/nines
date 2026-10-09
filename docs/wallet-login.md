# Wallet-only login + self-custodial trading

Wallet auth is the ONLY login path. There is no passphrase/password login:
no password field, no `/api/login` route (it 404s), no password env vars.

## Login with wallet

1. On `/login`, branded wallet cards appear: Phantom, Solflare, Backpack,
   Jupiter, and WalletConnect (the last only when
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set). Each card shows the
   wallet's real logo (from the adapter's built-in icon) and its
   installed / detected / not-detected state. On mobile, a deep link opens
   the site inside the wallet app's browser where possible.
2. Tap a card. The wallet connects and signs a login message:
   `The Nines login / Address: <addr> / Timestamp: <utc>`
3. The server verifies the ed25519 signature, checks the address against
   `WALLET_ALLOWLIST`, and grants the tyck_role / tyck_sig session cookies.

Connecting a wallet never grants a session by itself. The signature is
mandatory, and the message expires after 5 minutes (replay protection).

## Not whitelisted

A wallet that connects and signs but is NOT in `WALLET_ALLOWLIST` gets a
clear "wallet not whitelisted" panel and NO session. The panel includes an
inline request-access form (wallet address + optional note). Submitting
appends the request to `data/access-requests.json` on main via
`/api/access-request` (GitHub Contents API, `GITHUB_TOKEN`). The box-side
watcher picks up new entries and queues a `kind="access-request"` notify
for Dip's phone push. Dip approves/denies by editing `WALLET_ALLOWLIST`.

Requesters see: "Request received. You'll be notified if approved."

## Configuration

```bash
# address:role pairs, comma-separated. Roles: dip, johnny.
WALLET_ALLOWLIST=<jupiter-address>:dip

# WalletConnect pairing (get one at https://cloud.walletconnect.com)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=

# Required for the access-request queue (server-side Contents API writes)
GITHUB_TOKEN=
```

Set `WALLET_ALLOWLIST` on Vercel (Production). It is read at request time,
so no redeploy is needed after changing it. Until it has at least one
entry, wallet login returns 503 and the login page cannot grant sessions.

Role rules: `johnny`-mapped wallets cannot hit `/api/trade/intent`, and
the middleware enforces the session everywhere.

## Self-custodial trading

After wallet login, the trade ticket uses the connected wallet:

1. **Get quote** — records the trade intent (`/api/trade/intent`, dip-only),
   prices SOL via Jupiter, and fetches an order from the Jupiter Swap API v2
   (`/api/jupiter/order` proxy).
2. **Confirm swap** — the ticket shows the exact swap (pay X SOL, receive ~Y
   tokens, router, fee). Pressing confirm asks the wallet to sign the
   Jupiter-built transaction. **Nothing executes without this explicit tap.**
3. **Execute** — the signed transaction is landed via Jupiter
   (`/api/jupiter/execute` proxy). Result links to Solscan.

Safety model:

- No private keys or seed phrases anywhere in the app, ever.
- No server-side signing. The server only proxies unsigned quotes and lands
  already-signed transactions.
- No auto-trading from the terminal. Every trade requires explicit user
  confirmation in the UI.
- Users trade their own connected wallet's funds only. Dip's bot operation is
  separate and never autonomously trades (unchanged).
- Fixed BUY side, fixed $100 size, per program rules.

## Jupiter API

Current API (NOT the deprecated v6): Swap API v2.

- `GET /api/jupiter/order?inputMint&outputMint&amount&taker` → Jupiter
  `/swap/v2/order` (keyless `lite-api.jup.ag` by default)
- `POST /api/jupiter/execute` `{ signedTransaction, requestId }` → Jupiter
  `/swap/v2/execute`
- `GET /api/jupiter/price?ids=` → Jupiter price v3 (SOL→USD conversion)

Override the base with `JUPITER_SWAP_BASE` if you move to the keyed endpoint.
