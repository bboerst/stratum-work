document.addEventListener('DOMContentLoaded', () => {
  const socket = io(SOCKET_URL);
  let isPaused = false;

  const pauseButton = document.getElementById('pause-button');
  const resumeButton = document.getElementById('resume-button');

  pauseButton.addEventListener('click', () => {
    isPaused = true;
    pauseButton.style.display = 'none';
    resumeButton.style.display = 'inline-block';
    resumeButton.classList.add('flashing-border');
  });

  resumeButton.addEventListener('click', () => {
    isPaused = false;
    resumeButton.style.display = 'none';
    resumeButton.classList.remove('flashing-border');
    pauseButton.style.display = 'inline-block';
    // Fetch the latest data when resuming
    socket.emit('request_latest_data');
  });

  const savedColumnVisibility = JSON.parse(localStorage.getItem('columnVisibility')) || {};
  let blockHeights = [];

  const table = new Tabulator('#mining-table', {
    index: 'pool_name',
    layout: 'fitColumns',
    movableColumns: true,
    resizableColumns: true,
    columns: getTableColumns(),
    initialSort: [{ column: 'coinbase_output_value', dir: 'desc' }],
  });

  table.on('tableBuilt', () => {
    applyColumnVisibility();
    createColumnToggles();
  });

  socket.on('mining_data', async (data) => {
    if (!isPaused) {
      await updateTableData(data);
      updateBlockHeights(data.height);
    }
  });

  function getTableColumns() {
    return [
      {
        title: 'Pool Name',
        field: 'pool_name',
        width: 130,
      },
      {
        title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/timestamp.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Timestamp',
        field: 'timestamp',
        sorter: function (a, b, aRow, bRow, column, dir, sorterParams) {
          const timestampA = new Date(a).getTime();
          const timestampB = new Date(b).getTime();
          return timestampA - timestampB;
        },
        formatter: formatTimestamp,
      },
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/height.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Height', field: 'height' },
      { title: 'Previous Block Hash', field: 'prev_block_hash' },
      { title: 'Block Version', field: 'block_version' },
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/coinbase_raw.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Coinbase RAW', field: 'coinbase_raw' },
      { title: 'Version', field: 'version' },
      { title: 'Nbits', field: 'nbits' },
      { title: 'Ntime', field: 'ntime', formatter: formatNtimeTimestamp },
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/coinbase_script_ascii.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Coinbase Script (ASCII)', field: 'coinbase_script_ascii' },
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/clean_jobs.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Clean Jobs', field: 'clean_jobs' },
      {
        title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/coinbase_outputs.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Coinbase Outputs',
        field: 'coinbase_outputs',
        formatter: function(cell, formatterParams, onRendered) {
          const outputs = cell.getValue();
          if (Array.isArray(outputs)) {
            const formattedOutputs = outputs
              .filter(output => !output.address.includes("nulldata"))
              .map(output => `${output.address}:${output.value}`)
              .join('|');
            
            const color = generateColorFromOutputs(outputs);
            cell.getElement().style.backgroundColor = color;
            cell.getElement().style.whiteSpace = 'nowrap';
            cell.getElement().style.overflow = 'hidden';
            cell.getElement().style.textOverflow = 'ellipsis';
            cell.getElement().title = formattedOutputs;
            return formattedOutputs;
          }
          return '';
        },
        sorter: function(a, b, aRow, bRow, column, dir, sorterParams) {
          const aOutputs = a ? a.filter(output => !output.address.includes("nulldata")).map(output => `${output.address}:${output.value}`).join('|') : '';
          const bOutputs = b ? b.filter(output => !output.address.includes("nulldata")).map(output => `${output.address}:${output.value}`).join('|') : '';
          return aOutputs.localeCompare(bOutputs);
        },
        resizable: true,
      },
      {
        title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/merkle_branches.md#first-transaction-after-coinbase" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->First Tx',
        field: 'first_transaction',
        formatter: function (cell, formatterParams, onRendered) {
          const value = cell.getValue();
          if (value !== 'empty block') {
            return `<a href="https://mempool.space/tx/${value}" class="transaction-link" target="_blank">${value}</a>`;
          } else {
            return value;
          }
        }
      },
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/merkle_branches.md#first-transaction-after-coinbase" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->First Tx Fee Rate (sat/vB)', field: 'fee_rate' },
      ...getMerkleBranchColumns(),
      { title: '<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/coinbase_output_value.md" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Coinbase Output Value', field: 'coinbase_output_value' },
    ];
  }

  function formatTimestamp(cell) {
    const timestamp = cell.getValue();
    let date;
    if (typeof timestamp === 'object' && timestamp.$date) {
      date = new Date(timestamp.$date);
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else {
      date = new Date(timestamp);
    }
    return `${padZero(date.getUTCHours())}:${padZero(date.getUTCMinutes())}:${padZero(date.getUTCSeconds())}`;
  }

  function formatNtimeTimestamp(cell) {
    const ntimeHex = cell.getValue();
    const ntimeInt = parseInt(ntimeHex, 16);
    const date = new Date(ntimeInt * 1000);
    return formatTimestamp({ getValue: () => date });
  }

  function padZero(value) {
    return value.toString().padStart(2, '0');
  }

  function getMerkleBranchColumns() {
    const merkleBranchColumns = [];
    for (let i = 0; i < 13; i++) {
      merkleBranchColumns.push({
        title: `<!--<a href="https://github.com/bboerst/stratum-work/blob/main/docs/merkle_branches.md#merkle-tree" target="_blank"><i class="fas fa-question-circle"></i></a><br /> -->Merkle Branch ${i}`,
        field: 'merkle_branches',
        formatter: merkleBranchFormatter(i),
      });
    }
    return merkleBranchColumns;
  }

  function merkleBranchFormatter(index) {
    return (cell) => {
      const merkleBranches = cell.getValue();
      const colors = cell.getRow().getData().merkle_branch_colors;
      if (!merkleBranches) return '';
      const value = merkleBranches[index] || '';
      cell.getElement().style.backgroundColor = colors[index] || 'white';
      cell.getElement().style.color = 'black';
      cell.getElement().style.borderColor = colors[index];
      return `${value}`;
    };
  }

  async function updateTableData(data) {
    const currentSorters = table.getSorters();
    const maxBlockHeight = Math.max(...blockHeights);

    // Remove the loading message when the first row is added
    if (table.getDataCount() === 0) {
      const loadingMessage = document.getElementById('loading-message');
      loadingMessage.style.display = 'none';
    }

    // Filter out data that is more than 3 blocks behind the latest block height, probably stale
    if (data.height >= maxBlockHeight - 2) {
      const poolName = data.pool_name;

      // Delete the existing row with the same pool_name
      const existingRow = table.getRow(poolName);
      if (existingRow) {
        table.deleteRow(existingRow);
      }

      // Add the new row
      table.addData(data)
        .catch(function (error) {
          console.error("Error adding table data: ", error);
        });

      if (currentSorters.length > 0) {
        table.setSort(currentSorters);
      }
    }
  }

  function createColumnToggles() {
    const columnToggles = document.getElementById('column-toggles');
    columnToggles.innerHTML = '';
    table.getColumns().forEach((column) => {
      const field = column.getField();
      const toggleDiv = document.createElement('div');
      const toggleLabel = document.createElement('label');
      const toggleCheckbox = document.createElement('input');
      toggleCheckbox.type = 'checkbox';
      toggleCheckbox.checked = savedColumnVisibility[field] !== false;
      toggleCheckbox.addEventListener('change', () => {
        const isVisible = toggleCheckbox.checked;
        isVisible ? table.showColumn(field) : table.hideColumn(field);
        savedColumnVisibility[field] = isVisible;
        localStorage.setItem('columnVisibility', JSON.stringify(savedColumnVisibility));
      });
      toggleLabel.appendChild(toggleCheckbox);

      // Extract the text content of the column title
      const columnTitle = column.getDefinition().title;
      const tempElement = document.createElement('div');
      tempElement.innerHTML = columnTitle;
      const columnTitleText = tempElement.textContent;

      toggleLabel.appendChild(document.createTextNode(columnTitleText));
      toggleDiv.appendChild(toggleLabel);
      columnToggles.appendChild(toggleDiv);
    });
  }

  function applyColumnVisibility() {
    Object.entries(savedColumnVisibility).forEach(([field, isVisible]) => {
      if (!isVisible) table.hideColumn(field);
    });
  }

  function updateBlockHeights(blockHeight) {
    if (!blockHeights.includes(blockHeight)) {
      blockHeights.push(blockHeight);
    }
  }

  const settingsIcon = document.querySelector('.settings-icon');
  const configSection = document.getElementById('config-section');
  settingsIcon.addEventListener('click', () => {
    configSection.classList.toggle('show');
    createColumnToggles();
  });

  document.addEventListener('click', (event) => {
    const { target } = event;
    if (!configSection.contains(target) && !settingsIcon.contains(target)) {
      configSection.classList.remove('show');
    }
  });

  table.on('tableBuilt', () => {
    applyColumnVisibility();
    createColumnToggles();

    const themeToggle = document.getElementById('theme-toggle');
    const body = document.body;
    const tabulatorElement = document.querySelector('.tabulator');
    const faQuestionCircle = document.querySelector('.fa-question-circle');
    const fas = document.querySelector('.fas');

    // Check for saved theme preference
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      body.classList.add('dark-mode');
      tabulatorElement.classList.add('dark-mode');
      fas.classList.add('dark-mode');
    } else {
      body.classList.remove('dark-mode');
      tabulatorElement.classList.remove('dark-mode');
      fas.classList.remove('dark-mode');
    }

    themeToggle.addEventListener('click', () => {
      body.classList.toggle('dark-mode');
      tabulatorElement.classList.toggle('dark-mode');
      const isDarkMode = body.classList.contains('dark-mode');
      localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    });
  });

  function generateColorFromOutputs(outputs) {
    const addressString = outputs
      .filter(output => !output.address.includes('nulldata'))
      .map(output => output.address)
      .join('|');
    const hue = Math.abs(hash_code(addressString) % 360);
    const saturation = 70 + (hash_code(addressString) % 30); // 70-100%
    const lightness = 80 + (hash_code(addressString) % 20); // 80-100%
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  function hash_code(text) {
    return text.split('').reduce((prevHash, currVal) =>
      (((prevHash << 5) - prevHash) + currVal.charCodeAt(0))|0, 0);
  }
});