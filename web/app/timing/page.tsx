"use client";

import { useState, useEffect } from "react";
import RealtimeChart from "@/components/RealtimeChart";
import TimingPageControls from "@/components/TimingPageControls";
import { useGlobalMenu } from "@/components/GlobalMenuContext";

export default function TimingPage() {
  const [paused, setPaused] = useState(false);
  const [timeWindow, setTimeWindow] = useState(30);
  const [showLabels, setShowLabels] = useState(false);
  const { setMenuContent } = useGlobalMenu();

  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <TimingPageControls 
        paused={paused}
        setPaused={setPaused}
        timeWindow={timeWindow}
        setTimeWindow={setTimeWindow}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
      />
    );
    
    // Clean up when the component unmounts
    return () => setMenuContent(null);
  }, [paused, setMenuContent, timeWindow, showLabels]);

  return (
    <main className="h-[calc(100vh-4rem)] w-full p-4">
      <RealtimeChart
        paused={paused}
        timeWindow={timeWindow}
        hideHeader={true} // Hide title and options since they're in the nav
        showLabels={showLabels}
        showPoolNames={true} // Show pool names column on the right
      />
    </main>
  );
}