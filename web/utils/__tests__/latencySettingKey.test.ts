import { describe, expect, test } from "vitest";

import { tableLatencySettingKey } from "../latencySettingKey";

describe("tableLatencySettingKey", () => {
  test("uses the chart timing setting for historical block-height views", () => {
    expect(tableLatencySettingKey(900_001)).toBe("timing-chart");
  });

  test("uses the table setting for realtime or unset views", () => {
    expect(tableLatencySettingKey()).toBe("table");
    expect(tableLatencySettingKey(-1)).toBe("table");
  });
});
