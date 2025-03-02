"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

interface GlobalMenuContextType {
  menuContent: ReactNode | null;
  setMenuContent: (content: ReactNode | null) => void;
}

const GlobalMenuContext = createContext<GlobalMenuContextType | undefined>(undefined);

export function GlobalMenuProvider({ children }: { children: ReactNode }) {
  const [menuContent, setMenuContent] = useState<ReactNode | null>(null);

  return (
    <GlobalMenuContext.Provider value={{ menuContent, setMenuContent }}>
      {children}
    </GlobalMenuContext.Provider>
  );
}

export function useGlobalMenu() {
  const context = useContext(GlobalMenuContext);
  if (context === undefined) {
    throw new Error("useGlobalMenu must be used within a GlobalMenuProvider");
  }
  return context;
} 