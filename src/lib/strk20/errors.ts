/**
 * Turning STRK20 wallet-API failures into something a payer can act on.
 *
 * The Wallet API returns numeric error codes (see `@starknet-io/types-js`
 * wallet-api/errors). Wallets differ in how they surface them — sometimes a
 * `{ code, message }` object, sometimes an `Error` whose message merely
 * mentions the code — so `describeStrk20Error` sniffs both and always returns
 * something renderable.
 */

export type Strk20FailureKind =
  | "cancelled"
  | "not-registered"
  | "recipient-not-registered"
  | "insufficient-private-balance"
  | "privacy-leak"
  | "invalid-payload"
  | "unsupported-wallet"
  | "unknown";

export interface Strk20Failure {
  kind: Strk20FailureKind;
  /** Short line for the receipt card. */
  title: string;
  /** What the user can do about it, if anything. */
  detail: string;
  /** True when the user simply declined — not worth styling as an error. */
  benign: boolean;
  /** Original message, kept for the "technical details" disclosure. */
  raw?: string;
}

const BY_CODE: Record<number, Omit<Strk20Failure, "raw">> = {
  113: {
    kind: "cancelled",
    title: "Payment cancelled",
    detail: "You declined the transaction in your wallet. Nothing was sent.",
    benign: true,
  },
  114: {
    kind: "invalid-payload",
    title: "Wallet rejected the request",
    detail:
      "The wallet considered the action list malformed. This is a bug in Whisper Pay — please open an issue with the details below.",
    benign: false,
  },
  118: {
    kind: "not-registered",
    title: "Not registered with the privacy pool",
    detail:
      "Every pool user registers a viewing key once, on-chain, before they can send or receive private payments. Register, then try again.",
    benign: false,
  },
  119: {
    kind: "insufficient-private-balance",
    title: "Not enough shielded balance",
    detail:
      "Your private balance couldn't cover the transfer. If you meant to shield first, make sure the deposit amount covers the full payment.",
    benign: false,
  },
  120: {
    kind: "privacy-leak",
    title: "Wallet blocked this for privacy reasons",
    detail:
      "The wallet judged that submitting these actions together would leak more than you intended, and refused. Try paying from an existing shielded balance instead.",
    benign: false,
  },
  162: {
    kind: "unsupported-wallet",
    title: "Wallet doesn't support STRK20",
    detail:
      "This wallet doesn't implement the STRK20 privacy API version Whisper Pay needs. Ready supports it today.",
    benign: false,
  },
};

const BY_NAME: Record<string, number> = {
  USER_REFUSED_OP: 113,
  INVALID_REQUEST_PAYLOAD: 114,
  NOT_REGISTERED: 118,
  INSUFFICIENT_PRIVATE_BALANCE: 119,
  PRIVACY_LEAK: 120,
  API_VERSION_NOT_SUPPORTED: 162,
};

function extractCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
    if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  }

  const message = rawMessage(error);

  // Wallets that stringify the error still name the constant in the message.
  for (const [name, code] of Object.entries(BY_NAME)) {
    if (message.includes(name)) return code;
  }

  return undefined;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through to String() */
    }
  }
  return String(error);
}

export function describeStrk20Error(error: unknown): Strk20Failure {
  const raw = rawMessage(error);
  const code = extractCode(error);
  const known = code !== undefined ? BY_CODE[code] : undefined;

  if (known) return { ...known, raw };

  const recipient = unregisteredRecipient(raw);
  if (recipient !== undefined) {
    return {
      kind: "recipient-not-registered",
      title: "Recipient isn't registered with the pool",
      detail:
        `A private transfer is encrypted to the recipient's viewing key, so the ` +
        `recipient has to publish one on-chain before anyone can pay them${
          recipient ? ` (${shortAddress(recipient)})` : ""
        }. They register from their own wallet's privacy section — one ` +
        `transaction, and it needs the account deployed with gas to pay for it. ` +
        `Nothing was sent; try again once they've registered.`,
      benign: false,
      raw,
    };
  }

  // Wallets commonly report a plain user rejection without a STRK20 code.
  if (/reject|declin|denied|cancel/i.test(raw)) {
    return { ...BY_CODE[113], raw };
  }

  return {
    kind: "unknown",
    title: "Payment failed",
    detail:
      "The wallet couldn't complete the transaction. The details below may say why.",
    benign: false,
    raw,
  };
}

/**
 * A private transfer is encrypted to the recipient's registered viewing key, so
 * the wallet needs a "channel" to them before it can build the note. When the
 * recipient has never registered with the pool there's nothing to encrypt to,
 * and wallets report it as a plain missing-channel error rather than a STRK20
 * code — `NOT_REGISTERED` (118) means the *payer* isn't registered, which the
 * payment flow already checks up front.
 *
 * Returns the recipient address when the message names one, an empty string
 * when the message matches but carries no address, and `undefined` when this
 * isn't a missing-channel failure at all.
 */
function unregisteredRecipient(message: string): string | undefined {
  if (!/channel/i.test(message)) return undefined;
  if (!/missing|no |not found|unknown|unregistered|without/i.test(message)) {
    return undefined;
  }
  return /(0x[0-9a-fA-F]{1,64})/.exec(message)?.[1] ?? "";
}

/** `0x1160…be41` — enough to recognise, short enough to read. */
function shortAddress(address: string): string {
  return address.length <= 13
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
