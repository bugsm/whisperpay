/**
 * What a stored record is allowed to contain on the way back out.
 *
 * `status-privacy.test.ts` guards the code that *writes* records. This guards
 * the code that *reads* them, which is a separate problem with a separate way
 * of going wrong: a previous build stored the payer's transaction hash, and
 * those records outlive the code that made them by up to seven days. Removing
 * the field from the type does nothing for data already in the store.
 *
 * Every case below uses the record shape that build actually wrote.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRecord } from "@/lib/store/record";

/** Exactly what the previous version persisted, hash and commitment included. */
const LEGACY = JSON.stringify({
  id: "DrKU4kQm1a2b",
  status: "confirmed",
  submittedAt: 1787165278,
  confirmedAt: 1787165278,
  txHash: "0x6f3417cba37b8f2faa352f4300f561717d80a33eeaf8bbc2e985fa6e1557ede",
  recipientCommitment:
    "d162319dcd7517b388dd1d2482e0c9582934dc4ec3fa137cb01f185fdc1f585e",
});

describe("parseRecord drops what it isn't allowed to return", () => {
  it("strips the transaction hash a previous version stored", () => {
    // The regression: a cast passed this straight through, so deploying the
    // no-stored-hash version would have served the hash to anyone holding the
    // id until the record expired.
    const record = parseRecord(LEGACY);
    assert.ok(record);
    assert.ok(!("txHash" in record));
    assert.ok(!("recipientCommitment" in record));
  });

  it("keeps the four fields that belong", () => {
    assert.deepEqual(parseRecord(LEGACY), {
      id: "DrKU4kQm1a2b",
      status: "confirmed",
      submittedAt: 1787165278,
      confirmedAt: 1787165278,
    });
  });

  it("drops anything else a store might hold, whatever its name", () => {
    const raw = JSON.stringify({
      id: "abc",
      status: "pending",
      recipient: "0x1160",
      amount: "1000",
      memo: "invoice 4",
      payer: "0x06d7",
      whateverComesNext: true,
    });
    assert.deepEqual(parseRecord(raw), { id: "abc", status: "pending" });
  });

  it("omits timestamps rather than inventing them", () => {
    const record = parseRecord(JSON.stringify({ id: "abc", status: "pending" }));
    assert.ok(record);
    assert.ok(!("submittedAt" in record));
    assert.ok(!("confirmedAt" in record));
  });

  it("ignores a timestamp that isn't a usable number", () => {
    const raw = JSON.stringify({
      id: "abc",
      status: "confirmed",
      submittedAt: "yesterday",
      confirmedAt: -1,
    });
    assert.deepEqual(parseRecord(raw), { id: "abc", status: "confirmed" });
  });
});

describe("parseRecord refuses what it can't read", () => {
  it("rejects a status outside the lifecycle", () => {
    assert.equal(parseRecord(JSON.stringify({ id: "a", status: "paid" })), null);
  });

  it("still accepts the retired submitted state, for old records", () => {
    const record = parseRecord(JSON.stringify({ id: "a", status: "submitted" }));
    assert.equal(record?.status, "submitted");
  });

  it("rejects a missing id", () => {
    assert.equal(parseRecord(JSON.stringify({ status: "pending" })), null);
  });

  it("rejects malformed JSON rather than throwing", () => {
    assert.equal(parseRecord("{not json"), null);
    assert.equal(parseRecord("null"), null);
    assert.equal(parseRecord('"a string"'), null);
  });
});
