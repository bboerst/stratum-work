"use client";

import React, { useEffect, useRef, useState } from "react";
import PauseButton from "./PauseButton";
import SettingsButton from "./SettingsButton";

interface InfraPageControlsProps {
  paused: boolean;
  setPaused: (paused: boolean) => void;
  timeWindow: number;
  setTimeWindow: (timeWindow: number) => void;
  showLabels: boolean;
  setShowLabels: (showLabels: boolean) => void;
}

export default function InfraPageControls({
  paused,
  setPaused,
  timeWindow,
  setTimeWindow,
  showLabels,
  setShowLabels,
}: InfraPageControlsProps) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const adjustTimeWindow = (change: number) => {
    setTimeWindow(Math.max(15, Math.min(600, timeWindow + change)));
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        settingsButtonRef.current &&
        !settingsButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest(".settings-dropdown")
      ) {
        setShowSettings(false);
      }
    };

    if (showSettings) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSettings]);

  return (
    <>
      <PauseButton paused={paused} onToggle={() => setPaused(!paused)} />

      <div className="relative">
        <SettingsButton
          onClick={() => setShowSettings((prev) => !prev)}
          title="Infra Metrics Settings"
          buttonRef={settingsButtonRef}
        />

        {showSettings && (
          <div className="settings-dropdown absolute right-0 mt-1 w-52 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black ring-opacity-5 p-2 z-10">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Show last:</span>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => adjustTimeWindow(-30)}
                    className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                    title="Decrease time window"
                  >
                    -
                  </button>
                  <span className="text-xs w-10 text-center">{timeWindow}s</span>
                  <button
                    onClick={() => adjustTimeWindow(30)}
                    className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                    title="Increase time window"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Pool legend:</span>
                <button
                  onClick={() => setShowLabels(!showLabels)}
                  className={`px-2 py-1 text-xs rounded ${
                    showLabels ? "bg-blue-500 text-white" : "bg-gray-200 dark:bg-gray-700"
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
