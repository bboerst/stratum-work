"use client";

import { usePathname } from 'next/navigation';
import VisualizationToggle from "./VisualizationToggle";

interface NavigationProps {
  children: React.ReactNode;
  blockHeight?: number | null;
}

export default function Navigation({ children, blockHeight }: NavigationProps) {
  const pathname = usePathname();
  const isTemplatePage = pathname?.startsWith('/template/') ?? false;
  
  return (
    <nav className="relative w-full z-10 bg-background">
      <div className="flex items-center justify-end h-16 px-4">
        <div className="flex items-center space-x-2">
          <VisualizationToggle blockHeight={blockHeight} isTemplatePage={isTemplatePage} />
          {children}
        </div>
      </div>
    </nav>
  );
} 