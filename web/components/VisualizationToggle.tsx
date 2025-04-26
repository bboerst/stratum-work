"use client";

import React from "react";
import { useVisualization } from "./VisualizationContext";
import { BarChartIcon, ChevronRightIcon, ChevronLeftIcon } from "lucide-react";

interface VisualizationToggleProps {
  blockHeight?: number | null;
  isTemplatePage?: boolean;
}

export default function VisualizationToggle({ blockHeight, isTemplatePage }: VisualizationToggleProps) {
  const { isPanelVisible, togglePanelVisibility } = useVisualization();
  
  // Hide toggle for historical blocks or the template page
  const isHistoricalBlock = blockHeight !== undefined && blockHeight !== null && blockHeight !== -1;
  
  // Return null instead of rendering the button when viewing a historical block or template page
  if (isHistoricalBlock || isTemplatePage) return null;
  
  return (
    <button
      onClick={togglePanelVisibility}
      className={`flex items-center gap-2 px-3 py-2 rounded-md transition-all duration-200 
        ${isPanelVisible 
          ? "pause-button" 
          : "bg-background text-foreground hover:bg-muted"}`}
      aria-label={isPanelVisible ? "Hide analytics panel" : "Show analytics panel"}
    >
      <BarChartIcon className="h-5 w-5" />
      <span className="text-sm font-medium">Analytics Panel</span>
      {isPanelVisible ? (
        <ChevronRightIcon className="h-4 w-4" />
      ) : (
        <ChevronLeftIcon className="h-4 w-4" />
      )}
    </button>
  );
} 