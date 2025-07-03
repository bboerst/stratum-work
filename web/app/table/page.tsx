"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import RealtimeTable from "@/components/RealtimeTable";
import PauseButton from "@/components/ui/PauseButton";
import { useState } from "react";
import { Settings2 } from "lucide-react";

export default function TablePage() {
  const [showSettings, setShowSettings] = useState(false);
  const { paused, setPaused } = useGlobalDataStream();

  return (
    <main className="flex min-h-screen flex-col p-4">
      <div className="container mx-auto">
        <div className="flex justify-between items-center mb-4">
          <div className="flex gap-2">
            <PauseButton paused={paused} setPaused={setPaused} />
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