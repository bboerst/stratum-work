import { getStreamEndpoint } from "../../../lib/streamEndpoint";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      streamEndpoint: getStreamEndpoint(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
