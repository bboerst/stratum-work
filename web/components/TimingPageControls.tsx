"use client";

import React, { useState, useRef, useEffect } from "react";
import PauseButton from "./PauseButton";
import SettingsButton from "./SettingsButton";

interface TimingPageControlsProps {
  paused: boolean;
  setPaused: (paused: boolean) => void;
  timeWindow: number;
  setTimeWindow: (timeWindow: number) => void;
  showLabels: boolean;
  setShowLabels: (showLabels: boolean) => void;
}

export default function TimingPageControls({ 
  paused, 
  setPaused, 
  timeWindow, 
  setTimeWindow, 
  showLabels, 
  setShowLabels 
}: TimingPageControlsProps) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  // Handle time window adjustment
  const adjustTimeWindow = (change: number) => {
    const newWindow = Math.max(5, Math.min(300, timeWindow + change)); // Limit between 5s and 5min
    setTimeWindow(newWindow);
  };

  // Add click-outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        settingsButtonRef.current && 
        !settingsButtonRef.current.contains(event.target as Node) &&
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
  }, [showSettings]);

  return (
    <>
      <PauseButton
        paused={paused}
        onToggle={() => setPaused(!paused)}
      />

      {/* Settings button with relative positioning for dropdown */}
      <div className="relative">
        <SettingsButton
          onClick={() => setShowSettings((prev) => !prev)}
          title="Chart Settings"
          buttonRef={settingsButtonRef}
        />

        {/* Settings dropdown */}
        {showSettings && (
          <div className="settings-dropdown absolute right-0 mt-1 w-48 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black ring-opacity-5 p-2 z-10">
          <div className="space-y-3">
            {/* Show last time control */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Show last:</span>
              <div className="flex items-center space-x-2">
                <button 
                  onClick={() => adjustTimeWindow(-15)} 
                  className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                >
                  −
                </button>
                <span className="text-xs w-8 text-center">{timeWindow}s</span>
                <button 
                  onClick={() => adjustTimeWindow(15)} 
                  className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                >
                  +
                </button>
              </div>
            </div>
            
            {/* Show labels toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Show labels:</span>
              <button
                onClick={() => setShowLabels(!showLabels)}
                className={`px-2 py-1 text-xs rounded ${
                  showLabels
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 dark:bg-gray-700'
                }`}
              >
                {showLabels ? "On" : "Off"}
              </button>
            </div>
          </div>
          </div>
        )}
      </div>
    </>
  );
}