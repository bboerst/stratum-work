document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const { bitcoin: { transactions } } = mempoolJS({ hostname: 'mempool.space' });
  const transactionCache = new Map();
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

  const liveTab = document.getElementById('live-tab');
  const historicalTab = document.getElementById('historical-tab');
  const historicalSelector = document.getElementById('historical-selector');
  const historicalSelect = document.getElementById('historical-select');

  // liveTab.addEventListener('click', () => {
  //   toggleTab(liveTab, historicalTab);
  //   historicalSelector.style.display = 'none';
  //   socket.connect();
  //   table.clearData();
  // });

  // historicalTab.addEventListener('click', () => {
  //   toggleTab(historicalTab, liveTab);
  //   historicalSelector.style.display = 'block';
  //   socket.disconnect();
  // });

  // historicalSelect.addEventListener('change', async () => {
  //   const selectedBlockHeight = parseInt(historicalSelect.value);
  //   await loadAndUpdateData(selectedBlockHeight);
  // });

  socket.on('mining_data', async (data) => {
    await updateTableData(data);
    updateBlockHeights(data.height);
  });

  setInterval(refreshTransactionCache, 20000);

  function getTableColumns() {
    return [
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/pool_name.md" target="_blank"><i class="fas fa-question-circle"></i></a> Pool Name', field: 'pool_name' },
      {
        title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/timestamp.md" target="_blank"><i class="fas fa-question-circle"></i></a> Timestamp',
        field: 'timestamp',
        formatter: formatTimestamp,
        sorter: function(a, b, aRow, bRow, column, dir, sorterParams) {
          const timestampA = new Date(a).getTime();
          const timestampB = new Date(b).getTime();
          return timestampA - timestampB;
        }
      },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/height.md" target="_blank"><i class="fas fa-question-circle"></i></a> Height', field: 'height' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/prev_block_hash.md" target="_blank"><i class="fas fa-question-circle"></i></a> Previous Block Hash', field: 'prev_block_hash' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/block_version.md" target="_blank"><i class="fas fa-question-circle"></i></a> Block Version', field: 'block_version' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/coinbase_raw.md" target="_blank"><i class="fas fa-question-circle"></i></a> Coinbase RAW', field: 'coinbase_raw' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/version.md" target="_blank"><i class="fas fa-question-circle"></i></a> Version', field: 'version' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/nbits.md" target="_blank"><i class="fas fa-question-circle"></i></a> Nbits', field: 'nbits' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/ntime.md" target="_blank"><i class="fas fa-question-circle"></i></a> Ntime', field: 'ntime', formatter: formatNtimeTimestamp },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/coinbase_script_ascii.md" target="_blank"><i class="fas fa-question-circle"></i></a> Coinbase Script (ASCII)', field: 'coinbase_script_ascii', formatter: extractCoinbaseScriptAscii },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/clean_jobs.md" target="_blank"><i class="fas fa-question-circle"></i></a> Clean Jobs', field: 'clean_jobs' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/first_transaction.md" target="_blank"><i class="fas fa-question-circle"></i></a> First Tx', field: 'first_transaction' },
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/fee_rate.md" target="_blank"><i class="fas fa-question-circle"></i></a> First Tx Fee Rate (sat/vB)', field: 'fee_rate' },
      ...getMerkleBranchColumns(),
      { title: '<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/coinbase_output_value.md" target="_blank"><i class="fas fa-question-circle"></i></a> Coinbase Output Value', field: 'coinbase_output_value' },
    ];
  }

  function getMerkleBranchColumns() {
    const merkleBranchColumns = [];
    for (let i = 0; i < 12; i++) {
      merkleBranchColumns.push({
        title: `<a href="https://github.com/bboerst/stratum-logger/blob/main/docs/merkle_branches.md" target="_blank"><i class="fas fa-question-circle"></i></a> Merkle Branch ${i}`,
        field: 'merkle_branches',
        formatter: merkleBranchFormatter(i),
      });
    }
    return merkleBranchColumns;
  }

  function merkleBranchFormatter(index) {
    return (cell) => {
      const merkleBranches = cell.getValue();
      if (!merkleBranches) return '';
      const value = merkleBranches[index] || '';
      const color = getColorFromHex(value);
      cell.getElement().style.backgroundColor = color;
      return `${value}`;
    };
  }

  async function processRowData(row) {
    const { coinbase1, coinbase2, extranonce1, extranonce2_length, prev_hash, version, merkle_branches } = row;
    const coinbaseHex = coinbase1 + extranonce1 + '00'.repeat(extranonce2_length) + coinbase2;
    const coinbaseTx = bitcoin.Transaction.fromHex(coinbaseHex);
    const height = bitcoin.script.number.decode(coinbaseTx.ins[0].script.slice(1, 4), 'little');
    const outputValue = coinbaseTx.outs.reduce((acc, out) => acc + out.value, 0) / 1e8;
    row.coinbase_output_value = outputValue;
    row.coinbase_raw = coinbaseHex;
    row.height = row.height || height;
    row.prev_block_hash = getPrevBlockHash(prev_hash);
    row.block_version = parseInt(version, 16);
    row.first_transaction = merkle_branches.length > 0 ? merkle_branches[0].match(/../g).reverse().join('') : 'empty block';
    row.fee_rate = 'Loading...';
    return row;
  }

  async function fetchTransactionFeeWeight(txid) {
    if (transactionCache.has(txid)) return transactionCache.get(txid);

    try {
      const { fee, weight } = await transactions.getTx({ txid });
      transactionCache.set(txid, { fee, weight });
      return { fee, weight };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        transactionCache.set(txid, 'not_exist');
        return 'not_exist';
      }
      console.error(`Error fetching transaction details for ${txid}:`, error);
      return 'error';
    }
  }

  async function updateTableData(data) {
    const filteredData = (Array.isArray(data) ? data : [data]).filter((row) => row !== undefined && row !== null);
    const processedData = await Promise.all(filteredData.map(processRowData));

    const existingData = table.getData();
    const updatedData = existingData.map((existingRow) => {
      const processedRow = processedData.find((row) => row.pool_name === existingRow.pool_name);
      return processedRow || existingRow;
    });

    const newData = processedData.filter((newRow) => !existingData.some((existingRow) => existingRow.pool_name === newRow.pool_name));

    // Fetch transaction fee rates for all data
    await Promise.all(processedData.map(async (row) => {
      const feeRate = await getTransactionFeeRate(row.first_transaction);
      row.fee_rate = feeRate;
    }));

    table.replaceData([...updatedData, ...newData]);
  }

  function refreshTransactionCache() {
    transactionCache.clear();
  }

  function populateBlockHeightsDropdown() {
    const latestBlockHeight = Math.max(...blockHeights);
    const startBlockHeight = Math.max(0, latestBlockHeight - 100);
    historicalSelect.innerHTML = '';
    for (let i = latestBlockHeight; i >= startBlockHeight; i--) {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = i;
      historicalSelect.appendChild(option);
    }
  }

  async function loadAndUpdateData(blockHeight) {
    try {
      const response = await fetch(`/data?block_height=${blockHeight}`);
      const selectedBlockHeight = await response.json();
      if (selectedBlockHeight.length === 0) {
        console.warn('No data found for the selected block height');
        return;
      }
      await updateTableData(selectedBlockHeight);
    } catch (error) {
      console.error('Error loading and updating data:', error);
    }
  }

  function updateBlockHeights(blockHeight) {
    if (!blockHeights.includes(blockHeight)) {
      blockHeights.push(blockHeight);
      populateBlockHeightsDropdown();
    }
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
    return `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`;
  }

  function formatNtimeTimestamp(cell) {
    const ntimeInt = parseInt(cell.getValue(), 16);
    const date = new Date(ntimeInt * 1000);
    return `${padZero(date.getUTCHours())}:${padZero(date.getUTCMinutes())}:${padZero(date.getUTCSeconds())}`;
  }

  function extractCoinbaseScriptAscii(cell) {
    const coinbaseHex = cell.getRow().getData().coinbase_raw;
    const coinbaseTx = bitcoin.Transaction.fromHex(coinbaseHex);
    const scriptHex = coinbaseTx.ins[0].script.toString('hex');
    return hex2ascii(scriptHex).replace(/[^\x20-\x7E]/g, '');
  }

  function getPrevBlockHash(prev_hash) {
    const prevBhStratum = Array.from({ length: 8 }, (_, i) => parseInt(prev_hash.substr(i * 8, 8), 16));
    return prevBhStratum.slice(6).reverse().map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  async function getTransactionFeeRate(firstTransaction) {
    if (firstTransaction === 'empty block') return 'Empty Block';

    if (transactionCache.has(firstTransaction)) {
      const cachedResult = transactionCache.get(firstTransaction);
      if (cachedResult === 'not_exist') return 'Not Exist';
      if (cachedResult === 'error') return 'Error';
      return calculateFeeRate(cachedResult.fee, cachedResult.weight);
    }

    const result = await fetchTransactionFeeWeight(firstTransaction);
    if (result === 'not_exist') return 'Not Exist';
    if (result === 'error') return 'Error';

    const { fee, weight } = result;
    if (fee !== null && weight !== null) {
      return calculateFeeRate(fee, weight);
    } else {
      return 'Not Found';
    }
  }

  function calculateFeeRate(fee, weight) {
    const virtualSize = weight / 4;
    const feeRate = Math.round(fee / virtualSize);
    return feeRate;
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
      toggleLabel.appendChild(document.createTextNode(column.getDefinition().title));
      toggleDiv.appendChild(toggleLabel);
      columnToggles.appendChild(toggleDiv);
    });
  }

  function applyColumnVisibility() {
    Object.entries(savedColumnVisibility).forEach(([field, isVisible]) => {
      if (!isVisible) table.hideColumn(field);
    });
  }

  function toggleTab(activeTab, inactiveTab) {
    activeTab.classList.add('active');
    inactiveTab.classList.remove('active');
  }

  function getColorFromHex(hexValue) {
    if (!hexValue) return 'white';
    const hash = hashCode(hexValue);
    const hue = Math.abs(hash % 360);
    const lightness = 60 + (hash % 25);
    return `hsl(${hue}, 100%, ${lightness}%)`;
  }

  function hashCode(str) {
    return str.split('').reduce((hash, char) => char.charCodeAt(0) + ((hash << 5) - hash), 0);
  }

  function hex2ascii(hex) {
    return hex.match(/.{2}/g).reduce((str, chunk) => str + String.fromCharCode(parseInt(chunk, 16)), '');
  }

  function padZero(value) {
    return value.toString().padStart(2, '0');
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
});
