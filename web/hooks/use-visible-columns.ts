import { useState, useEffect, useCallback } from 'react';

export function useVisibleColumns(initialColumns) {
  const [visibleColumns, setVisibleColumns] = useState(new Set());
  const [columns, setColumns] = useState(initialColumns);

  useEffect(() => {
    const defaultVisibleColumns = new Set(columns.map(col => col.key));
    const hiddenColumns = [
      "prev_block_hash",
      "block_version",
      "coinbase_raw",
      "version",
      "nbits",
      "ntime"
    ];
    hiddenColumns.forEach(col => defaultVisibleColumns.delete(col));

    const storedVisibleColumns = localStorage.getItem('visibleColumns');
    if (storedVisibleColumns) {
      setVisibleColumns(new Set(JSON.parse(storedVisibleColumns)));
    } else {
      setVisibleColumns(defaultVisibleColumns);
    }
  }, [columns]);

  const handleToggleColumn = useCallback((key) => {
    setVisibleColumns(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      localStorage.setItem('visibleColumns', JSON.stringify(Array.from(newSet)));
      return newSet;
    });
  }, []);

  return { visibleColumns, handleToggleColumn, setColumns };
}