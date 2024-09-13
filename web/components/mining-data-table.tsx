import React, { useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { renderCellContent } from '../utils/cell-content';

export function MiningDataTable({ miningData, columns, visibleColumns, sortConfig, onSort, maxMerkleBranches }) {
  const sortedMiningData = useMemo(() => {
    let sortableItems = [...miningData];
    const { key, direction } = sortConfig;
    if (key !== null) {
      sortableItems.sort((a, b) => {
        if (key === 'coinbase_output_value') {
          const aValue = a.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0);
          const bValue = b.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0);
          return direction === 'ascending' ? aValue - bValue : bValue - aValue;
        } else if (key.startsWith('merkle_branch_')) {
          const index = parseInt(key.split('_')[2]);
          const aValue = a.merkle_branches[index] || '';
          const bValue = b.merkle_branches[index] || '';
          return direction === 'ascending' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        } else {
          const aValue = a[key];
          const bValue = b[key];
          if (typeof aValue === 'string' && typeof bValue === 'string') {
            return direction === 'ascending' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
          }
          return direction === 'ascending' ? aValue - bValue : bValue - aValue;
        }
      });
    }
    return sortableItems;
  }, [miningData, sortConfig, maxMerkleBranches]);

  return (
    <Table className="w-full table-fixed">
      <TableHeader>
        <TableRow>
          {columns.filter(column => visibleColumns.has(column.key)).map((column, index) => (
            <TableHead 
              key={index} 
              className="cursor-pointer select-none relative"
              onClick={() => onSort(column.key)}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">{column.title}</span>
                {sortConfig.key === column.key && (
                  <span className="ml-1">
                    {sortConfig.direction === 'ascending' ? '▲' : '▼'}
                  </span>
                )}
              </div>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedMiningData.map((data) => (
          <TableRow key={data.pool_name}>
            {columns.filter(column => visibleColumns.has(column.key)).map((column, index) => {
              const content = renderCellContent(data, column);
              return (
                <TableCell
                  key={index} 
                  className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0"
                  style={column.key.startsWith('merkle_branch_') || column.key === 'coinbase_outputs' ? { backgroundColor: content.color, color: content.textColor } : {}}
                  title={content.tooltip}
                  data-merkle-branch={column.key.startsWith('merkle_branch_') ? true : undefined}
                >
                  {column.key === 'first_transaction' && content.value !== 'empty block' ? (
                    <a href={content.tooltip} target="_blank" rel="noopener noreferrer">
                      {content.value}
                    </a>
                  ) : (
                    content.value
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}