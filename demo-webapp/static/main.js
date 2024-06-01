document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
  
    // Load saved column visibility from localStorage
    const savedColumnVisibility = JSON.parse(localStorage.getItem('columnVisibility')) || {};
  
    // Table column configuration
    const tableColumns = [
      { title: 'Pool Name', field: 'pool_name' },
      {
        title: 'Timestamp',
        field: 'timestamp',
        formatter: function (cell, formatterParams, onRendered) {
          const timestamp = cell.getValue().$date;
          const date = new Date(timestamp);
          const formattedTimestamp = `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`;
          return formattedTimestamp;
        }
      },
      { title: 'Height', field: 'height' },
      { title: 'Previous Block Hash', field: 'prev_block_hash' },
      { title: 'Block Version', field: 'block_version' },
      { title: 'Coinbase RAW', field: 'coinbase_raw' },
      { title: 'Version', field: 'version' },
      { title: 'Nbits', field: 'nbits' },
      {
        title: 'Ntime',
        field: 'ntime',
        formatter: function (cell, formatterParams, onRendered) {
          const ntimeHex = cell.getValue();
          const ntimeInt = parseInt(ntimeHex, 16);
          const date = new Date(ntimeInt * 1000);
          const formattedTime = `${padZero(date.getUTCHours())}:${padZero(date.getUTCMinutes())}:${padZero(date.getUTCSeconds())}`;
          return formattedTime;
        }
      },
      {
        title: 'Coinbase Script (ASCII)',
        field: 'coinbase_script_ascii',
        formatter: function (cell, formatterParams, onRendered) {
          const coinbaseHex = cell.getRow().getData().coinbase_raw;
          const coinbaseTx = bitcoin.Transaction.fromHex(coinbaseHex);
          const scriptHex = coinbaseTx.ins[0].script.toString('hex');
          const scriptAscii = hex2ascii(scriptHex).replace(/[^\x20-\x7E]/g, '');
          return scriptAscii;
        }
      },
      { title: 'Clean Jobs', field: 'clean_jobs' },
      { title: 'First Tx', field: 'first_transaction' },
      { title: 'First Tx Fee Rate (sat/vB)', field: 'fee_rate' },
      { title: 'Merkle Branch 0', field: 'merkle_branches', formatter: merkleBranchFormatter(0) },
      { title: 'Merkle Branch 1', field: 'merkle_branches', formatter: merkleBranchFormatter(1) },
      { title: 'Merkle Branch 2', field: 'merkle_branches', formatter: merkleBranchFormatter(2) },
      { title: 'Merkle Branch 3', field: 'merkle_branches', formatter: merkleBranchFormatter(3) },
      { title: 'Merkle Branch 4', field: 'merkle_branches', formatter: merkleBranchFormatter(4) },
      { title: 'Merkle Branch 5', field: 'merkle_branches', formatter: merkleBranchFormatter(5) },
      { title: 'Merkle Branch 6', field: 'merkle_branches', formatter: merkleBranchFormatter(6) },
      { title: 'Merkle Branch 7', field: 'merkle_branches', formatter: merkleBranchFormatter(7) },
      { title: 'Merkle Branch 8', field: 'merkle_branches', formatter: merkleBranchFormatter(8) },
      { title: 'Merkle Branch 9', field: 'merkle_branches', formatter: merkleBranchFormatter(9) },
      { title: 'Merkle Branch 10', field: 'merkle_branches', formatter: merkleBranchFormatter(10) },
      { title: 'Merkle Branch 11', field: 'merkle_branches', formatter: merkleBranchFormatter(11) },
      { title: 'Coinbase Output Value', field: 'coinbase_output_value' },
    ];
  
    // Create the table
    const table = new Tabulator('#mining-table', {
      index: 'pool_name',
      layout: 'fitColumns',
      movableColumns: true,
      resizableColumns: true,
      columns: tableColumns,
      initialSort: [{ column: 'coinbase_output_value', dir: 'desc' }],
    });
  
    // Create column toggles
    function createColumnToggles() {
      const columnToggles = document.getElementById('column-toggles');
      columnToggles.innerHTML = ''; // Clear existing toggles
  
      table.getColumns().forEach(column => {
        const field = column.getField();
        const toggleDiv = document.createElement('div');
        const toggleLabel = document.createElement('label');
        const toggleCheckbox = document.createElement('input');
        toggleCheckbox.type = 'checkbox';
        toggleCheckbox.checked = savedColumnVisibility[field] !== false;
        toggleCheckbox.addEventListener('change', () => {
          const isVisible = toggleCheckbox.checked;
          if (isVisible) {
            table.showColumn(field);
          } else {
            table.hideColumn(field);
          }
          savedColumnVisibility[field] = isVisible;
          localStorage.setItem('columnVisibility', JSON.stringify(savedColumnVisibility));
        });
        toggleLabel.appendChild(toggleCheckbox);
        toggleLabel.appendChild(document.createTextNode(column.getDefinition().title));
        toggleDiv.appendChild(toggleLabel);
        columnToggles.appendChild(toggleDiv);
      });
    }
  
    // Set initial column visibility based on saved settings after table is built
    table.on('tableBuilt', function () {
      Object.entries(savedColumnVisibility).forEach(([field, isVisible]) => {
        if (!isVisible) {
          table.hideColumn(field);
        }
      });
      createColumnToggles();
    });
  
    // Handle settings cog click event
    const settingsIcon = document.querySelector('.settings-icon');
    const configSection = document.getElementById('config-section');
    settingsIcon.addEventListener('click', () => {
      configSection.classList.toggle('show');
      createColumnToggles();
    });
  
    // Hide config section when clicking outside of it
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!configSection.contains(target) && !settingsIcon.contains(target)) {
        configSection.classList.remove('show');
      }
    });
  
    const { bitcoin: { transactions } } = mempoolJS({
      hostname: 'mempool.space'
    });
  
    const transactionCache = new Map();
  
    // Function to process a single row of data
    function processRowData(row) {
      const { coinbase1, coinbase2, extranonce1, extranonce2_length, prev_hash, version } = row;
      const coinbaseHex = coinbase1 + extranonce1 + '00'.repeat(extranonce2_length) + coinbase2;
      const coinbaseTx = bitcoin.Transaction.fromHex(coinbaseHex);
      const height = bitcoin.script.number.decode(coinbaseTx.ins[0].script.slice(1, 4), 'little');
      const outputValue = coinbaseTx.outs.reduce((acc, out) => acc + out.value, 0) / 1e8;
      row.coinbase_output_value = outputValue;
      row.coinbase_raw = coinbaseHex;
      row.height = height;
  
      // Extract previous block hash
      const prevBhStratum = [];
      for (let i = 0; i < 8; i++) {
        prevBhStratum.push(parseInt(prev_hash.substr(i * 8, 8), 16));
      }
      const prevBh = [
        prevBhStratum[7],
        prevBhStratum[6],
        prevBhStratum[5],
        prevBhStratum[4],
        prevBhStratum[3],
        prevBhStratum[2],
        prevBhStratum[1],
        prevBhStratum[0]
      ];
      row.prev_block_hash = prevBh.map(x => x.toString(16).padStart(8, '0')).join('');
  
      // Extract block version
      const blockVer = parseInt(version, 16);
      row.block_version = blockVer;
  
      return row;
    }
  
    // Function to fetch transaction fee and weight
    async function fetchTransactionFeeWeight(txid) {
      if (transactionCache.has(txid)) {
        return transactionCache.get(txid);
      }
  
      try {
        const tx = await transactions.getTx({ txid });
        const { fee, weight } = tx;
        transactionCache.set(txid, { fee, weight });
        return { fee, weight };
      } catch (error) {
        if (error.response && error.response.status === 404) {
          transactionCache.set(txid, 'not_exist');
          return 'not_exist';
        } else {
          console.error(`Error fetching transaction details for ${txid}:`, error);
          return 'error';
        }
      }
    }
  
    // Function to update the table data
    async function updateTableData(data) {
      if (!Array.isArray(data)) {
        data = [data];
      }
  
      const processedData = await Promise.all(
        data.map(async row => {
          const processedRow = processRowData(row);
          const merkleBranches = row.merkle_branches;
          if (merkleBranches.length > 0) {
            const firstTxBytes = merkleBranches[0].match(/../g).reverse();
            processedRow.first_transaction = firstTxBytes.join('');
          } else {
            processedRow.first_transaction = 'empty block';
          }
  
          const firstTransaction = processedRow.first_transaction;
          if (firstTransaction !== 'empty block') {
            const result = await fetchTransactionFeeWeight(firstTransaction);
            if (result === 'not_exist') {
              processedRow.fee_rate = 'Not Exist';
            } else if (result === 'error') {
              processedRow.fee_rate = 'Error';
            } else {
              const { fee, weight } = result;
              if (fee !== null && weight !== null) {
                const virtualSize = weight / 4;
                const feeRate = Math.round(fee / virtualSize);
                processedRow.fee_rate = feeRate;
              } else {
                processedRow.fee_rate = 'Not Found';
              }
            }
          } else {
            processedRow.fee_rate = 'Empty Block';
          }
  
          return processedRow;
        })
      );
  
      const existingData = table.getData();
      const updatedData = existingData.map(existingRow => {
        const newRow = processedData.find(row => row.pool_name === existingRow.pool_name);
        return newRow || existingRow;
      });
  
      table.replaceData(updatedData);
  
      const newData = processedData.filter(
        newRow => !existingData.some(existingRow => existingRow.pool_name === newRow.pool_name)
      );
      table.addData(newData);
    }
  
    function refreshTransactionCache() {
      transactionCache.clear();
    }
  
    setInterval(refreshTransactionCache, 20000);
  
    const viewSelector = document.getElementById('view-select');
    const datetimeSelector = document.getElementById('datetime-selector');
    const datetimeInput = document.getElementById('datetime-input');
    const loadDataButton = document.getElementById('load-datetime-data');
  
    // Event listener for view selector
    viewSelector.addEventListener('change', () => {
      if (viewSelector.value === 'live') {
        datetimeSelector.style.display = 'none';
        socket.connect();
      } else {
        datetimeSelector.style.display = 'block';
        socket.disconnect();
      }
    });
  
    // Event listener for loading historical data
    loadDataButton.addEventListener('click', async () => {
      const selectedDateTime = new Date(datetimeInput.value);
      const timestamp = selectedDateTime.getTime();
  
      try {
        const response = await fetch(`/data?timestamp=${timestamp}`);
        const data = await response.json();
        await updateTableData(data);
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    });
  
    // Socket event listener for live data
    socket.on('mining_data', async data => {
      await updateTableData(data);
    });
  
    function merkleBranchFormatter(index) {
      return function (cell, formatterParams, onRendered) {
        const merkleBranches = cell.getValue();
        if (!merkleBranches) {
          return '';
        }
        const value = merkleBranches[index] || '';
        const color = getColorFromHex(value);
        cell.getElement().style.backgroundColor = color;
        return `${value}`;
      };
    }
  
    function padZero(value) {
      return value.toString().padStart(2, '0');
    }
  
    function getColorFromHex(hexValue) {
      if (!hexValue) return 'white';
  
      const hash = hashCode(hexValue);
      const hue = Math.abs(hash % 360);
      const lightness = 60 + (hash % 25); // Lightness values between 25% and 75%
  
      return `hsl(${hue}, 100%, ${lightness}%)`;
    }
  
    function hashCode(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      return hash;
    }
  
    function hex2ascii(hex) {
      let str = '';
      for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
      return str;
    }
  });