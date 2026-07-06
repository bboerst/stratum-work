import { describe, expect, test } from "vitest";
import { getCorsHeaders } from "../cors";

describe("CORS headers", () => {
  test("allows any origin only for the public stream hostname", () => {
    const headers = getCorsHeaders("stream.stratum.work", ["https://stratum.work"]);

    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET");
  });

  test("keeps configured origins for normal application hosts", () => {
    const headers = getCorsHeaders("stratum.work", ["https://stratum.work"]);

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://stratum.work");
  });

  test("normalizes hosts that include a port", () => {
    const headers = getCorsHeaders("stream.stratum.work:443", ["https://stratum.work"]);

    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
