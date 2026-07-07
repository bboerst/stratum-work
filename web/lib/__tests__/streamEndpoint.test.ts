import { afterEach, describe, expect, test, vi } from "vitest";
import { getStreamEndpoint } from "../streamEndpoint";

describe("stream endpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to the existing local API route", () => {
    expect(getStreamEndpoint()).toBe("/api/stream");
  });

  test("uses the configured endpoint when provided", () => {
    expect(getStreamEndpoint("https://stream.example.com")).toBe("https://stream.example.com");
  });

  test("ignores blank configured endpoints", () => {
    expect(getStreamEndpoint("  ")).toBe("/api/stream");
  });

  test("uses the runtime stream endpoint environment variable", () => {
    vi.stubEnv("STREAM_ENDPOINT", "https://stream.example.com");

    expect(getStreamEndpoint()).toBe("https://stream.example.com");
  });
});
