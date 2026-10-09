#!/usr/bin/env node
/**
 * Nines Stream Ingestor
 *
 * Holds a persistent Helius WebSocket connection, subscribes to Solana
 * program activity (pump.fun launches, DEX trades), normalizes the data,
 * and pushes it to the Vercel ingest endpoint in real time.
 *
 * Env vars (required):
 *   HELIUS_API_KEY       Helius API key
 *   NINES_INGEST_URL     Vercel ingest endpoint (https://.../api/stream-ingest)
 *   NINES_INGEST_TOKEN   Auth token for the ingest endpoint
 *
 * Run: node ingestor.js
 * Designed to run under systemd with auto-restart.
 */

const WebSocket = require("ws");

// ---------------------------------------------------------------- config

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_URL = process.env.NINES_INGEST_URL;
const INGEST_TOKEN = process.env.NINES_INGEST_TOKEN;

if (!HELIUS_API_KEY || !INGEST_URL || !INGEST_TOKEN) {
  console.error("Missing required env: HELIUS_API_KEY, NINES_INGEST_URL, NINES_INGEST_TOKEN");
  process.exit(1);
}

const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Programs we care about
const PROGRAMS = {
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmnGxutwvhRVv",
  RAYDIUM_AMM: "675kPX9MHTjS2zt1bum3w2X2i2n8i2m7v1k2m5s4v",
};

// ---------------------------------------------------------------- state

let ws = null;
let reconnectDelay = 1000;
let msgId = 1;
let lastHeartbeat = Date.now();
let stats = { received: 0, pushed: 0, errors: 0, startTime: Date.now() };

// ---------------------------------------------------------------- ingest

async function pushToVercel(payload) {
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Ingest failed: ${res.status}`);
      stats.errors++;
      return false;
    }
    stats.pushed++;
    return true;
  } catch (err) {
    console.error("Ingest error:", err.message);
    stats.errors++;
    return false;
  }
}

// ---------------------------------------------------------------- parsing

function parseTransaction(tx) {
  // Helius enhanced transaction format
  // Extract: type (buy/sell/launch), token mint, amount, wallet, timestamp
  try {
    const sig = tx.signature;
    const ts = tx.timestamp ? tx.timestamp * 1000 : Date.now();
    const type = tx.type || "UNKNOWN";

    // Token transfers tell us what moved
    const transfers = tx.tokenTransfers || [];
    if (transfers.length === 0) return null;

    // For swaps: find the non-SOL/wSOL token
    const WSOL = "So11111111111111111111111111111111111111112";
    const tokenTx = transfers.find((t) => t.mint !== WSOL) || transfers[0];

    return {
      signature: sig,
      timestamp: ts,
      type: normalizeType(type),
      mint: tokenTx.mint,
      amount: tokenTx.tokenAmount,
      wallet: tx.feePayer || null,
      program: tx.instructions?.[0]?.programId || null,
    };
  } catch {
    return null;
  }
}

function normalizeType(heliusType) {
  const t = (heliusType || "").toUpperCase();
  if (t.includes("SWAP")) return "trade";
  if (t.includes("MINT") || t.includes("CREATE")) return "launch";
  return "activity";
}

// ---------------------------------------------------------------- websocket

function connect() {
  console.log("Connecting to Helius WebSocket...");
  ws = new WebSocket(HELIUS_WS);

  ws.on("open", () => {
    console.log("Helius WebSocket connected");
    reconnectDelay = 1000;
    lastHeartbeat = Date.now();

    // Subscribe to program notifications
    for (const [name, programId] of Object.entries(PROGRAMS)) {
      const sub = {
        jsonrpc: "2.0",
        id: msgId++,
        method: "programSubscribe",
        params: [
          programId,
          { encoding: "jsonParsed", commitment: "confirmed" },
        ],
      };
      ws.send(JSON.stringify(sub));
      console.log(`Subscribed to ${name} (${programId.slice(0, 8)}...)`);
    }
  });

  ws.on("message", async (data) => {
    lastHeartbeat = Date.now();
    stats.received++;

    try {
      const msg = JSON.parse(data.toString());

      // Skip subscription confirmations
      if (msg.result !== undefined && !msg.params) return;

      const tx = msg.params?.result?.value;
      if (!tx) return;

      const parsed = parseTransaction(tx);
      if (!parsed) return;

      // Batch: push every event for now, optimize later if needed
      await pushToVercel({ events: [parsed] });
    } catch (err) {
      // Don't crash on bad messages
      stats.errors++;
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket closed, reconnecting in ${reconnectDelay}ms...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

// ---------------------------------------------------------------- health

// Log stats every minute
setInterval(() => {
  const uptimeMin = Math.round((Date.now() - stats.startTime) / 60000);
  const sinceHeartbeat = Math.round((Date.now() - lastHeartbeat) / 1000);
  console.log(
    `[health] uptime=${uptimeMin}m received=${stats.received} pushed=${stats.pushed} errors=${stats.errors} last_msg=${sinceHeartbeat}s ago`
  );

  // If no messages in 60s, force reconnect (stale connection)
  if (sinceHeartbeat > 60 && ws && ws.readyState === WebSocket.OPEN) {
    console.log("Stale connection detected, reconnecting...");
    ws.close();
  }
}, 60000);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  if (ws) ws.close();
  process.exit(0);
});

// ---------------------------------------------------------------- start

console.log("Nines Stream Ingestor starting...");
console.log(`Ingest target: ${INGEST_URL.replace(/\/\/.*@/, "//***@")}`);
connect();
