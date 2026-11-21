"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from 'next/navigation';
import { GlobalMenu } from "./GlobalMenu";
import { navItems } from "./navigationItems";

interface NavigationProps {
  children: React.ReactNode;
  blockHeight?: number | null;
}

export default function Navigation({ children }: NavigationProps) {
  const pathname = usePathname();
  
  return (
    <>
      <nav className="relative w-full z-10 bg-background">
        <div className="flex items-center justify-between gap-2 h-16 px-2 sm:px-4">
          {/* Left side - Navigation Links. Below xl the links show icons only; if they still don't fit, this row
              scrolls inside itself so the page never scrolls sideways. Only this row scrolls: the right-side
              controls stay outside it so their dropdowns aren't clipped. */}
          <div className="flex min-w-0 flex-1 space-x-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              // a page's own sub-paths too (/forks/<height>), but not every path under the home page
              const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
              
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    flex shrink-0 items-center gap-2 px-2 xl:px-3 py-2 rounded-md text-sm font-medium transition-colors
                    ${isActive 
                      ? 'nav-active' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }
                  `}
                  title={item.description}
                  aria-label={item.label}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden xl:inline">{item.label}</span>
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
