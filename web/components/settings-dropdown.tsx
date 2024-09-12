import React from 'react';
import { Button } from "@/components/ui/button";
import { Settings, Sun, Moon } from 'lucide-react';

interface SettingsDropdownProps {
  columns: { title: string; key: string }[];
  visibleColumns: Set<string>;
  onToggleColumn: (key: string) => void;
  children: React.ReactNode;
}

export function SettingsDropdown({ columns, visibleColumns, onToggleColumn, children }: SettingsDropdownProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isDarkMode, setIsDarkMode] = React.useState(() => {
    if (typeof window !== 'undefined') {
      const storedTheme = localStorage.getItem('theme');
      return storedTheme === null || storedTheme === 'dark';
    }
    return true; // Default to dark mode
  });
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  React.useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  return (
    <div className="relative" ref={dropdownRef}>
      <div onClick={() => setIsOpen(!isOpen)}>
        {children}
      </div>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-gray-800 border border-gray-700 rounded-md shadow-lg z-10">
          <div className="p-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-white">Theme</span>
              <div className="flex space-x-2">
                <Sun
                  className={`cursor-pointer ${!isDarkMode ? 'text-yellow-500' : 'text-gray-400'}`}
                  onClick={() => setIsDarkMode(false)}
                />
                <Moon
                  className={`cursor-pointer ${isDarkMode ? 'text-blue-500' : 'text-gray-400'}`}
                  onClick={() => setIsDarkMode(true)}
                />
              </div>
            </div>
            <h3 className="text-sm font-semibold mb-2 text-white">Toggle Columns</h3>
            {columns.map((column) => (
              <label key={column.key} className="flex items-center space-x-2 mb-1">
                <input
                  type="checkbox"
                  checked={visibleColumns.has(column.key)}
                  onChange={() => onToggleColumn(column.key)}
                  className="form-checkbox"
                />
                <span className="text-sm text-white">{column.title}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}