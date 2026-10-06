import { getStreamEndpoint, getTemplatesEndpoint } from "../../../lib/streamEndpoint";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      streamEndpoint: getStreamEndpoint(),
      templatesEndpoint: getTemplatesEndpoint(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
