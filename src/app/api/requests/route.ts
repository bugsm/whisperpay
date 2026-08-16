import type { NextRequest } from "next/server";

import { AmountError, parseUnits } from "@/lib/amount";
import { isStarkDomain, resolveStarkName } from "@/lib/identity/starknetid";
import { encodeRequest, newRequestId } from "@/lib/request/codec";
import { MAX_MEMO_LENGTH, type PaymentRequest } from "@/lib/request/types";
import {
  DEFAULT_TOKEN,
  findToken,
  isValidAddress,
  normalizeAddress,
} from "@/lib/strk20/constants";
import { absoluteUrl } from "@/lib/url";

/**
 * Create a payment request.
 *
 * Returns a link that fully contains the request — nothing is written here, so
 * a link works whether or not a status store is configured. The endpoint exists
 * so requests can be minted programmatically (an invoicing script, a bot)
 * without reimplementing the payload format.
 *
 * POST { recipient, amount, token?, memo?, expiresIn? }
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }

  if (typeof body !== "object" || body === null) {
    return fail("Request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;

  // Recipient — a raw address, or a .stark name resolved here and now.
  //
  // The resolved address is what gets stored and paid; the name rides along only
  // as a label. Resolving at creation time means a later transfer of the name
  // can't silently redirect an already-shared link.
  if (typeof input.recipient !== "string" || input.recipient.trim() === "") {
    return fail("`recipient` is required.");
  }
  const identifier = input.recipient.trim();
  let recipientAddress: string;
  let recipientName: string | undefined;

  if (isStarkDomain(identifier.toLowerCase())) {
    recipientName = identifier.toLowerCase();
    const resolved = await resolveStarkName(recipientName);
    if (!resolved) {
      return fail(`${recipientName} isn't registered, or points nowhere.`);
    }
    recipientAddress = resolved;
  } else if (isValidAddress(identifier)) {
    recipientAddress = normalizeAddress(identifier);
  } else {
    return fail("`recipient` must be a Starknet address or a .stark name.");
  }

  // Token — defaults to STRK.
  const tokenAddress =
    typeof input.token === "string" ? input.token : DEFAULT_TOKEN.address;
  const token = findToken(tokenAddress);
  if (!token) {
    return fail(`Unsupported token: ${tokenAddress}`);
  }

  // Amount, given as a human decimal string ("5", "0.25").
  if (typeof input.amount !== "string" && typeof input.amount !== "number") {
    return fail("`amount` must be a decimal string.");
  }
  let amount: bigint;
  try {
    amount = parseUnits(String(input.amount), token.decimals);
  } catch (error) {
    return fail(
      error instanceof AmountError ? error.message : "`amount` is not valid."
    );
  }
  if (amount <= 0n) {
    return fail("`amount` must be greater than zero.");
  }

  // Memo
  let memo: string | undefined;
  if (input.memo !== undefined && input.memo !== null && input.memo !== "") {
    if (typeof input.memo !== "string") {
      return fail("`memo` must be a string.");
    }
    if (input.memo.length > MAX_MEMO_LENGTH) {
      return fail(`\`memo\` must be at most ${MAX_MEMO_LENGTH} characters.`);
    }
    memo = input.memo;
  }

  // Expiry, in seconds from now. `null` means the link never expires.
  const createdAt = Math.floor(Date.now() / 1000);
  let expiresAt: number | undefined;
  if (input.expiresIn !== undefined && input.expiresIn !== null) {
    const seconds = Number(input.expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return fail("`expiresIn` must be a positive number of seconds, or null.");
    }
    expiresAt = createdAt + Math.floor(seconds);
  }

  const paymentRequest: PaymentRequest = {
    id: newRequestId(),
    recipient: recipientAddress,
    recipientName,
    token: normalizeAddress(token.address),
    amount,
    memo,
    createdAt,
    expiresAt,
  };

  const encoded = encodeRequest(paymentRequest);
  const path = `/pay/${encoded}`;

  return Response.json(
    {
      id: paymentRequest.id,
      path,
      url: absoluteUrl(request, path),
      request: {
        recipient: paymentRequest.recipient,
        recipientName: paymentRequest.recipientName ?? null,
        token: paymentRequest.token,
        tokenSymbol: token.symbol,
        amount: paymentRequest.amount.toString(),
        memo: paymentRequest.memo ?? null,
        createdAt: paymentRequest.createdAt,
        expiresAt: paymentRequest.expiresAt ?? null,
      },
    },
    { status: 201 }
  );
}

function fail(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
