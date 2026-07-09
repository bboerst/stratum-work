"use client";

import { useEffect, useState } from "react";
import LatencyHeatmap from "@/components/LatencyHeatmap";
import LatencyPageControls from "@/components/LatencyPageControls";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useGlobalMenu } from "@/components/GlobalMenuContext";

export default function LatencyPage() {
  const { paused, setPaused } = useGlobalDataStream();
  const { setMenuContent } = useGlobalMenu();
  const [timeWindow, setTimeWindow] = useState(180);
  const [showLabels, setShowLabels] = useState(true);
  const [sortByLatest, setSortByLatest] = useState(true);

  useEffect(() => {
    setMenuContent(
      <LatencyPageControls
        paused={paused}
        setPaused={setPaused}
        timeWindow={timeWindow}
        setTimeWindow={setTimeWindow}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
        sortByLatest={sortByLatest}
        setSortByLatest={setSortByLatest}
      />
    );

    return () => setMenuContent(null);
  }, [paused, setMenuContent, setPaused, showLabels, sortByLatest, timeWindow]);

  return (
    <main className="h-[calc(100vh-4rem)] w-full p-4">
      <LatencyHeatmap
        paused={paused}
        timeWindow={timeWindow}
        showLabels={showLabels}
        sortByLatest={sortByLatest}
      />
    </main>
  );
}
