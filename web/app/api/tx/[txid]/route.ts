// Relative imports so the route can be unit-tested (lib/__tests__/txRoute.test.ts)
import { badRequest, parseAt, parseTxids, txResponse } from "../../../../lib/txLookup";

export const dynamic = "force-dynamic";

/**
 * One transaction as our node saw it (#198); the batch form is /api/tx?txids=. Fields: ../README.md.
 *
 *   GET /api/tx/<txid>[?at=<ms>]   (display-order hex; at: as in /api/tx)
 */
export async function GET(request: Request, { params }: { params: Promise<{ txid: string }> }) {
  const { txid } = await params;
  let txids: string[];
  let at: number | undefined;
  try {
    if (txid.includes(",")) throw new Error("one txid per request here; use /api/tx?txids= for several");
    txids = parseTxids(txid);
    at = parseAt(new URL(request.url).searchParams.get("at"));
  } catch (error) {
    return badRequest(error);
  }
  return txResponse(txids, true, at);
}
