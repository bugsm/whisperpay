/**
 * The reserve-then-count pair sent to Upstash's `/pipeline` endpoint.
 *
 * This is the half of `./ratelimit` worth pinning down directly — `ratelimit`
 * itself is `server-only` and reaches a real store, but the command shape, the
 * ordering, and the reply-reading are plain functions, and a refactor that
 * silently reordered `SET` and `INCR` or misread the reply array would
 * reintroduce the exact "digest with no deadline" bug this pair exists to
 * prevent, with `npm test` none the wiser unless something here catches it.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readReserveAndCountReply,
  reserveAndCountCommands,
} from "@/lib/store/pipeline";

describe("the commands sent to /pipeline", () => {
  it("reserves before it counts", () => {
    // The one property the whole design leans on: `INCR` must never be able to
    // create the key before a deadline is on it.
    const [first, second] = reserveAndCountCommands("k", 600);
    assert.equal(first[0], "SET");
    assert.equal(second[0], "INCR");
  });

  it("reserves with the caller's key, a zero start, and the given TTL", () => {
    const [reserve] = reserveAndCountCommands("whisperpay:rl:abc", 42);
    assert.deepEqual(reserve, [
      "SET",
      "whisperpay:rl:abc",
      "0",
      "EX",
      "42",
      "NX",
    ]);
  });

  it("counts the same key it reserved", () => {
    const [reserve, increment] = reserveAndCountCommands("whisperpay:rl:abc", 42);
    assert.equal(increment[1], reserve[1]);
  });
});

describe("reading a /pipeline reply", () => {
  it("reads the count off the second reply", () => {
    const read = readReserveAndCountReply([{ result: "OK" }, { result: 3 }]);
    assert.deepEqual(read, { ok: true, count: 3 });
  });

  it("still reads the count when the reservation was a no-op", () => {
    // `SET ... NX` answers `null` on every hit after the first in a window —
    // that is success, not failure, and must not be mistaken for one.
    const read = readReserveAndCountReply([{ result: null }, { result: 7 }]);
    assert.deepEqual(read, { ok: true, count: 7 });
  });

  it("rejects a reply that isn't the two answers this expects", () => {
    for (const bad of [null, undefined, [], [{ result: 1 }], "nope", 5]) {
      const read = readReserveAndCountReply(bad);
      assert.equal(read.ok, false, `${JSON.stringify(bad)} was accepted`);
    }
  });

  it("rejects a reservation that came back an error", () => {
    const read = readReserveAndCountReply([
      { error: "ERR unknown command" },
      { result: 1 },
    ]);
    assert.deepEqual(read, { ok: false, reason: "ERR unknown command" });
  });

  it("rejects a count that came back an error", () => {
    const read = readReserveAndCountReply([
      { result: "OK" },
      { error: "ERR wrong type" },
    ]);
    assert.deepEqual(read, { ok: false, reason: "ERR wrong type" });
  });

  it("rejects a count that isn't a number", () => {
    const read = readReserveAndCountReply([{ result: "OK" }, { result: "1" }]);
    assert.equal(read.ok, false);
  });
});
