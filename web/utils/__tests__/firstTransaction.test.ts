import { describe, expect, it } from "vitest";
import { computeFirstTransaction, EMPTY_TEMPLATE } from "../bitcoinUtils";

describe("computeFirstTransaction", () => {
  it("labels a template with no merkle branches an empty template, not an empty block", () => {
    expect(EMPTY_TEMPLATE).toBe("empty template");
    expect(computeFirstTransaction([])).toBe(EMPTY_TEMPLATE);
    expect(computeFirstTransaction(undefined as unknown as string[])).toBe(EMPTY_TEMPLATE);
  });

  it("returns the first branch as a display-order txid (byte-reversed)", () => {
    expect(computeFirstTransaction(["0102030405", "ff"])).toBe("0504030201");
  });
});
