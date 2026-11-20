"use client";

import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";

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

  // On a phone the panel would squeeze the table to a sliver, so it starts closed there (it opens full width).
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setIsPanelVisible(false);
  }, []);

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