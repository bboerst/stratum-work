import type { SettingsSchema } from "../framework/types";

export const offMempoolSettings = {
  range: {
    type: "enum",
    label: "Range",
    default: "6e",
    options: [
      { value: "6e", label: "6 epochs" },
      { value: "26e", label: "26 epochs" },
      { value: "all", label: "All history" },
    ],
    help: "Difficulty epochs (2,016 blocks) below our tip. The record starts with the mempool recorder: earlier blocks have no data.",
  },
} as const satisfies SettingsSchema;
