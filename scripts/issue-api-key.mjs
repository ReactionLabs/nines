#!/usr/bin/env node
/**
 * Issue a v1 bot API key for Lamport Terminal.
 *
 * CLI-first: bots are onboarded from the terminal.
 *
 * Usage: node scripts/issue-api-key.mjs [label]
 *
 * Prints the plaintext key ONCE (give it to the bot operator securely) and
 * the SHA-256 hash to append to BOT_API_KEY_HASHES on Vercel
 * (comma-separated, no spaces). Plaintext keys are never stored anywhere.
 */
import { randomBytes, createHash } from "node:crypto";

const label = process.argv[2] ?? "bot";
const key = `lt_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");

console.log(`API key for "${label}" (show ONCE — store it securely):`);
console.log();
console.log(key);
console.log();
console.log("Append this hash to BOT_API_KEY_HASHES on Vercel:");
console.log(hash);
