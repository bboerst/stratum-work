"use client";

import VisualizationToggle from "./VisualizationToggle";

export default function Navigation({ children }: { children: React.ReactNode }) {
  return (
    <nav className="relative w-full z-10 bg-background">
      <div className="flex items-center justify-end h-16 px-4">
        <div className="flex items-center space-x-2">
          <VisualizationToggle />
          {children}
        </div>
      </div>
    </nav>
  );
} 