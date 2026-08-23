/**
 * The claim the README and docs/PRIVACY.md make about the status store.
 *
 * > The payer's transaction hash is verified when reported and then discarded
 * > rather than stored.
 *
 * That sentence is load-bearing: for a payer who shielded in order to pay, the
 * hash leads straight to a public deposit carrying their address, and a status
 * record is readable by anyone holding the id. A gated version of this — hash
 * kept, released only against the recipient's signature — was built and then
 * deliberately removed, because a store that never holds the value is a
 * stronger claim than a store that guards it.
 *
 * These are source-level assertions on purpose. The property being protected is
 * "this field does not exist anywhere in the record's lifecycle", which no
 * runtime call can demonstrate the absence of — but a grep can, and it fails
 * the build the moment someone reintroduces it.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const TYPES = read("./types.ts");
const ROUTE = read("../../app/api/status/[id]/route.ts");

/** Fields the record is allowed to carry, and the whole of it. */
const ALLOWED = ["id", "status", "submittedAt", "confirmedAt"];

/** Anything that could name a party, an amount, or a transaction. */
const FORBIDDEN = [
  "txHash",
  "transactionHash",
  "recipientCommitment",
  "recipient",
  "payer",
  "sender",
  "address",
  "amount",
  "token",
  "memo",
];

function statusRecordBody(): string {
  const match = /export interface StatusRecord \{([\s\S]*?)\n\}/.exec(TYPES);
  assert.ok(match, "StatusRecord interface not found — did it move?");
  return match[1];
}

describe("StatusRecord carries nothing worth stealing", () => {
  it("declares only the four permitted fields", () => {
    const body = statusRecordBody();
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    assert.deepEqual(fields, ALLOWED);
  });

  it("declares no field that could identify a party or a payment", () => {
    const body = statusRecordBody();
    for (const field of FORBIDDEN) {
      assert.ok(
        !new RegExp(`^\\s{2}${field}\\??:`, "m").test(body),
        `StatusRecord must not carry "${field}" — see docs/PRIVACY.md`
      );
    }
  });
});

describe("the status route never writes a hash into the record", () => {
  it("verifies a reported hash without persisting it", () => {
    // The hash still arrives and is still checked on-chain; what must not
    // happen is it ending up in the object handed to the store.
    assert.ok(
      ROUTE.includes("verifyPoolTransaction"),
      "the reported hash should still be verified"
    );
    assert.ok(
      !/txHash:\s/.test(ROUTE),
      "route assigns a txHash into an object — the store must never receive one"
    );
    assert.ok(
      !ROUTE.includes("record.txHash"),
      "route reads a txHash back off a record — nothing should store one"
    );
  });

  it("exposes no endpoint for releasing a stored hash", () => {
    // The reveal flow only made sense while something was stored. If it comes
    // back, so has the thing this file exists to prevent.
    assert.ok(!ROUTE.includes('"reveal"'), "reveal action is back");
    assert.ok(
      !ROUTE.includes("recipientCommitment"),
      "the commitment scheme is back"
    );
  });
});
