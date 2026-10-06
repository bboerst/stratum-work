import { afterEach, describe, expect, test, vi } from "vitest";
import { getStreamEndpoint, getTemplatesEndpoint } from "../streamEndpoint";

describe("getTemplatesEndpoint", () => {
  test("prefers explicit config, else derives from an absolute stream endpoint", () => {
    expect(getTemplatesEndpoint("https://t.example/", "https://s.example")).toBe("https://t.example");
    expect(getTemplatesEndpoint(undefined, "https://stream.stratum.work/")).toBe("https://stream.stratum.work");
    expect(getTemplatesEndpoint(undefined, "/relative/path")).toBe("");
    expect(getTemplatesEndpoint()).toBe("https://stream.stratum.work");
  });
});

describe("stream endpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to the public stream service", () => {
    expect(getStreamEndpoint()).toBe("https://stream.stratum.work");
  });

  test("uses the configured endpoint when provided", () => {
    expect(getStreamEndpoint("https://stream.example.com")).toBe("https://stream.example.com");
  });

  test("ignores blank configured endpoints", () => {
    expect(getStreamEndpoint("  ")).toBe("https://stream.stratum.work");
  });

  test("uses the runtime stream endpoint environment variable", () => {
    vi.stubEnv("STREAM_ENDPOINT", "https://stream.example.com");

    expect(getStreamEndpoint()).toBe("https://stream.example.com");
  });
});
