"use client";
import React from "react";
import Blocks from "./Blocks";
export default function Header() {
  return (
    <header className="flex items-center justify-between p-4 bg-white shadow">
      <div className="flex items-center">
        <Blocks />
      </div>
      <nav>
        <ul className="flex space-x-4">
          <li>
            <a href="/" className="text-blue-500">
              Home
            </a>
          </li>
          <li>
            <a href="/about" className="text-blue-500">
              About
            </a>
          </li>
          <li>
            <a href="/contact" className="text-blue-500">
              Contact
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}