import { getStreamEndpoint } from "../../../lib/streamEndpoint";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      streamEndpoint: getStreamEndpoint(),
      // The realtime views pre-fill from history only when it's enabled (#130); same default as lib/db.
      historicalDataEnabled: (process.env.ENABLE_HISTORICAL_DATA ?? "true").toLowerCase() === "true",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
