"use client";

import { Suspense } from "react";
import { findVisual } from "@/visuals/registry";
import { VisualFrame } from "@/visuals/framework/VisualFrame";

function Frame({ id }: { id: string }) {
  const visual = findVisual(id);
  if (!visual) return null; // the server page already returned 404 for unknown ids
  return <VisualFrame visual={visual} standalone />;
}

export default function VisualPage({ id }: { id: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8">
      <div className="w-full max-w-7xl">
        {/* useSearchParams (settings in the URL) needs a Suspense boundary */}
        <Suspense fallback={null}>
          <Frame id={id} />
        </Suspense>
      </div>
    </main>
  );
}
