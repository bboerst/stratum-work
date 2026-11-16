"use client";

import { useMemo } from "react";
import { useTemplateBuffer } from "@/lib/DataStreamContext";
import { usePoolFilter } from "@/components/PoolFilterContext";
import type { BufferedTemplate } from "@/lib/templateBuffer";

// The data layer visuals use (#157). It wraps the shared template buffer (live stream + history prefill, flood
// protection and the pool blacklist already applied server side) and the viewer's pool filter, so no visual talks
// to the stream or the APIs directly. More hooks (blocks, tip, history by height range) are added here, not in
// visuals.

export interface TemplatesView {
  /** Bitcoin templates the viewer has selected pools for, oldest first. */
  templates: BufferedTemplate[];
  currentHeight: number | null;
  tipHeight: number | null;
  /** True until the history prefill has finished (or was skipped): "no data yet" isn't "no data". */
  loading: boolean;
}

/**
 * Recent templates. `heights` keeps only the last N heights ending at the current one (the buffer holds 3).
 * The result only changes when the buffer does, so it's safe to derive memoized data from it.
 */
export function useTemplates({ heights }: { heights?: number } = {}): TemplatesView {
  const { entries, currentHeight, tipHeight, prefill } = useTemplateBuffer();
  const { isPoolVisible } = usePoolFilter();
  const templates = useMemo(() => {
    const minHeight = heights && currentHeight !== null ? currentHeight - heights + 1 : null;
    return entries.filter(
      (e) => (minHeight === null || e.data.height >= minHeight) && isPoolVisible(e.data.pool_name)
    );
  }, [entries, currentHeight, heights, isPoolVisible]);
  return {
    templates,
    currentHeight,
    tipHeight,
    loading: prefill.status === "pending" || prefill.status === "loading",
  };
}
