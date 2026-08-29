/**
 * One bill, two pages, one badge.
 *
 * `/bill/<payload>` reads the store on the server and gets `null` for a line
 * nothing was ever written for. `/b/<id>` reads `/api/status`, which fills a
 * missing record in as `pending` before it answers. Left to derive the badge
 * themselves the two disagreed: an expired bill showed "Expired" on one page
 * and "Unpaid" on the other, under a notice saying the links had expired.
 *
 * That is the regression these cases exist for — both shapes of "nothing
 * recorded" have to come out the same.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rowStatus } from "@/lib/bill/status";

describe("rowStatus", () => {
  it("reads both spellings of 'nothing recorded' the same way", () => {
    assert.equal(rowStatus(null, false), rowStatus("pending", false));
    assert.equal(rowStatus(undefined, false), rowStatus("pending", false));
    assert.equal(rowStatus(null, true), rowStatus("pending", true));
    assert.equal(rowStatus(undefined, true), rowStatus("pending", true));
  });

  it("shows an unpaid line on a live bill as unpaid", () => {
    assert.equal(rowStatus(null, false), "pending");
  });

  it("shows an unpaid line on an expired bill as expired", () => {
    // The payer opening that link is told it's no longer payable, so the
    // organiser's page must not still be calling it merely unpaid.
    assert.equal(rowStatus(null, true), "expired");
    assert.equal(rowStatus("pending", true), "expired");
  });

  it("keeps a payment that landed before the deadline", () => {
    // Expiry is about whether a link can still be paid, not about unwinding
    // what was already received.
    assert.equal(rowStatus("confirmed", true), "confirmed");
    assert.equal(rowStatus("confirmed", false), "confirmed");
  });

  it("passes through the states it has no opinion about", () => {
    assert.equal(rowStatus("submitted", false), "submitted");
    assert.equal(rowStatus("submitted", true), "submitted");
    assert.equal(rowStatus("expired", false), "expired");
  });
});
