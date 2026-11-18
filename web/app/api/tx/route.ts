// Relative imports so the route can be unit-tested (lib/__tests__/txRoute.test.ts)
import { badRequest, parseAt, parseTxids, txResponse } from "../../../lib/txLookup";

export const dynamic = "force-dynamic";

/**
 * Transactions as our node saw them, from the mempool recorder's tables (#198). Read-only (with historical data
 * disabled it answers supported: false without touching a database). Fields and fee-rate definitions: ./README.md.
 *
 *   GET /api/tx?txids=<txid>,<txid>,...[&at=<ms>]   (display-order hex, at most 100)
 *
 * at: when the transactions were pending (e.g. a template's receive time), default now. Only mempool stays first seen
 * in [at - 15 days, at + 1 hour) are searched (lib/db/tx.ts).
 *
 * Cache-Control max-age is the shortest of the answers': 10 s if one wasn't seen, 30 s if one is still in the
 * mempool, else an hour.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let txids: string[];
  let at: number | undefined;
  try {
    txids = parseTxids(params.get("txids"));
    at = parseAt(params.get("at"));
  } catch (error) {
    return badRequest(error);
  }
  return txResponse(txids, false, at);
}
