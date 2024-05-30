document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const table = new Tabulator('#mining-table', {
        index: 'pool_name',
        layout: 'fitColumns',
        movableColumns: true,
        columns: [
            { title: 'Pool Name', field: 'pool_name' },
            {
                title: 'Timestamp',
                field: 'timestamp',
                formatter: function(cell, formatterParams, onRendered) {
                    const timestamp = cell.getValue().$date;
                    const date = new Date(timestamp);
                    const formattedTimestamp = `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`;
                    return formattedTimestamp;
                }
            },
            // { title: 'Prev Hash', field: 'prev_hash' },
            { title: 'Height', field: 'height' },
            { title: 'Previous Block Hash', field: 'prev_block_hash' },
            // { title: 'Block Version', field: 'block_version' },
            // { title: 'Coinbase1', field: 'coinbase1' },
            // { title: 'Coinbase2', field: 'coinbase2' },
            // { title: 'Version', field: 'version' },
            // { title: 'Nbits', field: 'nbits' },
            // { title: 'Ntime', field: 'ntime' },
            { title: 'Clean Jobs', field: 'clean_jobs' },
            { title: 'First Transaction', field: 'first_transaction' },
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
            // { title: 'Coinbase RAW', field: 'coinbase_raw' },
        ],
        initialSort:[
            {column:'coinbase_output_value', dir:"desc"},
        ],
    });

    socket.on('mining_data', (data) => {
        if (!Array.isArray(data)) {
            data = [data];
        }

        // console.log('Received data:', data);

        data.forEach(row => {
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

            // Extract first transaction after coinbase
            const merkleBranches = row.merkle_branches;
            if (merkleBranches.length > 0) {
                const firstTxBytes = merkleBranches[0].match(/../g).reverse();
                row.first_transaction = firstTxBytes.join('');
            } else {
                row.first_transaction = 'empty block';
            }
        });

        const existingData = table.getData();
        const updatedData = existingData.map(existingRow => {
            const newRow = data.find(row => row.pool_name === existingRow.pool_name);
            return newRow || existingRow;
        });
        
        table.replaceData(updatedData);

        const newData = data.filter(newRow => !existingData.some(existingRow => existingRow.pool_name === newRow.pool_name));
        table.addData(newData);
    });

    function merkleBranchFormatter(index) {
        return function(cell, formatterParams, onRendered) {
            const merkleBranches = cell.getValue();
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
});
