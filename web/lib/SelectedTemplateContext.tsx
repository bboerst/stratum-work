'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { StratumV1Data } from './types';

interface SelectedTemplateContextType {
  selectedTemplate: StratumV1Data | null;
  setSelectedTemplate: (template: StratumV1Data | null) => void;
}

const SelectedTemplateContext = createContext<SelectedTemplateContextType | undefined>(undefined);

export function SelectedTemplateProvider({ children }: { children: ReactNode }) {
  const [selectedTemplate, setSelectedTemplate] = useState<StratumV1Data | null>(null);

  return (
    <SelectedTemplateContext.Provider value={{ selectedTemplate, setSelectedTemplate }}>
      {children}
    </SelectedTemplateContext.Provider>
  );
}

export function useSelectedTemplate() {
  const context = useContext(SelectedTemplateContext);
  if (context === undefined) {
    throw new Error('useSelectedTemplate must be used within a SelectedTemplateProvider');
  }
  return context;
}