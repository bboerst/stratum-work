"use client";

import React, { useEffect, useRef } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import VisualizationToggle from "./VisualizationToggle";
import PauseButton from "./PauseButton";
import SettingsButton from "./SettingsButton";

interface RealtimeTableMenuProps {
  paused?: boolean;
  setPaused?: (value: boolean | ((prev: boolean) => boolean)) => void;
  showSettings: boolean;
  setShowSettings: (value: boolean | ((prev: boolean) => boolean)) => void;
  selectedBlockHeight?: number | null;
}

export default function RealtimeTableMenu({
  paused: propsPaused,
  setPaused: propSetPaused,
  showSettings,
  setShowSettings,
  selectedBlockHeight = null,
}: RealtimeTableMenuProps) {
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const { paused, setPaused } = useGlobalDataStream();

  // Use props values if provided, otherwise use global values
  const effectivePaused = propsPaused !== undefined ? propsPaused : paused;
  
  // Handle the pause toggle
  const handlePauseToggle = () => {
    if (propSetPaused) {
      propSetPaused(!effectivePaused);
    } else {
      setPaused(!effectivePaused);
    }
  };

  // Add click-outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Check if the click was outside the settings button and not inside the settings dropdown
      // The settings dropdown has a ref in RealtimeTable component
      if (
        settingsButtonRef.current && 
        !settingsButtonRef.current.contains(event.target as Node) &&
        // Make sure we're not clicking on an element with class 'settings-dropdown' or its children
        !(event.target as Element).closest('.settings-dropdown')
      ) {
        setShowSettings(false);
      }
    };
    
    if (showSettings) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
    
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSettings, setShowSettings]);

  return (
    <>
      {/* Analytics Panel Toggle */}
      <VisualizationToggle blockHeight={selectedBlockHeight} />
      
      {/* Only show Pause/Resume button when viewing the being-mined block */}
      {selectedBlockHeight === -1 && (
        <PauseButton
          paused={effectivePaused}
          onToggle={handlePauseToggle}
        />
      )}

      {/* Settings button */}
      <div className="relative">
        <SettingsButton
          onClick={() => setShowSettings((prev) => !prev)}
          title="Toggle Column Settings"
          buttonRef={settingsButtonRef}
        />
      </div>
    </>
  );
} 