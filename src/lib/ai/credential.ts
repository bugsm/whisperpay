import "server-only";

/**
 * The credential, and which header it travels in.
 *
 * Kept apart from `./scan`, which imports the Anthropic SDK at the top level.
 * Both the page that offers the receipt mode and the route that answers it need
 * to know only whether scanning is configured, and reaching that answer through
 * `scan.ts` would pull the whole SDK into the `/bill` page's module graph — a
 * cold start's worth of loading to read two environment variables. Same split,
 * and the same reason, as `store/caller.ts` against `store/ratelimit.ts`.
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
export type Credential = {
  header: "bearer" | "x-api-key";
  value: string;
  raw: string;
};

export function credential(): Credential | undefined {
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
 * Whether this deployment can scan at all.
 *
 * The page that offers the mode and the route that answers it both ask here,
 * rather than each reading the environment for itself. They did read it
 * separately once and drifted: `credential` grew bearer-token support while
 * both gates went on testing `ANTHROPIC_API_KEY` alone, so a deployment holding
 * a gateway token had the feature hidden by the UI and refused by the endpoint
 * — with a valid credential sitting in the environment the whole time.
 */
export function scanConfigured(): boolean {
  return credential() !== undefined;
}
