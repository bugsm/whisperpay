/**
 * What a scanned receipt is allowed to be.
 *
 * The model's answer is constrained by a schema, not guaranteed by one, and it
 * is describing money that becomes a payment request. So it gets the same
 * treatment as a link payload: rebuilt field by field, and refused whenever
 * anything doesn't fit. Every case below is an answer a build without these
 * checks would have shown to someone as a price.
 *
 * No network. The API call lives in `./scan`, which is `server-only`; this file
 * covers the half that decides what to believe.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAllowedMediaType,
  notaTotals,
  NotaOutputError,
  parseNota,
  type ScannedNota,
} from "@/lib/ai/nota";

/** A plausible warung receipt, in the shape the model is asked to answer in. */
const ANSWER = {
  merchant: "Warung Sate Pak Budi",
  currency: "IDR",
  items: [
    { name: "Sate Ayam", quantity: 2, amount: "50000" },
    { name: "Nasi Putih", quantity: 3, amount: "15000" },
    { name: "Es Teh Manis", quantity: 3, amount: "18000" },
  ],
  tax: "8300",
  service: "4150",
  total: "95450",
};

describe("parseNota keeps what belongs", () => {
  it("reads a well-formed receipt", () => {
    const nota = parseNota(ANSWER);

    assert.equal(nota.merchant, "Warung Sate Pak Budi");
    assert.equal(nota.currency, "IDR");
    assert.equal(nota.items.length, 3);
    assert.deepEqual(nota.items[0], {
      name: "Sate Ayam",
      quantity: 2,
      amount: "50000",
    });
    assert.equal(nota.tax, "8300");
    assert.equal(nota.service, "4150");
    assert.equal(nota.total, "95450");
    assert.equal(nota.discount, undefined);
  });

  it("normalises the currency and trims the merchant", () => {
    const nota = parseNota({ ...ANSWER, currency: "idr", merchant: "  Kopi  " });
    assert.equal(nota.currency, "IDR");
    assert.equal(nota.merchant, "Kopi");
  });

  it("drops leading zeros rather than rendering two spellings of one number", () => {
    const nota = parseNota({
      ...ANSWER,
      items: [{ name: "Teh", quantity: 1, amount: "0005000" }],
    });
    assert.equal(nota.items[0].amount, "5000");
  });

  it("omits absent optional fields instead of inventing zeros", () => {
    const nota = parseNota({
      currency: "IDR",
      items: [{ name: "Teh", quantity: 1, amount: "5000" }],
    });
    assert.equal(nota.tax, undefined);
    assert.equal(nota.service, undefined);
    assert.equal(nota.total, undefined);
    assert.equal(nota.merchant, undefined);
  });

  it("treats an empty string as absent", () => {
    const nota = parseNota({ ...ANSWER, tax: "", merchant: "   " });
    assert.equal(nota.tax, undefined);
    assert.equal(nota.merchant, undefined);
  });
});

describe("parseNota refuses what it can't use", () => {
  function rejects(name: string, answer: unknown) {
    it(name, () => {
      assert.throws(() => parseNota(answer), NotaOutputError);
    });
  }

  rejects("an answer that isn't an object", "a receipt");
  rejects("an array", [ANSWER]);
  rejects("null", null);
  rejects("no currency", { ...ANSWER, currency: undefined });
  rejects("a currency that isn't a code", { ...ANSWER, currency: "rupiah" });
  rejects("no items at all", { ...ANSWER, items: [] });
  rejects("items that aren't a list", { ...ANSWER, items: "Sate Ayam" });
  rejects(
    "more lines than a bill could carry",
    {
      ...ANSWER,
      items: Array.from({ length: 61 }, (_, i) => ({
        name: `item ${i}`,
        quantity: 1,
        amount: "1000",
      })),
    }
  );
  rejects("a line that isn't an object", { ...ANSWER, items: ["Sate Ayam"] });
  rejects("a line with no name", {
    ...ANSWER,
    items: [{ name: "  ", quantity: 1, amount: "1000" }],
  });

  // The failure this whole module exists for: an amount that isn't an exact
  // integer string. A float here is a rupiah figure that has already lost
  // precision by the time anyone could check it.
  rejects("an amount given as a number", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1, amount: 5000 }],
  });
  rejects("an amount with a separator", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1, amount: "12.000" }],
  });
  rejects("an amount with a currency symbol", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1, amount: "Rp 12000" }],
  });
  rejects("a negative amount", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1, amount: "-5000" }],
  });
  rejects("an implausible amount", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1, amount: "1".repeat(17) }],
  });
  rejects("a malformed tax line", { ...ANSWER, tax: "8.300" });
  rejects("a malformed total", { ...ANSWER, total: 95450 });

  rejects("a fractional quantity", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 1.5, amount: "5000" }],
  });
  rejects("a zero quantity", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: 0, amount: "5000" }],
  });
  rejects("a quantity given as a string", {
    ...ANSWER,
    items: [{ name: "Teh", quantity: "2", amount: "5000" }],
  });

  it("names the line it couldn't read", () => {
    // The organiser is holding the receipt — telling them which line went wrong
    // is the difference between a fixable problem and a failed scan.
    assert.throws(
      () =>
        parseNota({
          ...ANSWER,
          items: [{ name: "Sate Ayam", quantity: 1, amount: "12.000" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof NotaOutputError);
        assert.match(error.message, /Sate Ayam/);
        return true;
      }
    );
  });
});

describe("the totals are reported, never reconciled", () => {
  it("adds the lines up and compares them to what was printed", () => {
    const totals = notaTotals(parseNota(ANSWER));

    assert.equal(totals.items, 83_000n);
    assert.equal(totals.computed, 95_450n);
    assert.equal(totals.printed, 95_450n);
    assert.equal(totals.difference, 0n);
  });

  it("reports a discrepancy rather than fixing one", () => {
    // A misread line, which is the expected failure. The number stays wrong and
    // visible; nothing here quietly adjusts it to make the total work.
    const misread: ScannedNota = parseNota({ ...ANSWER, tax: "8300", total: "99999" });
    const totals = notaTotals(misread);

    assert.equal(totals.difference, 95_450n - 99_999n);
    assert.equal(totals.computed, 95_450n);
  });

  it("subtracts a discount", () => {
    const totals = notaTotals(
      parseNota({ ...ANSWER, discount: "10000", total: undefined })
    );
    assert.equal(totals.computed, 85_450n);
    assert.equal(totals.printed, undefined);
    assert.equal(totals.difference, undefined);
  });

  it("has no opinion when the receipt printed no total", () => {
    const totals = notaTotals(parseNota({ ...ANSWER, total: undefined }));
    assert.equal(totals.printed, undefined);
    assert.equal(totals.difference, undefined);
  });
});

describe("only images that are images", () => {
  it("accepts what a phone camera produces", () => {
    assert.ok(isAllowedMediaType("image/jpeg"));
    assert.ok(isAllowedMediaType("image/png"));
    assert.ok(isAllowedMediaType("image/webp"));
  });

  it("refuses everything else", () => {
    for (const type of ["application/pdf", "text/html", "image/svg+xml", "", "image"]) {
      assert.equal(isAllowedMediaType(type), false, `${type} should be refused`);
    }
  });
});

/**
 * Who had what.
 *
 * These weights become the divisor in `allocate`, so a share parsed wrong is
 * money moved from one person to another — quietly, and after the organiser has
 * already checked the amounts. The malformed cases are refused rather than
 * defaulted, because a default here is a guess about somebody's dinner.
 */
describe("parseNota reads who had what", () => {
  const withShares = {
    ...ANSWER,
    items: [
      {
        ...ANSWER.items[0],
        shares: [
          { name: "udin", quantity: 1 },
          { name: "adi", quantity: 1 },
        ],
      },
      { ...ANSWER.items[1] },
      {
        ...ANSWER.items[2],
        shares: [
          { name: "udin", quantity: 1 },
          { name: "adi", quantity: 2 },
        ],
      },
    ],
  };

  it("keeps each person's quantity as its own weight", () => {
    const nota = parseNota(withShares);

    assert.deepEqual(nota.items[0].shares, [
      { name: "udin", quantity: 1 },
      { name: "adi", quantity: 1 },
    ]);
    // Two of the three teas were adi's — the line divides two-to-one, not evenly.
    assert.deepEqual(nota.items[2].shares, [
      { name: "udin", quantity: 1 },
      { name: "adi", quantity: 2 },
    ]);
  });

  it("leaves a line the note didn't mention unassigned", () => {
    // Not spread across everyone as a guess: an unassigned line is shown to
    // the organiser, and a wrong guess is not.
    assert.equal(parseNota(withShares).items[1].shares, undefined);
  });

  it("treats no note at all as nobody assigned", () => {
    for (const item of parseNota(ANSWER).items) {
      assert.equal(item.shares, undefined);
    }
  });

  it("folds a person who was listed twice on one line", () => {
    // "adi - es teh, adi - es teh" is one person listing their order in two
    // breaths, not an ambiguity worth refusing.
    const nota = parseNota({
      ...ANSWER,
      items: [
        {
          ...ANSWER.items[0],
          shares: [
            { name: "adi", quantity: 1 },
            { name: "Adi", quantity: 2 },
          ],
        },
        ...ANSWER.items.slice(1),
      ],
    });

    assert.deepEqual(nota.items[0].shares, [{ name: "adi", quantity: 3 }]);
  });

  it("ignores a shares field that isn't a list", () => {
    const nota = parseNota({
      ...ANSWER,
      items: [{ ...ANSWER.items[0], shares: "udin and adi" }, ...ANSWER.items.slice(1)],
    });
    assert.equal(nota.items[0].shares, undefined);
  });

  it("refuses a share with no name", () => {
    for (const name of ["", "   ", 42, null]) {
      assert.throws(
        () =>
          parseNota({
            ...ANSWER,
            items: [
              { ...ANSWER.items[0], shares: [{ name, quantity: 1 }] },
              ...ANSWER.items.slice(1),
            ],
          }),
        NotaOutputError,
        `name ${JSON.stringify(name)} should be refused`
      );
    }
  });

  it("refuses a quantity that isn't a whole number of things", () => {
    for (const quantity of [0, -1, 1.5, "2", null, 1000]) {
      assert.throws(
        () =>
          parseNota({
            ...ANSWER,
            items: [
              { ...ANSWER.items[0], shares: [{ name: "udin", quantity }] },
              ...ANSWER.items.slice(1),
            ],
          }),
        NotaOutputError,
        `quantity ${JSON.stringify(quantity)} should be refused`
      );
    }
  });

  it("caps how many people one line can be split between", () => {
    const shares = Array.from({ length: 40 }, (_, i) => ({
      name: `p${i}`,
      quantity: 1,
    }));
    const nota = parseNota({
      ...ANSWER,
      items: [{ ...ANSWER.items[0], shares }, ...ANSWER.items.slice(1)],
    });

    assert.equal(nota.items[0].shares?.length, 20);
  });
});
