"use client";

import React from "react";
import { useVisualization } from "./VisualizationContext";
import { BarChartIcon, ChevronRightIcon, ChevronLeftIcon } from "lucide-react";

interface VisualizationToggleProps {
  blockHeight?: number | null;
}

export default function VisualizationToggle({ blockHeight }: VisualizationToggleProps) {
  const { isPanelVisible, togglePanelVisibility } = useVisualization();
  
  // Hide toggle for historical blocks (any block that isn't the "being-mined" block with height -1)
  const isHistoricalBlock = blockHeight !== undefined && blockHeight !== null && blockHeight !== -1;
  
  // Return null instead of rendering the button when viewing a historical block
  if (isHistoricalBlock) return null;
  
  return (
    <button
      onClick={togglePanelVisibility}
      className={`flex items-center gap-2 px-3 py-2 rounded-md transition-all duration-200 
        ${isPanelVisible 
          ? "bg-purple-900/80 text-white" 
          : "bg-background text-foreground hover:bg-muted"}`}
      aria-label={isPanelVisible ? "Hide analytics" : "Show analytics"}
    >
      <BarChartIcon className="h-5 w-5" />
      <span className="text-sm font-medium">Analytics</span>
      {isPanelVisible ? (
        <ChevronRightIcon className="h-4 w-4" />
      ) : (
        <ChevronLeftIcon className="h-4 w-4" />
      )}
    </button>
  );
} 