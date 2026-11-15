import type { SettingsSchema } from "../framework/types";

export const poolClocksSettings = {
  reference: {
    type: "enum",
    label: "Compare with",
    default: "ntime",
    options: [
      { value: "ntime", label: "Header ntime" },
      { value: "received", label: "Our receive time" },
    ],
    help: "ntime: the pool's own header time. Receive time: our collector's clock, so the offset is the pool clock's skew (plus a few ms of network).",
  },
  heights: { type: "number", label: "Heights", default: 3, min: 1, max: 3, help: "How many recent heights to include." },
  sortBy: {
    type: "enum",
    label: "Sort pools by",
    default: "offset",
    options: [
      { value: "offset", label: "Median offset" },
      { value: "name", label: "Name" },
    ],
  },
  showSamples: { type: "boolean", label: "Show each template", default: true },
  groupTolerance: {
    type: "number",
    label: "Similar-clock tolerance",
    default: 2,
    min: 0,
    max: 10,
    step: 0.5,
    unit: "s",
    help: "Pools whose medians are this close are marked as sharing a clock.",
  },
} as const satisfies SettingsSchema;
