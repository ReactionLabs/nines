/* Wallet-based login: allowlist parsing, login-message format, and
 * ed25519 signature verification. Server-side only.
 *
 * Login message format (v1):
 *   The Nines login
 *   Address: <base58 address>
 *   Timestamp: <ISO 8601 UTC>
 *
 * The server checks:
 *  1. the message parses and the address line matches the claimed address,
 *  2. the timestamp is within LOGIN_MESSAGE_TTL_MS of now (replay window),
 *  3. the ed25519 signature verifies against the address as public key,
 *  4. the address is present in WALLET_ALLOWLIST with a valid role.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";

export const LOGIN_MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type WalletRole = "dip" | "johnny";

export function buildLoginMessage(address: string, timestamp: string): string {
  return `The Nines login\nAddress: ${address}\nTimestamp: ${timestamp}`;
}

/**
 * Parse WALLET_ALLOWLIST of the form:
 *   "addr1:dip,addr2:johnny"
 * Returns a map of address -> role. Malformed entries are ignored.
 */
export function parseAllowlist(raw: string | undefined): Map<string, WalletRole> {
  const out = new Map<string, WalletRole>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 2) continue;
    const [address, role] = [parts[0].trim(), parts[1].trim()];
    if (!address || (role !== "dip" && role !== "johnny")) continue;
    // Basic base58 sanity: 32-44 chars, no 0OIl.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) continue;
    out.set(address, role);
  }
  return out;
}

export function walletLoginEnabled(): boolean {
  return parseAllowlist(process.env.WALLET_ALLOWLIST).size > 0;
}

interface ParsedMessage {
  address: string;
  timestampMs: number;
}

function parseLoginMessage(message: string): ParsedMessage | null {
  const lines = message.split("\n");
  if (lines.length !== 3) return null;
  if (lines[0] !== "The Nines login") return null;
  const addrMatch = /^Address: ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(lines[1].trim());
  const tsMatch = /^Timestamp: (.+)$/.exec(lines[2].trim());
  if (!addrMatch || !tsMatch) return null;
  const timestampMs = Date.parse(tsMatch[1]);
  if (!Number.isFinite(timestampMs)) return null;
  return { address: addrMatch[1], timestampMs };
}

export interface WalletVerifyResult {
  ok: boolean;
  role?: WalletRole;
  address?: string;
  error?: string;
}

/**
 * Full verification of a wallet login attempt. Never throws for bad input;
 * returns { ok: false, error } instead.
 */
export function verifyWalletLogin(
  address: string,
  message: string,
  signatureB58: string
): WalletVerifyResult {
  if (typeof address !== "string" || typeof message !== "string" || typeof signatureB58 !== "string") {
    return { ok: false, error: "Invalid request." };
  }

  const parsed = parseLoginMessage(message);
  if (!parsed) return { ok: false, error: "Malformed login message." };
  if (parsed.address !== address) {
    return { ok: false, error: "Address mismatch." };
  }

  const age = Date.now() - parsed.timestampMs;
  if (age < 0 || age > LOGIN_MESSAGE_TTL_MS) {
    return { ok: false, error: "Login message expired. Sign a fresh one." };
  }

  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(address);
    sigBytes = bs58.decode(signatureB58);
  } catch {
    return { ok: false, error: "Invalid address or signature encoding." };
  }
  if (pubkeyBytes.length !== 32 || sigBytes.length !== 64) {
    return { ok: false, error: "Invalid address or signature length." };
  }

  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    sigBytes,
    pubkeyBytes
  );
  if (!valid) return { ok: false, error: "Signature verification failed." };

  const role = parseAllowlist(process.env.WALLET_ALLOWLIST).get(address);
  if (!role) return { ok: false, error: "Wallet not authorized." };

  return { ok: true, role, address };
}
