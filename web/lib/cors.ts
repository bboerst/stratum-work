const PUBLIC_STREAM_HOST = "stream.stratum.work";

const normalizeHost = (host: string | null) => {
  return host?.split(",")[0]?.trim().split(":")[0] ?? "";
};

export const getCorsHeaders = (host: string | null, allowedOrigins: string[]) => {
  const allowOrigin = normalizeHost(host) === PUBLIC_STREAM_HOST
    ? "*"
    : allowedOrigins.join(",");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};
