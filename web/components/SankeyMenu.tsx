"use client";

import React, { useEffect, useRef } from "react";
import ModeToggle from "@/components/ModeToggle";
import PauseButton from "@/components/ui/PauseButton";

interface SankeyMenuProps {
  paused: boolean;
  setPaused: (value: boolean | ((prev: boolean) => boolean)) => void;
  showSettings: boolean;
  setShowSettings: (value: boolean | ((prev: boolean) => boolean)) => void;
  showLabels: boolean;
  setShowLabels: (value: boolean | ((prev: boolean) => boolean)) => void;
  showStatus: boolean;
  showRawEvents: boolean;
  setShowRawEvents: (value: boolean | ((prev: boolean) => boolean)) => void;

  setShowStatus: (value: boolean | ((prev: boolean) => boolean)) => void;
}

export default function SankeyMenu({
  paused,
  setPaused,
  showSettings,
  setShowSettings,
  showLabels,
  setShowLabels,
  showStatus,
  setShowStatus,
  showRawEvents,
  setShowRawEvents,
}: SankeyMenuProps) {
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Auto-hide settings panel if clicked outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        settingsButtonRef.current && 
        !settingsButtonRef.current.contains(event.target as Node) &&
        settingsRef.current && 
        !settingsRef.current.contains(event.target as Node)
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
      {/* Pause/Resume button */}
      <PauseButton paused={paused} setPaused={setPaused} />

      {/* Settings button */}
      <button
        ref={settingsButtonRef}
        onClick={() => setShowSettings((prev) => !prev)}
        title="Toggle Settings"
        className="text-foreground focus:outline-none hover:text-blue-500 transition-colors duration-200"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
          viewBox="0 0 14 14"
          height="25"
          width="25"
        >
          <g>
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M5.69371 0.279427C5.96047 0.097683 6.27657 0.00041008 6.59927 0h0.8028c0.3227 0.000410318 0.6388 0.0976833 0.90556 0.279427 0.2664 0.181494 0.47217 0.438913 0.59014 0.739043l0.35231 0.88803 1.05272 0.60698 0.9481-0.144c0.3195-0.04803 0.6472 0.00089 0.9385 0.14079 0.2912 0.13984 0.5337 0.36407 0.6955 0.64379l0.4003 0.68996c0.1623 0.27972 0.2362 0.60194 0.2118 0.92448-0.0243 0.32242-0.1457 0.62976-0.3479 0.88194l-0.5988 0.7473 0.0003 1.20452 0.5988 0.7473c0.2022 0.25218 0.3235 0.55952 0.3479 0.88194 0.0243 0.32254-0.0496 0.64476-0.2119 0.9245l-0.4002 0.6899c-0.16185 0.2798-0.40435 0.50395-0.69554 0.6438-0.29131 0.1399-0.61898 0.18882-0.93851 0.1408l-0.94812-0.144-1.05267 0.607-0.35232 0.888c-0.11797 0.3002-0.32373 0.5576-0.59013 0.7391-0.26677 0.1817-0.58286 0.279-0.90557 0.2794h-0.80279c-0.32271-0.0004-0.6388-0.0977-0.90557-0.2794-0.2664-0.1815-0.47217-0.4389-0.59013-0.7391l-0.35232-0.888-1.05267-0.607-0.94812 0.144c-0.31953 0.048-0.6472-0.0009-0.93851-0.1408-0.29118-0.1398-0.53369-0.364-0.69553-0.6438l-0.400278-0.6899c-0.162281-0.27974-0.2362-0.60196-0.211847-0.9245 0.024346-0.32242 0.145722-0.62976 0.347918-0.88194l0.598787-0.7473-0.00024-1.20452-0.598792-0.7473C0.650023 5.39826 0.528646 5.09092 0.504301 4.7685c-0.024353-0.32254 0.049566-0.64476 0.211847-0.92448l0.400272-0.6899c0.16185-0.27972 0.40435-0.50395 0.69554-0.64379 0.29131-0.1399 0.61898-0.18882 0.93851-0.14079l0.94812 0.144 1.05267-0.60698 0.35231-0.88803c0.11797-0.30013 0.32374-0.55755 0.59014-0.739043Zm0.90607 0.970513c-0.07242 0.00015-0.14291 0.02202-0.20228 0.06247-0.05942 0.04048-0.10482 0.09758-0.13069 0.16357l-0.00093 0.00237-0.40323 1.01636-0.00051 0.00129c-0.07085 0.17742-0.19876 0.32579-0.36305 0.42212l-0.00393 0.00231-1.29638 0.74748c-0.16515 0.09345-0.35649 0.12962-0.54418 0.10313l-0.00651-0.00092-1.08437-0.16473c-0.07182-0.01073-0.14545 0.00031-0.21063 0.03161-0.06525 0.03134-0.11907 0.08134-0.15478 0.1431l-0.40095 0.69113c-0.03578 0.06168-0.05194 0.13244-0.04661 0.20309 0.00534 0.07066 0.03196 0.13834 0.07674 0.19417l0.68839 0.85913c0.12005 0.15101 0.18546 0.33844 0.18513 0.53173v0.74059l0.00024 0.73929c0.00033 0.19329-0.06507 0.38071-0.18513 0.53173l-0.68839 0.85913c-0.04478 0.05583-0.0714 0.12351-0.07673 0.19417-0.00534 0.07065 0.01083 0.14141 0.04661 0.20309l0.40095 0.69115c0.0357 0.0617 0.08953 0.1117 0.15478 0.1431 0.06518 0.0313 0.13881 0.0423 0.21062 0.0316l1.08437-0.1647 0.00652-0.001c0.18768-0.0264 0.37902 0.0097 0.54418 0.1032l1.29637 0.7475 0.00394 0.0023c0.16428 0.0963 0.29219 0.2447 0.36304 0.4221l0.00051 0.0013 0.40323 1.0163 0.00094 0.0024c0.02586 0.066 0.07127 0.1231 0.13068 0.1636 0.05937 0.04048 0.12986 0.0623 0.20228 0.0624h0.40089l0.40089 0.0001c0.07242-0.0001 0.14291-0.022 0.20228-0.0625 0.05942-0.0404 0.10482-0.0976 0.13069-0.1635l0.00093-0.0024 0.40323-1.0164 0.00052-0.0013c0.07084-0.1774 0.19876-0.3257 0.36304-0.4221l0.00393-0.0023 1.29638-0.7475c0.16515-0.0934 0.3565-0.1296 0.5442-0.1031l0.00652 0.0009 1.08437 0.1648c0.0718 0.0107 0.1454-0.0004 0.2106-0.0317 0.0652-0.0313 0.1191-0.0813 0.1548-0.1431l0.4009-0.69109c0.0358-0.06168 0.052-0.13244 0.0466-0.20309-0.00534-0.07066-0.0319-0.13834-0.0767-0.19417l-0.6884-0.85913c-0.12-0.15102-0.1855-0.33844-0.1851-0.53173v-0.0013L11.3008 7v-0.74059c-0.0003-0.19329 0.0651-0.38071 0.1851-0.53173l0.6884-0.85913c0.0448-0.05583 0.0714-0.12351 0.0768-0.19417 0.00534-0.07065-0.0109-0.14141-0.0466-0.20309l-0.401-0.69113c-0.0357-0.06176-0.0895-0.11176-0.1548-0.14309-0.0651-0.03131-0.1388-0.04235-0.2106-0.03162l-1.0844 0.16473-0.0065 0.00092c-0.1877 0.02649-0.379-0.00967-0.54416-0.10313l-1.29637-0.74748-0.00394-0.00231c-0.16428-0.09633-0.29219-0.2447-0.36304-0.42212l-0.00051-0.00129-0.40323-1.01636-0.00093-0.00237c-0.02587-0.06599-0.07127-0.12309-0.13069-0.16357-0.05937-0.04045-0.12986-0.06232-0.20228-0.06247h-0.40138ZM9.25073 7c0 1.44-0.81 2.25-2.25 2.25s-2.25-0.81-2.25-2.25 0.81-2.25 2.25-2.25 2.25 0.81 2.25 2.25Z"
            />
          </g>
        </svg>
      </button>

      {/* Settings dropdown */}
      {showSettings && (
        <div
          ref={settingsRef}
          className="settings-dropdown fixed bg-background text-foreground border shadow-md rounded p-2 z-50"
          style={{ 
            top: '60px', 
            right: '20px'
          }}
        >          
          <div>
            <ModeToggle />
            <div className="font-bold text-sm mt-2">Sankey Settings</div>
          </div>
          <label className="block text-sm mt-1">
            <input
              type="checkbox"
              className="mr-1"
              checked={showLabels}
              onChange={() => setShowLabels(!showLabels)}
            />
            Show Labels
          </label>

          <label className="block text-sm mt-1">
            <input
              type="checkbox"
              className="mr-1"
              checked={showStatus}
              onChange={() => setShowStatus(!showStatus)}
            />
            Show Node & Link counts
          </label>

          <label className="block text-sm mt-1">
            <input
              type="checkbox"
              className="mr-1"
              checked={showRawEvents}
              onChange={() => setShowRawEvents(!showRawEvents)}
            />
            Show Raw Events
          </label>
        </div>
      )}
    </>
  );
}
