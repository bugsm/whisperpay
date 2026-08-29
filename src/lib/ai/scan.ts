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
 * Haiku 4.5, chosen deliberately and with the trade named. This is the one
 * place in the app where a misread digit becomes a real payment request sent
 * to a real person, and the stronger model reads a creased thermal receipt
 * more reliably. What buys the downgrade is volume: at roughly a fifth of
 * Opus's price per scan, a table splitting a bill every week costs cents a
 * month instead of dollars.
 *
 * `claude-opus-5` is the lever back, and the reason to pull it is accuracy
 * complaints — lines misread, totals off by a factor of ten — not cost.
 *
 * Set here rather than in an env file on purpose: a model chosen in
 * `.env.local` alone is a model every deployment except this laptop ignores,
 * and the bill for that shows up in production.
 *
 * `ANTHROPIC_MODEL` still overrides it, because a deployment pointed at a
 * gateway (below) reaches models under whatever names that gateway gives them.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

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
  let base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return undefined;
  while (base.endsWith("/")) base = base.slice(0, -1);

  // A trailing `/v1` is dropped, because the SDK adds one. It appends
  // `/v1/messages` to whatever this returns, so a gateway documented — as most
  // are, by the OpenAI-compatible convention everyone copies — as
  // `https://host/v1` is pasted in verbatim and every request then goes to
  // `/v1/v1/messages`. That answers 404, which reads as a wrong endpoint rather
  // than a doubled path, while the URL in the dashboard is the one the gateway
  // documents and correct everywhere else.
  //
  // Safe to strip: the messages endpoint lives under `/v1` by definition, so a
  // base already ending in one is naming the same place twice. A gateway
  // mounted under a prefix keeps that prefix — only the final `/v1` goes.
  if (base.endsWith("/v1")) base = base.slice(0, -3);

  return base || undefined;
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
          shares: {
            type: "array",
            description:
              "Who had this line, from the diners note. Omit when no note was given or nobody was named for this line.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The person's name, spelled as the note spells it.",
                },
                quantity: {
                  type: "integer",
                  description:
                    "How many of this line were theirs. 1 unless the note says otherwise.",
                },
              },
              required: ["name", "quantity"],
              additionalProperties: false,
            },
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
- Identify the currency from the receipt itself — the symbol, the language, the country, the tax wording — and report it as an ISO 4217 code. If nothing on it settles the question, pick the most likely from the language and say that code rather than defaulting to USD.
- Every amount is an integer in the currency's smallest unit, digits only: no separators, no decimal point, no currency symbol.
- How many digits the smallest unit adds depends on the currency, and getting this wrong changes every amount by a factor of a hundred:
  - IDR, JPY, KRW, VND and CLP have no minor unit. The printed number is already the answer: "Rp 12.000" is "12000", "¥1,200" is "1200".
  - BHD and KWD have three: "BD 12.500" is "12500".
  - Every other currency has two: "$12.50" is "1250", "€8" is "800", "S$14.90" is "1490".
- Read the separators the way the receipt's own country writes them, not the way English does. "." is a thousands separator across Indonesia, Germany, Italy, Brazil and much of Europe, where "," is the decimal point. On an Indonesian receipt "12.500" is twelve thousand five hundred, not twelve and a half; on a German one "12,50" is twelve fifty. Decide from the currency and the language, and note that a number with exactly two digits after the final separator is usually a decimal in a two-decimal currency and a thousands group in a zero-decimal one.
- An item's amount is the line total for the whole quantity, as printed on that line. If only a unit price is shown, multiply it by the quantity.
- Omit tax, service, discount or total entirely when the receipt does not show them. Never invent a zero.
- If a line is genuinely unreadable, leave it out rather than guessing at its price. A missing line is obvious to the person checking; a wrong price is not.

When the user's message includes a note saying who had what, also fill in "shares" on each line:

- The note is written the way people actually talk: "udin - ayam, es teh; adi - ayam 1, es teh 2", or with newlines, or with "dan"/"and" between dishes. Names come first, dishes after a dash or a colon.
- Match a dish in the note to a line on the receipt by meaning, not by string equality. "ayam" is the receipt's "Ayam Goreng Kremes"; "es teh" is "Es Teh Manis". A note is written from memory and a receipt from a till.
- A bare number next to a dish is how many of it were theirs: "adi - ayam 1, es teh 2" is quantity 1 and quantity 2. No number means 1.
- When several people are named for one line, list each of them with their own quantity. Their quantities do not need to add up to the line's quantity — the split is worked out elsewhere, and a note that disagrees with the receipt is the person's business, not yours to correct.
- Leave "shares" off any line the note doesn't mention. Do not spread it across everyone as a guess: an unassigned line is shown to the organiser to resolve, and a wrong guess is not.
- Use the note's spelling of each name, and use one spelling per person throughout.
- If no note was given, omit "shares" everywhere.`;

export interface ScanInput {
  /** base64, with no `data:` prefix. */
  data: string;
  mediaType: NotaMediaType;
  /**
   * Who had what, in the organiser's own words — "udin - ayam, es teh; adi -
   * ayam 1, es teh 2". Optional: without it the lines come back unassigned and
   * the organiser taps the names instead.
   */
  diners?: string;
}

/** Long enough for a table of twenty, short enough not to be a prompt. */
export const MAX_DINERS_LENGTH = 2000;

/**
 * The JSON out of an answer that may have been dressed up as markdown.
 *
 * Only reachable on the schema-less fallback path: with `output_config` the
 * API returns bare JSON, and asking in words gets a ```json fence often enough
 * to be worth handling rather than failing on. Untouched when there is no
 * fence, so the enforced path costs nothing.
 *
 * Strips the fence only. Everything about the contents is still decided by
 * `parseNota`.
 */
function unfence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : text;
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

/**
 * The credential, and which header it travels in.
 *
 * Two conventions meet here. Anthropic authenticates with `x-api-key`, which is
 * what the SDK sends for `apiKey`. A gateway standing in for it usually wants
 * the bearer convention instead, and the SDK sends `Authorization: Bearer` for
 * `authToken` — selected by `ANTHROPIC_AUTH_TOKEN`, the variable those
 * gateways' own setup instructions hand out. Sending the wrong one of the two
 * is a 401 that reads exactly like a wrong credential.
 *
 * `ANTHROPIC_AUTH_TOKEN` wins when both are set: a deployment that went to the
 * trouble of setting it means the bearer header, and the other variable is
 * usually the same string copied twice because an instruction said to.
 *
 * Trimmed, and read here rather than left to the SDK's own read of the
 * environment. A key pasted into a hosting dashboard picks up a trailing
 * newline more often than not — from a `cat`, from a copied line, from the
 * textarea itself — and that byte goes straight into the header, where the API
 * answers 401. The failure then reads as "the credential is wrong" when it is
 * right and only its whitespace is not.
 */
type Credential = { header: "bearer" | "x-api-key"; value: string; raw: string };

function credential(): Credential | undefined {
  const bearer = process.env.ANTHROPIC_AUTH_TOKEN;
  if (bearer?.trim()) {
    return { header: "bearer", value: bearer.trim(), raw: bearer };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (key?.trim()) {
    return { header: "x-api-key", value: key.trim(), raw: key };
  }

  return undefined;
}

/**
 * The sentence the upstream actually wrote.
 *
 * `error.message` is the SDK's rendering of the response, and for a body whose
 * top level carries a `message` of its own that rendering is that field — which
 * on a gateway is the machine code (`UNAUTHENTICATED`) while the sentence a
 * person can act on sits one level down in `error.error.message`, link to
 * support and all. Preferring the nested one turns a log line that says nothing
 * into the only line that says why.
 *
 * Falls back to the SDK's own text, which is what Anthropic's own errors want:
 * their body has no top-level `message` and the rendering is already the
 * sentence.
 *
 * Response body only — the SDK never echoes the request — so the photo cannot
 * appear here. Truncated regardless, because that guarantee is better held by
 * construction than by trust.
 */
function upstreamMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const nested = body?.error?.message;
  const text = typeof nested === "string" && nested ? nested : error.message;
  return text.slice(0, 500);
}

export async function scanNota(image: ScanInput): Promise<ScannedNota> {
  const auth = credential();
  if (!auth) {
    throw new NotaConfigError("Receipt scanning isn't configured on this deployment.");
  }

  const diners = image.diners?.trim().slice(0, MAX_DINERS_LENGTH);

  // Constructed inside a guard because it is the one step that can fail before
  // any request is made: a malformed ANTHROPIC_BASE_URL throws right here, and
  // outside a try it left the route with an error carrying no class at all —
  // reported to the reader as a failure "this server didn't recognise", which
  // is true and useless.
  let client: Anthropic;
  try {
    client = new Anthropic({
      ...(auth.header === "bearer"
        ? { authToken: auth.value, apiKey: null }
        : { apiKey: auth.value }),
      baseURL: endpoint(),
    });
  } catch {
    console.error("[nota] the endpoint isn't a usable URL:", host());
    throw new NotaConfigError(
      "Receipt scanning is misconfigured on this deployment — its endpoint isn't a usable address."
    );
  }

  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

  /**
   * One attempt at the request.
   *
   * `schema` is what varies, because `output_config` is the parameter a gateway
   * standing in for this API is most likely not to implement. With it, the
   * shape is enforced by the API; without it, the shape is asked for in words
   * and enforced by `parseNota` — which rebuilds the receipt field by field
   * either way. What the fallback gives up is reliability of format, not any
   * check on what comes back.
   */
  function ask(schema: boolean) {
    // The note is fenced and labelled as the diners' words. It is whatever the
    // organiser typed, so it is data the model reads about, never instructions
    // it takes from — the rules for reading it are in the system prompt, above
    // this and out of reach of anything typed into the box.
    const task = diners
      ? `Read this receipt. Return every line item with its printed total, and fill in "shares" from the note below.\n\nThe diners' note, as written:\n<note>\n${diners}\n</note>`
      : "Read this receipt. Return every line item with its printed total.";

    return client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      ...(schema
        ? {
            output_config: {
              format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA },
            },
          }
        : {}),
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
              text: schema
                ? task
                : `${task}\n\nReply with a single JSON object and nothing else — no prose, no markdown fence. It must match this JSON Schema exactly:\n${JSON.stringify(OUTPUT_SCHEMA)}`,
            },
          ],
        },
      ],
    });
  }

  let response: Anthropic.Message;
  try {
    try {
      response = await ask(true);
    } catch (error) {
      // `output_config` is the parameter a gateway is likeliest to reject, and
      // it does so as a plain 400 that tells the person holding the receipt
      // nothing. So a 400 is tried once more without it — but only where a
      // gateway is actually configured, because Anthropic implements the
      // parameter and a 400 from there means something this retry can't fix.
      if (!(error instanceof Anthropic.BadRequestError) || !endpoint()) throw error;

      console.error(
        "[nota] retrying without output_config:",
        JSON.stringify({ host: host(), model, status: error.status })
      );
      response = await ask(false);
    }
  } catch (error) {
    // The SDK's typed classes, most specific first — never the text of a
    // message, which is not a contract.
    if (error instanceof Anthropic.AuthenticationError) {
      // Whoever is reading the deployment log is the one who can fix this, and
      // "the key was refused" alone doesn't tell them which way it is wrong.
      // Shape only — never the key, and never any part of it.
      console.error(
        "[nota] the credential was refused:",
        JSON.stringify({
          // The host first: a gateway key sent to `api.anthropic.com` is the
          // likeliest way to arrive here, and it is the one thing the message
          // above cannot distinguish from a key that is simply wrong.
          host: host(),
          // Which header it went in, because sending a gateway's token as
          // `x-api-key` when it wanted bearer is its own way to arrive here.
          sentAs: auth.header,
          length: auth.value.length,
          hadSurroundingWhitespace: auth.value.length !== auth.raw.length,
          looksLikeAnAnthropicKey: auth.value.startsWith("sk-ant-api"),
          // The upstream's own sentence, because a 401 is not always about the
          // key: a gateway answers one for a refused client, an account out of
          // balance, or a plan that doesn't carry the model, and the shape
          // above tells those apart from a wrong key not at all. Response body
          // only, truncated, same as the branch below.
          message: upstreamMessage(error),
        })
      );
      throw new NotaConfigError(
        "Receipt scanning is misconfigured on this deployment — its credentials were refused."
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new NotaUpstreamError(
        "Receipt scanning is busy right now. Wait a moment and try again, or type the lines in by hand."
      );
    }
    if (error instanceof Anthropic.APIError) {
      // The catch-all of the chain, and so the one that used to say least
      // while covering most: a rejected model name, a rejected parameter, an
      // exhausted balance and an upstream outage all arrived here as the same
      // sentence with nothing written down. The status and the upstream's own
      // message are what tell those apart.
      //
      // The message is the *response* body, never the request — the SDK does
      // not echo what was sent — so the photo cannot appear in it. Truncated
      // regardless, because that guarantee is better held by construction.
      console.error(
        "[nota] the upstream refused:",
        JSON.stringify({
          host: host(),
          model,
          status: error.status,
          message: upstreamMessage(error),
        })
      );
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
    parsed = JSON.parse(unfence(text));
  } catch {
    throw new NotaOutputError("The scanner's answer wasn't readable.");
  }

  return parseNota(parsed);
}
