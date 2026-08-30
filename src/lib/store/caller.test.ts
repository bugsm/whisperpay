/**
 * What may and may not reach the rate-limit store.
 *
 * The scan endpoint is the one place in this app that records anything about
 * who is asking, so it is the one place where "we don't keep that" has to be
 * held by a test rather than by a sentence in the privacy page. Two properties
 * matter, and they pull against each other: the counter has to recognise the
 * same caller inside a window, and must not recognise them outside it.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { storedCaller } from "@/lib/store/caller";

/** A window start, as `rateLimit` computes it: a unix second on a boundary. */
const WINDOW = 1_756_000_800;
const NEXT_WINDOW = WINDOW + 600;

describe("what the rate-limit store is told about a caller", () => {
  it("never contains the address it came from", () => {
    for (const address of [
      "203.0.113.42",
      "2001:db8::8a2e:370:7334",
      "unknown",
    ]) {
      const stored = storedCaller(address, WINDOW);
      assert.equal(
        stored.includes(address),
        false,
        `${address} reached the store`
      );
      assert.match(stored, /^[0-9a-f]{32}$/, "not a plain digest");
    }
  });

  it("still recognises the same caller inside one window", () => {
    // Without this the limit counts every request separately and stops being a
    // limit at all — the property the privacy change must not have cost.
    assert.equal(
      storedCaller("203.0.113.42", WINDOW),
      storedCaller("203.0.113.42", WINDOW)
    );
  });

  it("tells two callers apart inside one window", () => {
    assert.notEqual(
      storedCaller("203.0.113.42", WINDOW),
      storedCaller("203.0.113.43", WINDOW)
    );
  });

  it("stops recognising them in the next window", () => {
    // The point of folding the window in. A digest of the address alone would
    // be one stable identifier per person, and two dumps taken a day apart
    // would link that person's scans across days.
    assert.notEqual(
      storedCaller("203.0.113.42", WINDOW),
      storedCaller("203.0.113.42", NEXT_WINDOW)
    );
  });
});

describe("the salt", () => {
  it("changes what is stored", () => {
    // An unsalted digest of an IPv4 is reversible by enumerating 2^32, so the
    // salt is the whole defence. If it stopped reaching the digest, everything
    // above would still pass and nothing would be private.
    const before = process.env.RATELIMIT_SALT;
    try {
      process.env.RATELIMIT_SALT = "one";
      const one = storedCaller("203.0.113.42", WINDOW);
      process.env.RATELIMIT_SALT = "another";
      const another = storedCaller("203.0.113.42", WINDOW);
      assert.notEqual(one, another);
    } finally {
      if (before === undefined) delete process.env.RATELIMIT_SALT;
      else process.env.RATELIMIT_SALT = before;
    }
  });
});
