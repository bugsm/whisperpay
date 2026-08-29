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
 *
 * `ANTHROPIC_MODEL` overrides it, because a deployment pointed at a gateway
 * (below) reaches models under whatever names that gateway gives them.
 */
const DEFAULT_MODEL = "claude-opus-5";

/**
 * Where the request goes.
 *
 * Anthropic, unless a deployment says otherwise. A key issued by an
 * Anthropic-compatible gateway is not an Anthropic key, so leaving this at the
 * default with such a key in hand produces a 401 that reads exactly like a
 * wrong key — the endpoint has to move together with the credential.
 *
 * Setting it is a privacy decision before it is a configuration one: receipt
 * photos then reach whoever operates that host, under their retention policy
 * rather than Anthropic's. `docs/PRIVACY.md` says so to the reader, and it is
 * only true while it matches what is deployed.
 */
function endpoint(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
}

/**
 * The endpoint's hostname, for the log line below. The host and not the URL:
 * some gateways carry a token in the path, and a diagnostic that leaks the
 * credential it is diagnosing is worse than no diagnostic.
 */
function host(): string {
  const base = endpoint();
  if (!base) return "api.anthropic.com";
  try {
    return new URL(base).host;
  } catch {
    return "unparseable ANTHROPIC_BASE_URL";
  }
}

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

/**
 * The model's answer as text, whatever envelope it arrived in.
 *
 * `content` is a list of blocks in the API's contract, and that is the only
 * shape this reads deliberately. But a gateway standing in for that API is only
 * obliged to return HTTP 200, and some flatten the list to a plain string on
 * the way through — cheap to accept, and safe, because whatever comes out still
 * has to survive `JSON.parse` and then `parseNota`, which rebuilds the receipt
 * field by field and trusts none of it.
 *
 * Anything else is refused rather than guessed at, and the keys are logged: an
 * envelope this doesn't know is a fact about the deployment's endpoint, and the
 * operator can't act on it without being told what actually came back. Keys
 * only — the values are the model's answer, and one of the receipt's lines has
 * no business in a log.
 *
 * Returns `undefined` for an envelope it can't read, `""` for one that carried
 * no text. The two are different failures and get different sentences.
 */
function readText(response: Anthropic.Message): string | undefined {
  if (Array.isArray(response.content)) {
    return response.content.find((block) => block.type === "text")?.text ?? "";
  }

  if (typeof response.content === "string") return response.content;

  console.error(
    "[nota] unrecognised response envelope:",
    JSON.stringify({
      host: host(),
      contentType: typeof response.content,
      keys:
        response && typeof response === "object" ? Object.keys(response) : null,
    })
  );
  return undefined;
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

  // Constructed inside a guard because it is the one step that can fail before
  // any request is made: a malformed ANTHROPIC_BASE_URL throws right here, and
  // outside a try it left the route with an error carrying no class at all —
  // reported to the reader as a failure "this server didn't recognise", which
  // is true and useless.
  let client: Anthropic;
  try {
    client = new Anthropic({ apiKey, baseURL: endpoint() });
  } catch {
    console.error("[nota] the endpoint isn't a usable URL:", host());
    throw new NotaConfigError(
      "Receipt scanning is misconfigured on this deployment — its endpoint isn't a usable address."
    );
  }

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
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
          // The host first: a gateway key sent to `api.anthropic.com` is the
          // likeliest way to arrive here, and it is the one thing the message
          // above cannot distinguish from a key that is simply wrong.
          host: host(),
          length: apiKey.length,
          hadSurroundingWhitespace:
            apiKey.length !== (process.env.ANTHROPIC_API_KEY?.length ?? 0),
          looksLikeAnAnthropicKey: apiKey.startsWith("sk-ant-api"),
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

  const text = readText(response);
  if (text === undefined) {
    throw new NotaOutputError(
      "The scanner answered in a shape this app doesn't understand."
    );
  }
  if (text === "") {
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
