"use client";

import { useState } from "react";
import RealtimeTable from "@/components/RealtimeTable";
import { Settings2 } from "lucide-react";

export default function TablePage() {
  const [showSettings, setShowSettings] = useState(false);
  const [paused, setPaused] = useState(false);

  return (
    <main className="flex min-h-screen flex-col p-4">
      <div className="container mx-auto">
        <div className="flex justify-between items-center mb-4">
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded bg-gray-200 text-gray-800 hover:bg-gray-300"
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
          <button
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 className="h-6 w-6" />
          </button>
        </div>
        <RealtimeTable
          paused={paused}
          showSettings={showSettings}
          onShowSettingsChange={setShowSettings}
        />
      </div>
    </main>
  );
} 