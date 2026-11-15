"use client";

import React, { useId, useRef, useState } from "react";
import { Maximize2, Minimize2, Settings2 } from "lucide-react";
import type { SettingsSchema, VisualDefinition } from "./types";
import { SettingsPanel } from "./SettingsPanel";
import { useVisualSettings } from "./useVisualSettings";

// Everything around a visual: title, description, status badge, settings, fullscreen, the "about" text. The same
// frame renders a visual on its own page (standalone) or next to others (queryPrefix set, so settings don't clash).

interface Props<S extends SettingsSchema> {
  visual: VisualDefinition<S>;
  standalone?: boolean;
  queryPrefix?: string | null;
}

export function VisualFrame<S extends SettingsSchema>({ visual, standalone = true, queryPrefix = null }: Props<S>) {
  const { settings, update, reset } = useVisualSettings(visual.id, visual.settings, queryPrefix);
  const [showSettings, setShowSettings] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const instanceKey = `${visual.id}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const Icon = visual.icon;
  const Component = visual.component;
  const hasSettings = Object.keys(visual.settings).length > 0;

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await ref.current?.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch {
      setFullscreen(false);
    }
  };

  return (
    <section ref={ref} className="w-full rounded-lg border bg-card p-4 overflow-auto" aria-labelledby={`${instanceKey}-title`}>
      <header className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 id={`${instanceKey}-title`} className={`${standalone ? "text-xl" : "text-base"} font-bold flex items-center gap-2`}>
            <Icon className="h-5 w-5" aria-hidden="true" />
            {visual.title}
            {visual.status !== "stable" && (
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-950 dark:bg-amber-800 dark:text-amber-50">
                {visual.status}
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">{visual.description}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {hasSettings && (
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              aria-expanded={showSettings}
              aria-controls={`${instanceKey}-settings`}
              title="Settings"
              className="rounded p-1.5 hover:bg-muted"
            >
              <Settings2 className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={toggleFullscreen} title={fullscreen ? "Exit full screen" : "Full screen"} className="rounded p-1.5 hover:bg-muted">
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </header>
      {showSettings && hasSettings && (
        <div id={`${instanceKey}-settings`} className="mb-4 rounded border bg-muted/30 p-3">
          <SettingsPanel schema={visual.settings} values={settings} onChange={update} onReset={reset} idPrefix={instanceKey} />
        </div>
      )}
      <Component settings={settings} instanceKey={instanceKey} standalone={standalone} />
      {visual.about && visual.about.length > 0 && (
        <details className="mt-4 text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">About this visual</summary>
          <div className="mt-2 space-y-2">
            {visual.about.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/** Placeholder for loading / empty states, so every visual says the same thing the same way. */
export function VisualMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">{children}</div>;
}
