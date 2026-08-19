/**
 * Classifying wallet failures the payer can actually act on.
 *
 * The cases that matter are the ones a wallet reports without a STRK20 error
 * code, where the message text is all there is to go on.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeStrk20Error } from "@/lib/strk20/errors";

const RECIPIENT =
  "0x11602e87f4db482a7930163b38b8fc070eb6c3bccbb68ff78821beab4c1be41";

describe("describeStrk20Error", () => {
  it("reads a missing channel as the recipient not being registered", () => {
    const failure = describeStrk20Error(
      new Error(`Missing channel context for recipient ${RECIPIENT}`)
    );

    assert.equal(failure.kind, "recipient-not-registered");
    assert.equal(failure.benign, false);
    // The payer needs to know *which* address is the problem.
    assert.match(failure.detail, /0x1160…be41/);
  });

  it("still classifies a missing channel with no address in it", () => {
    const failure = describeStrk20Error({ message: "missing channel context" });
    assert.equal(failure.kind, "recipient-not-registered");
    assert.doesNotMatch(failure.detail, /\(\)/);
  });

  it("keeps NOT_REGISTERED about the payer, not the recipient", () => {
    const failure = describeStrk20Error({ code: 118, message: "NOT_REGISTERED" });
    assert.equal(failure.kind, "not-registered");
  });

  it("doesn't claim a registration problem from an unrelated failure", () => {
    const failure = describeStrk20Error(new Error("RPC channel closed"));
    assert.equal(failure.kind, "unknown");
  });

  it("treats a bare rejection as a cancellation", () => {
    const failure = describeStrk20Error(new Error("User rejected request"));
    assert.equal(failure.kind, "cancelled");
    assert.equal(failure.benign, true);
  });
});
