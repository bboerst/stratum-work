export const DEFAULT_STREAM_ENDPOINT = "/api/stream";

const getConfiguredStreamEndpoint = () => {
  return process.env.STREAM_ENDPOINT ?? process.env.NEXT_PUBLIC_STREAM_ENDPOINT;
};

export const getStreamEndpoint = (configuredEndpoint = getConfiguredStreamEndpoint()) => {
  const endpoint = configuredEndpoint?.trim();
  return endpoint || DEFAULT_STREAM_ENDPOINT;
};
