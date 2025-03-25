"use client";

import React from "react";
import { useVisualization } from "./VisualizationContext";
import { BarChartIcon } from "lucide-react";

export default function VisualizationToggle() {
  const { isPanelVisible, togglePanelVisibility } = useVisualization();
  
  const navItemBaseClasses = "flex items-center justify-center w-10 h-10 rounded-md transition-colors duration-200 relative";
  const activeClasses = "text-white";
  const inactiveClasses = "text-foreground hover:text-gray-600";
  
  return (
    <button
      onClick={togglePanelVisibility}
      className={`${navItemBaseClasses} ${isPanelVisible ? activeClasses : inactiveClasses}`}
      title="Toggle Visualizations Panel"
    >
      {isPanelVisible && <div className="absolute inset-0 bg-purple-800 rounded-md"></div>}
      <div className="relative z-10">
        <BarChartIcon className="h-5 w-5" />
      </div>
    </button>
  );
} 