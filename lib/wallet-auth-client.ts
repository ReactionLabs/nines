/* Client-safe copy of the wallet login message format.
 * Must stay byte-identical to buildLoginMessage in lib/wallet-auth.ts.
 */
export function buildLoginMessage(address: string, timestamp: string): string {
  return `The Nines login\nAddress: ${address}\nTimestamp: ${timestamp}`;
}
