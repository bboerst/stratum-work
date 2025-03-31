"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

interface VisualizationContextType {
  isPanelVisible: boolean;
  togglePanelVisibility: () => void;
  activeVisualizations: Set<string>;
  toggleVisualization: (id: string) => void;
  isVisualizationActive: (id: string) => boolean;
}

const VisualizationContext = createContext<VisualizationContextType | undefined>(undefined);

export function VisualizationProvider({ children }: { children: ReactNode }) {
  const [isPanelVisible, setIsPanelVisible] = useState(true);
  const [activeVisualizations, setActiveVisualizations] = useState<Set<string>>(new Set(["chart"])); // Default to chart active

  const togglePanelVisibility = () => {
    setIsPanelVisible(prev => !prev);
  };

  const toggleVisualization = (id: string) => {
    setActiveVisualizations(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const isVisualizationActive = (id: string) => {
    return activeVisualizations.has(id);
  };

  return (
    <VisualizationContext.Provider value={{
      isPanelVisible,
      togglePanelVisibility,
      activeVisualizations,
      toggleVisualization,
      isVisualizationActive
    }}>
      {children}
    </VisualizationContext.Provider>
  );
}

export function useVisualization() {
  const context = useContext(VisualizationContext);
  if (context === undefined) {
    throw new Error("useVisualization must be used within a VisualizationProvider");
  }
  return context;
} 