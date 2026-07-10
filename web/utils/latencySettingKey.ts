import type { TimingVisualKey } from "@/components/TimingDisplayContext";

export function tableLatencySettingKey(filterBlockHeight?: number): TimingVisualKey {
  return filterBlockHeight && filterBlockHeight > 0 ? "timing-chart" : "table";
}
