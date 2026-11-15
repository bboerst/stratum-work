import { describe, it, expect } from "vitest";
import { defaults, parseValue, queryKey, resolve, toQuery } from "../framework/settings";
import type { SettingsSchema } from "../framework/types";
import { visuals, findVisual, listedVisuals } from "../registry";

const schema = {
  mode: { type: "enum", label: "Mode", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  n: { type: "number", label: "N", default: 3, min: 1, max: 5 },
  on: { type: "boolean", label: "On", default: true },
} as const satisfies SettingsSchema;

describe("settings", () => {
  it("resolves defaults, then layers, keeping only valid values", () => {
    expect(defaults(schema)).toEqual({ mode: "a", n: 3, on: true });
    expect(resolve(schema, { mode: "b" }, { n: "4", on: "0" })).toEqual({ mode: "b", n: 4, on: false });
    // invalid values from a shared URL or old storage are ignored, numbers are clamped
    expect(resolve(schema, { mode: "evil", n: "1e9", on: "maybe" })).toEqual({ mode: "a", n: 5, on: true });
    expect(resolve(schema, { n: "abc" }, { n: "" })).toEqual({ mode: "a", n: 3, on: true });
  });

  it("parses each type strictly", () => {
    expect(parseValue(schema.on, "1")).toBe(true);
    expect(parseValue(schema.on, "yes")).toBeUndefined();
    expect(parseValue(schema.n, -7)).toBe(1);
    expect(parseValue(schema.mode, { toString: () => "b" })).toBe("b");
    expect(parseValue(schema.mode, null)).toBeUndefined();
  });

  it("puts only non-default values in the URL, round-tripping through resolve", () => {
    const values = { mode: "b" as const, n: 3, on: false };
    const q = toQuery(schema, values);
    expect(q).toEqual({ mode: "b", on: "0" });
    expect(resolve(schema, q)).toEqual(values);
  });

  it("prefixes query keys per instance so visuals can share a page", () => {
    expect(queryKey(null, "n")).toBe("n");
    expect(queryKey("v2", "n")).toBe("v2.n");
  });
});

describe("registry", () => {
  it("has unique, URL-safe ids and valid setting defaults", () => {
    const ids = visuals.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of visuals) {
      expect(v.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(v.title.length).toBeGreaterThan(0);
      // every default must survive its own validation
      expect(resolve(v.settings, defaults(v.settings))).toEqual(defaults(v.settings));
    }
    expect(findVisual("pool-clocks")?.title).toBe("Pool clocks");
    expect(findVisual("nope")).toBeUndefined();
  });

  it("lists lab visuals only in development", () => {
    expect(listedVisuals(false).every((v) => v.status !== "lab")).toBe(true);
    expect(listedVisuals(true).length).toBe(visuals.length);
  });
});
