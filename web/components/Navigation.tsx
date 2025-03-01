"use client";

import { usePathname } from "next/navigation";
import { TableIcon } from "lucide-react";
import NavItem from "./NavItem";

export default function Navigation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  
  // Define routes and their active conditions
  const isTableActive = pathname === "/" || pathname === "/table";
  const isSankeyActive = pathname.startsWith("/sankey");

  return (
    <nav className="relative w-full z-10 bg-background">
      <div className="flex items-center justify-between h-16 px-4">
        <div className="flex items-center">
          <span className="text-foreground mr-3 text-sm font-medium font-mono">Visualizations:</span>
          <div className="flex items-center space-x-1">
            <NavItem 
              href="/"
              isActive={isTableActive}
              title="Table View"
              icon={<TableIcon className="h-5 w-5" />}
            />
            
            <NavItem
              isActive={isSankeyActive}
              title="Sankey Diagram (Coming Soon)"
              icon={
                <svg 
                  className="h-5 w-5" 
                  viewBox="0 0 32 32" 
                  fill="currentColor" 
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M30,2H2V16H8.1113a7.0359,7.0359,0,0,1,3.13.7393L15.7637,19l-4.522,2.2607A7.0359,7.0359,0,0,1,8.1113,22H2v8H9.2231a9.0446,9.0446,0,0,0,4.0249-.95L21.87,24.7393A7.0359,7.0359,0,0,1,25,24h5V14H25a7.0359,7.0359,0,0,1-3.13-.7393L15.3481,10H30ZM8,4H24V8H8ZM4,4H6V14H4ZM4,24H6v4H4Zm16.9751-1.05-8.6216,4.3105A7.0359,7.0359,0,0,1,9.2231,28H8V24h.1113a9.0446,9.0446,0,0,0,4.0249-.95L18,20.1182l1.8638.9316a9.0446,9.0446,0,0,0,4.0249.95H24v.0586A9.0515,9.0515,0,0,0,20.9751,22.95ZM28,22H26V16h2ZM12.3535,10.7393l8.6216,4.31A9.0515,9.0515,0,0,0,24,15.9414V20h-.1113a7.0359,7.0359,0,0,1-3.13-.7393l-8.6221-4.31A9.0446,9.0446,0,0,0,8.1113,14H8V10H9.2231A7.0359,7.0359,0,0,1,12.3535,10.7393ZM28,8H26V4h2Z" />
                </svg>
              }
              disabled={true}
              comingSoon={true}
            />
          </div>
        </div>
        <div className="flex items-center">{children}</div>
      </div>
    </nav>
  );
} 