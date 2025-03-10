"use client";

import { useState, useEffect } from "react";
import RealtimeTable from "@/components/RealtimeTable";
import RealtimeTableMenu from "@/components/RealtimeTableMenu";
import { useGlobalMenu } from "@/components/GlobalMenuContext";
import { useGlobalDataStream } from "@/lib/DataStreamContext";

export default function TablePage() {
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { setMenuContent } = useGlobalMenu();
  const { isConnected } = useGlobalDataStream();
  
  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <RealtimeTableMenu 
        paused={paused}
        setPaused={setPaused}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
      />
    );
    
    // Clean up when the component unmounts
    return () => setMenuContent(null);
  }, [paused, showSettings, setMenuContent, isConnected]);

  return (
    <main className="min-h-screen bg-transparent">
      <RealtimeTable 
        paused={paused}
        showSettings={showSettings}
      />
    </main>
  );
} 