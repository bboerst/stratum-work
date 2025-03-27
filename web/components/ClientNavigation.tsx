"use client";

import React from "react";
import { usePathname } from "next/navigation";
import Navigation from "./Navigation";

interface ClientNavigationProps {
  children: React.ReactNode;
}

export default function ClientNavigation({ children }: ClientNavigationProps) {
  const pathname = usePathname();
  let blockHeight: number | null = null;
  
  // Check if we're on a height page
  if (pathname.startsWith("/height/")) {
    // Extract the height from the URL
    const heightStr = pathname.split("/").pop();
    if (heightStr) {
      blockHeight = parseInt(heightStr, 10);
    }
  } else if (pathname === "/") {
    // On home page, we're viewing the being-mined block
    blockHeight = -1;
  }
  
  return (
    <Navigation blockHeight={blockHeight}>
      {children}
    </Navigation>
  );
} 