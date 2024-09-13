export function renderCellContent(data, column) {
  switch (column.key) {
    case 'timestamp': {
      const date = new Date(data.timestamp);
      const timeString = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return { value: timeString, tooltip: date.toLocaleString() };
    }
    case 'ntime': {
      const ntimeHex = parseInt(data.ntime, 16);
      const date = new Date(ntimeHex * 1000);
      const timeString = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return { value: timeString, tooltip: date.toLocaleString() };
    }
    case 'time_since_last_revision':
      return { value: `${data.time_since_last_revision.toFixed(3)}s` };
    case 'clean_jobs':
      return { value: data.clean_jobs ? 'Yes' : 'No' };
    case 'coinbase_outputs': {
      const filteredOutputs = data.coinbase_outputs.filter(output => !output.address.startsWith('(nulldata'));
      const outputs = filteredOutputs.map(output => `${output.address}: ${output.value} BTC`).join('\n');
      const addresses = filteredOutputs.map(output => output.address).join('');

      let hash = 0;
      for (let i = 0; i < addresses.length; i++) {
        hash = addresses.charCodeAt(i) + ((hash << 5) - hash);
      }
      let color = '#';
      for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).slice(-2);
      }

      const blendWithWhite = (color, percentage) => {
        const f = parseInt(color.slice(1), 16);
        const t = percentage < 0 ? 0 : 255;
        const p = percentage < 0 ? percentage * -1 : percentage;
        const R = f >> 16;
        const G = f >> 8 & 0x00FF;
        const B = f & 0x0000FF;
        return `#${(0x1000000 + (Math.round((t - R) * p) + R) * 0x10000 + (Math.round((t - G) * p) + G) * 0x100 + (Math.round((t - B) * p) + B)).toString(16).slice(1)}`;
      };

      color = blendWithWhite(color, 0.5);

      return { value: outputs, tooltip: outputs, color, textColor: '#000000' };
    }
    case 'first_transaction':
      return {
        value: data.first_transaction !== 'empty block' ? data.first_transaction : 'empty block',
        tooltip: data.first_transaction !== 'empty block' ? `https://mempool.space/tx/${data.first_transaction}` : 'empty block'
      };
    case 'coinbase_output_value':
      return { value: data.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0).toFixed(8) };
    default:
      if (column.key.startsWith('merkle_branch_')) {
        const index = parseInt(column.key.split('_')[2]);
        const value = data.merkle_branches?.[index] || '';
        const color = data.merkle_branch_colors?.[index] || 'transparent';
        return { value, color, textColor: value ? '#000000' : 'transparent' };
      }
      return { value: data[column.key] };
  }
}