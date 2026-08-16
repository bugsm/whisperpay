import type { NextRequest } from "next/server";

import {
  isStarkDomain,
  lookupStarkName,
  resolveStarkName,
} from "@/lib/identity/starknetid";
import { isValidAddress, normalizeAddress } from "@/lib/strk20/constants";

/**
 * Resolve a payment identifier to an address.
 *
 * Accepts either a `.stark` name or a raw address, and answers with both
 * whenever it can — a name so the payer sees something human, an address
 * because that's what actually gets paid.
 *
 * Resolution runs server-side so a payer's browser doesn't have to make its own
 * RPC calls just to render a name.
 *
 * GET /api/resolve?identifier=alice.stark
 */
export async function GET(request: NextRequest) {
  const identifier = request.nextUrl.searchParams.get("identifier")?.trim();

  if (!identifier) {
    return Response.json({ error: "`identifier` is required." }, { status: 400 });
  }

  if (isStarkDomain(identifier.toLowerCase())) {
    const name = identifier.toLowerCase();
    const address = await resolveStarkName(name);
    if (!address) {
      return Response.json(
        { error: `${name} isn't registered, or points nowhere.` },
        { status: 404 }
      );
    }
    return Response.json({ kind: "name", name, address });
  }

  if (isValidAddress(identifier)) {
    const address = normalizeAddress(identifier);
    // A missing reverse record is normal, not an error.
    const name = await lookupStarkName(address);
    return Response.json({ kind: "address", address, name });
  }

  return Response.json(
    { error: "Enter a Starknet address or a .stark name." },
    { status: 400 }
  );
}
