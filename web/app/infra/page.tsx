"use client";

import { useEffect, useState } from "react";
import InfraLatencyChart from "@/components/InfraLatencyChart";
import InfraPageControls from "@/components/InfraPageControls";
import { DEFAULT_INFRA_LATENCY_WINDOW_SECONDS } from "@/components/infraMetricsConfig";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useGlobalMenu } from "@/components/GlobalMenuContext";

export default function InfraPage() {
  const { paused, setPaused } = useGlobalDataStream();
  const { setMenuContent } = useGlobalMenu();
  const [timeWindow, setTimeWindow] = useState(DEFAULT_INFRA_LATENCY_WINDOW_SECONDS);
  const [showLabels, setShowLabels] = useState(true);

  useEffect(() => {
    setMenuContent(
      <InfraPageControls
        paused={paused}
        setPaused={setPaused}
        timeWindow={timeWindow}
        setTimeWindow={setTimeWindow}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
      />
    );

    return () => setMenuContent(null);
  }, [paused, setMenuContent, setPaused, showLabels, timeWindow]);

  return (
    <main className="h-[calc(100vh-4rem)] w-full p-4">
      <InfraLatencyChart
        paused={paused}
        timeWindow={timeWindow}
        showLabels={showLabels}
      />
    </main>
  );
}
