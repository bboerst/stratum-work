"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from 'next/navigation';
import { Table, Workflow, ScatterChart } from "lucide-react";
import { GlobalMenu } from "./GlobalMenu";

interface NavigationProps {
  children: React.ReactNode;
  blockHeight?: number | null;
}

export default function Navigation({ children }: NavigationProps) {
  const pathname = usePathname();

  const navItems = [
    {
      href: "/",
      label: "Table",
      icon: Table,
      description: "Main view with table and timing chart"
    },
    {
      href: "/timing",
      label: "Timing",
      icon: ScatterChart,
      description: "Full screen pool timing visualization"
    },
    {
      href: "/sankey",
      label: "Sankey",
      icon: Workflow,
      description: "Sankey diagram visualization"
    }
  ];
  
  return (
    <>
      <nav className="relative w-full z-10 bg-background">
        <div className="flex items-center justify-between h-16 px-4">
          {/* Left side - Navigation Links */}
          <div className="flex space-x-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors
                    ${isActive 
                      ? 'nav-active' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }
                  `}
                  title={item.description}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Right side - Page-specific controls via GlobalMenu */}
          <GlobalMenu />
        </div>
      </nav>
      {children}
    </>
  );
}