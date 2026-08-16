import { RpcProvider } from "starknet";

import { RPC_URL } from "./constants";

/**
 * Shared mainnet RPC provider.
 *
 * Used for reads the wallet can't do for us — waiting on receipts, verifying a
 * reported transaction actually touched the pool. Deliberately separate from
 * the wallet's own provider, which is fixed at connect time and can end up
 * pointing at a different network than the user is currently on.
 */
export const mainnetProvider = new RpcProvider({ nodeUrl: RPC_URL });
