"use client";
import React, { useState } from "react";
import Blocks from "../components/Blocks";
import RealtimeTable from "../components/RealtimeTable";

export default function HomePage() {
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null);
  return (
    <main className="min-h-screen bg-transparent">
      <header className="p-4 shadow flex items-center">
        <div className="flex-1">
          <Blocks onBlockClick={(height) => setSelectedBlock(height)} />
        </div>
      </header>
      <RealtimeTable filterBlockHeight={selectedBlock ?? undefined} />
    </main>
  );
}