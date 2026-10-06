export const DEFAULT_STREAM_ENDPOINT = "https://stream.stratum.work";

const getConfiguredStreamEndpoint = () => {
  return process.env.STREAM_ENDPOINT ?? process.env.NEXT_PUBLIC_STREAM_ENDPOINT;
};

export const getStreamEndpoint = (configuredEndpoint = getConfiguredStreamEndpoint()) => {
  const endpoint = configuredEndpoint?.trim();
  return endpoint || DEFAULT_STREAM_ENDPOINT;
};

// Base URL for `/templates` backfill: explicit config, else the stream endpoint's origin, else '' (live-only).
export const getTemplatesEndpoint = (configured = process.env.TEMPLATES_ENDPOINT, stream = getStreamEndpoint()) => {
  const c = configured?.trim();
  if (c) return c.replace(/\/+$/, "");
  try {
    return new URL(stream).origin;
  } catch {
    return "";
  }
};
