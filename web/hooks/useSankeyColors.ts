"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { getSankeyColors, SankeyColors } from "@/utils/sankeyColors";

/**
 * Custom hook that provides theme-aware colors for the Sankey diagram
 * @returns Object containing all color values for the Sankey diagram
 */
export function useSankeyColors(): SankeyColors {
  const { theme, resolvedTheme } = useTheme();
  const [colors, setColors] = useState<SankeyColors>(getSankeyColors(resolvedTheme));
  
  // Update colors when theme changes
  useEffect(() => {
    setColors(getSankeyColors(resolvedTheme));
  }, [resolvedTheme]);
  
  return colors;
}
