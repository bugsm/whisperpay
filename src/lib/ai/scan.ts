import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  NotaConfigError,
  NotaOutputError,
  NotaUpstreamError,
  parseNota,
  type NotaMediaType,
  type ScannedNota,
} from "./nota";

/**
 * Sending one receipt photo to the model.
 *
 * **The image is never written down.** It arrives in a request body, is handed
 * to the API, and is gone when the request ends. It is not saved to disk, not
 * put in the status store or the bill store, not logged, and never included in
 * an error thrown from here. A photo of a receipt carries a place, a time, and
 * often the last four digits of a card — none of which this app has any
 * business keeping, and the cheapest way to guarantee it isn't kept is to give
 * it nowhere to go.
 *
 * Every failure leaves as a typed error from the chain in `./nota`, so callers
 * branch on the class rather than on the text of a message. The route above
 * turns each class into its own status code and its own sentence.
 */

/**
 * The model this runs on.
 *
 * The strong model, deliberately. This is the one place in the app where a
 * misread digit becomes a real payment request sent to a real person, so
 * accuracy is worth more than the per-scan cost. `claude-haiku-4-5` is the
 * lever if volume ever makes that trade wrong — a decision to take consciously
 * then, not a quiet default now.
 */
const MODEL = "claude-opus-5";

/**
 * Enough room for a long receipt and the thinking that reads it. Comfortably
 * inside the SDK's HTTP timeout, so this doesn't need streaming.
 */
const MAX_TOKENS = 16000;

/**
 * The shape the model must answer in.
 *
 * Amounts are typed as strings on purpose. A JSON number for `12000` is
 * harmless; one for a larger rupiah figure is a float, and a float in a money
 * path is the failure this codebase is built to avoid. What each string has to
 * look like is checked in `parseNota` rather than declared here, so the check
 * sits next to the error message a reader actually sees.
 */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    currency: {
      type: "string",
      description: "ISO 4217 code of the amounts on the receipt, e.g. IDR.",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The item as written." },
          quantity: { type: "integer", description: "How many. 1 if not shown." },
          amount: {
            type: "string",
            description:
              "Line total for all of them, in the currency's smallest unit, digits only.",
          },
        },
        required: ["name", "quantity", "amount"],
        additionalProperties: false,
      },
    },
    tax: { type: "string", description: "Tax line, smallest unit, digits only." },
    service: {
      type: "string",
      description: "Service charge, smallest unit, digits only.",
    },
    discount: {
      type: "string",
      description: "Discount as a positive number, smallest unit, digits only.",
    },
    total: {
      type: "string",
      description: "Printed grand total, smallest unit, digits only.",
    },
  },
  required: ["currency", "items"],
  additionalProperties: false,
} as const;

const SYSTEM = `You read photographs of restaurant and shop receipts and return what is printed on them.

Rules that matter more than anything else:

- Report what the receipt says. Do not compute, correct, or reconcile. If the printed total disagrees with the lines, report both as printed — the discrepancy is shown to a person who can see the receipt.
- Every amount is an integer in the currency's smallest unit, digits only: no separators, no decimal point, no currency symbol. For Indonesian rupiah the smallest unit is the rupiah, so "Rp 12.000" is "12000" and "Rp 1.234.567" is "1234567".
- Indonesian receipts use "." as a thousands separator and "," as a decimal separator. "12.500" is twelve thousand five hundred, not twelve and a half.
- An item's amount is the line total for the whole quantity, as printed on that line. If only a unit price is shown, multiply it by the quantity.
- Omit tax, service, discount or total entirely when the receipt does not show them. Never invent a zero.
- If a line is genuinely unreadable, leave it out rather than guessing at its price. A missing line is obvious to the person checking; a wrong price is not.`;

export interface ScanInput {
  /** base64, with no `data:` prefix. */
  data: string;
  mediaType: NotaMediaType;
}

export async function scanNota(image: ScanInput): Promise<ScannedNota> {
  // Trimmed, and passed explicitly rather than left to the SDK's own read of
  // the environment. A key pasted into a hosting dashboard picks up a trailing
  // newline more often than not — from a `cat`, from a copied line, from the
  // textarea itself — and that byte goes straight into the `x-api-key` header,
  // where the API answers 401. The failure then reads as "the key is wrong"
  // when the key is right and only its whitespace is not.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new NotaConfigError("Receipt scanning isn't configured on this deployment.");
  }

  const client = new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType,
                data: image.data,
              },
            },
            {
              type: "text",
              text: "Read this receipt. Return every line item with its printed total.",
            },
          ],
        },
      ],
    });
  } catch (error) {
    // The SDK's typed classes, most specific first — never the text of a
    // message, which is not a contract.
    if (error instanceof Anthropic.AuthenticationError) {
      // Whoever is reading the deployment log is the one who can fix this, and
      // "the key was refused" alone doesn't tell them which way it is wrong.
      // Shape only — never the key, and never any part of it.
      console.error(
        "[nota] the API key was refused:",
        JSON.stringify({
          length: apiKey.length,
          hadSurroundingWhitespace:
            apiKey.length !== (process.env.ANTHROPIC_API_KEY?.length ?? 0),
          looksLikeAnApiKey: apiKey.startsWith("sk-ant-api"),
        })
      );
      throw new NotaConfigError(
        "Receipt scanning is misconfigured on this deployment — its API key was refused."
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new NotaUpstreamError(
        "Receipt scanning is busy right now. Wait a moment and try again, or type the lines in by hand."
      );
    }
    if (error instanceof Anthropic.APIError) {
      throw new NotaUpstreamError(
        "Receipt scanning is unavailable right now. You can still type the lines in by hand."
      );
    }
    throw new NotaUpstreamError("Couldn't reach the receipt scanner.");
  }

  // Checked before `content` is read: on a refusal the content is not an answer.
  if (response.stop_reason === "refusal") {
    throw new NotaOutputError(
      "The scanner declined to read that image. If it's a receipt, try a clearer photo."
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new NotaOutputError(
      "That receipt was too long to read in one go. Split it, or type the lines in by hand."
    );
  }

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new NotaOutputError("The scanner returned nothing to read.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NotaOutputError("The scanner's answer wasn't readable.");
  }

  return parseNota(parsed);
}
