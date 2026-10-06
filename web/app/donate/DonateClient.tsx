"use client";
import React, { useState } from 'react';
import { ScopeProvider } from '@/lib/templates/ScopeProvider';
import { RoutingPanel } from '@/visuals/RoutingPanel';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={copy} className="rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// The live store is shared: this provider reuses the page-wide live source mounted by DataStreamProvider.
export default function DonateClient() {
  return (
    <ScopeProvider scope={{ kind: 'live' }}>
      <RoutingPanel />
    </ScopeProvider>
  );
}
