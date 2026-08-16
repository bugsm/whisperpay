#!/usr/bin/env node
/**
 * Maintain `strk20.json` — the file the sprint's judging panel reads.
 *
 * Every hash you list is checked on-chain by the panel: it must exist, have
 * succeeded, and carry a STRK20 pool event. This script runs the same check
 * first, so a hash that wouldn't count never makes it into the file.
 *
 *   node scripts/strk20-json.mjs 0xabc... 0xdef...   add and verify hashes
 *   node scripts/strk20-json.mjs --check             re-verify what's listed
 *   node scripts/strk20-json.mjs --video <url>       set demo_video
 *   node scripts/strk20-json.mjs --demo-url <url>    set demo_url
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.starknet.lava.build";
const FILE = join(process.cwd(), "strk20.json");

/** Lowercase hex with leading zeros stripped, for comparing addresses. */
const norm = (hex) => `0x${String(hex).toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0"}`;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

async function verify(txHash) {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(txHash)) {
    return { ok: false, reason: "not a valid transaction hash" };
  }
  let receipt;
  try {
    receipt = await rpc("starknet_getTransactionReceipt", { transaction_hash: txHash });
  } catch (error) {
    return { ok: false, reason: `not found on mainnet (${error.message})` };
  }
  if (receipt.execution_status === "REVERTED") {
    return { ok: false, reason: "reverted on-chain" };
  }
  const poolEvents = (receipt.events ?? []).filter(
    (event) => event.from_address && norm(event.from_address) === norm(POOL)
  ).length;
  if (poolEvents === 0) {
    return { ok: false, reason: "succeeded but emitted no STRK20 pool event" };
  }
  return {
    ok: true,
    poolEvents,
    finality: receipt.finality_status,
  };
}

function load() {
  if (!existsSync(FILE)) return { transactions: [] };
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    return { transactions: [], ...parsed };
  } catch {
    console.error("strk20.json exists but isn't valid JSON — fix it first.");
    process.exit(1);
  }
}

function save(data) {
  // Keep a stable key order so diffs stay readable.
  const ordered = {
    transactions: data.transactions,
    ...(data.contracts?.length ? { contracts: data.contracts } : {}),
    ...(data.demo_video ? { demo_video: data.demo_video } : {}),
    ...(data.demo_url ? { demo_url: data.demo_url } : {}),
  };
  writeFileSync(FILE, `${JSON.stringify(ordered, null, 2)}\n`);
}

const args = process.argv.slice(2);
const data = load();

// Flags first.
const videoIndex = args.indexOf("--video");
if (videoIndex !== -1) {
  data.demo_video = args[videoIndex + 1];
  args.splice(videoIndex, 2);
}
const demoIndex = args.indexOf("--demo-url");
if (demoIndex !== -1) {
  data.demo_url = args[demoIndex + 1];
  args.splice(demoIndex, 2);
}

const checkOnly = args.includes("--check");
const hashes = checkOnly ? data.transactions : args.filter((a) => !a.startsWith("--"));

console.log(`Pool  ${POOL}`);
console.log(`RPC   ${RPC}\n`);

const verified = [];
for (const hash of hashes) {
  process.stdout.write(`${hash.slice(0, 12)}…${hash.slice(-6)}  `);
  const result = await verify(hash);
  if (result.ok) {
    console.log(`OK — ${result.poolEvents} pool event(s), ${result.finality}`);
    verified.push(hash);
  } else {
    console.log(`REJECTED — ${result.reason}`);
  }
}

if (!checkOnly) {
  data.transactions = [...new Set([...data.transactions, ...verified])];
}
save(data);

// Report what's still missing to be scored.
const missing = [];
if (data.transactions.length < 3) {
  missing.push(`${3 - data.transactions.length} more verified mainnet transaction(s)`);
}
if (!data.demo_video) missing.push("demo_video (≤3 min)");

console.log(`\nstrk20.json — ${data.transactions.length} transaction(s) listed.`);
if (missing.length > 0) {
  console.log(`Still needed to be scored: ${missing.join(", ")}.`);
} else {
  console.log("Ready to be scored.");
}
