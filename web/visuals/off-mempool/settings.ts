import type { SettingsSchema } from "../framework/types";

export const offMempoolSettings = {
  view: {
    type: "enum",
    label: "View",
    default: "provider",
    options: [
      { value: "provider", label: "By template provider" },
      { value: "height", label: "By height" },
    ],
    help: "Template provider: who builds the templates, grouped as on the home page. Height: every block in order, with the gaps in our record.",
  },
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
