/* Edge-safe crypto helpers (Web Crypto only, no node:crypto). */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(secret, data) as lowercase hex. */
export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toHex(sig);
}

/** SHA-256(data) as lowercase hex. */
export async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return toHex(d);
}

/** Constant-time equality for hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Expected tyck_sig value for a role. Throws if ROLE_SECRET is unset. */
export async function roleSignature(role: string): Promise<string> {
  const secret = process.env.ROLE_SECRET;
  if (!secret) throw new Error("ROLE_SECRET is not set");
  return hmacHex(secret, role);
}

export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function sessionCookie(name: string, value: string, secure: boolean): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Attach the tyck_role + tyck_sig session cookies to a JSON response.
 * Wallet login grants the terminal session.
 */
export async function setSessionCookies(
  res: Response,
  role: string
): Promise<Response> {
  const sig = await roleSignature(role);
  // Secure only on HTTPS (production); on local dev without TLS the
  // browser would refuse to send a Secure cookie back.
  const secure = process.env.NODE_ENV === "production";
  res.headers.append("Set-Cookie", sessionCookie("tyck_role", role, secure));
  res.headers.append("Set-Cookie", sessionCookie("tyck_sig", sig, secure));
  return res;
}
