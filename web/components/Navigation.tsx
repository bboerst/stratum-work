"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from 'next/navigation';
import { Table, Workflow, ScatterChart } from "lucide-react";
import { GlobalMenu } from "./GlobalMenu";

// TableIcon component
const TableIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M3 3h18v18H3z" />
    <path d="M3 9h18" />
    <path d="M3 15h18" />
    <path d="M9 3v18" />
    <path d="M15 3v18" />
  </svg>
);

// NavItem component
interface NavItemProps {
  href: string;
  isActive: boolean;
  title: string;
  icon: React.ReactNode;
}

const NavItem = ({ href, isActive, title, icon }: NavItemProps) => (
  <Link 
    href={href}
    className={`flex items-center px-3 py-2 rounded-md text-sm ${
      isActive
        ? 'bg-accent text-accent-foreground'
        : 'hover:bg-accent hover:text-accent-foreground'
    }`}
    aria-current={isActive ? 'page' : undefined}
  >
    {icon}
    <span className="ml-2">{title}</span>
  </Link>
);

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