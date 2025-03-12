# Bitcoin Mining Analysis Data API

This API provides access to Bitcoin mining pool data with all computed values for analysis purposes. It returns both the original stratum v1 messages and additional decoded fields that are computed from the raw data.

## Endpoint

```
GET /api/analysis-data
```

## Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `height` | string | Required. Single block height or comma-separated list of heights. |

## Example Requests

### Single Height

```
GET /api/analysis-data?height=800000
```

### Multiple Heights

```
GET /api/analysis-data?height=800000,800001,800002
```

## Response Format

The API returns a JSON object with the following structure:

```json
{
  "results": [
    {
      "height": 800000,
      "mining_notifications": [
        {
          "id": "...",
          "pool_name": "F2Pool",
          "timestamp": "...",
          "height": 800000,
          "prev_hash": "...",
          "merkle_branches": ["..."],
          "version": "...",
          "nbits": "...",
          "ntime": "...",
          "clean_jobs": true,
          "extranonce1": "...",
          "extranonce2_length": 4,
          
          // Computed fields
          "coinbaseRaw": "...",
          "coinbaseScriptASCII": "...",
          "coinbaseOutputValue": 6.25,
          "first_transaction": "...",
          "coinbase_outputs": [
            {
              "address": "bc1q...",
              "value": 6.25
            }
          ]
        },
        // More notifications from different pools
      ],
      "block_details": {
        "height": 800000,
        "hash": "...",
        "timestamp": 1234567890,
        "mining_pool": {
          "id": 1,
          "name": "F2Pool",
          "link": "https://www.f2pool.com"
        },
        "size": 1234,
        "weight": 4000,
        "version": 536870912,
        "merkle_root": "...",
        "bits": "...",
        "nonce": 123456789,
        "difficulty": 50.25,
        "transaction_count": 2000
      },
      "previous_block": {
        "height": 799999,
        "hash": "...",
        "timestamp": 1234567880,
        "mining_pool": {
          "id": 2,
          "name": "AntPool",
          "link": "https://www.antpool.com"
        }
      }
    },
    // More results for other heights if requested
  ]
}
```

## Field Descriptions

### Mining Notifications

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the notification |
| `pool_name` | Name of the mining pool that sent the notification |
| `timestamp` | Timestamp when the notification was received |
| `height` | Block height the notification is for |
| `prev_hash` | Previous block hash in big-endian format (standard display format), correctly reversed in 4-byte chunks |
| `merkle_branches` | Array of merkle branches for transaction verification |
| `version` | Block version |
| `nbits` | Target difficulty in compact format |
| `ntime` | Block timestamp in hex format |
| `clean_jobs` | Whether miners should discard previous jobs |
| `extranonce1` | Extranonce1 value assigned by the pool |
| `extranonce2_length` | Length of extranonce2 in bytes |
| `coinbaseRaw` | Complete reconstructed coinbase transaction |
| `coinbaseScriptASCII` | ASCII representation of the coinbase script |
| `coinbaseOutputValue` | Total value of the coinbase outputs in BTC |
| `first_transaction` | First transaction ID in the block (derived from merkle branches) |
| `coinbase_outputs` | Array of outputs from the coinbase transaction with addresses and values |

### Block Details

| Field | Description |
|-------|-------------|
| `height` | Block height |
| `hash` | Block hash as stored in the database (not reversed) |
| `timestamp` | Block timestamp |
| `mining_pool` | Information about the mining pool that mined the block |
| `size` | Block size in bytes |
| `weight` | Block weight (segwit) |
| `version` | Block version |
| `merkle_root` | Merkle root of all transactions |
| `bits` | Target difficulty in compact format |
| `nonce` | Nonce value used to solve the block |
| `difficulty` | Block difficulty |
| `transaction_count` | Number of transactions in the block |

## Error Responses

### Missing Height Parameter

```json
{
  "error": "Missing block height"
}
```

### Invalid Height Parameter

```json
{
  "error": "Invalid block height"
}
```

### Server Error

```json
{
  "error": "Error message details"
}
```

## Notes

- This API is designed for data analysis and does not include computed colors or visualization data.
- The API reuses the same functions used by the client application to ensure consistency in the computed values.
- For large requests with multiple heights, the API processes each height in parallel for better performance.
- The `prev_hash` field in mining notifications is converted to big-endian format by reversing 4-byte chunks, which is the correct way to display Bitcoin block hashes. Block hashes in `block_details` and `previous_block` are provided as stored in the database.
- The raw coinbase parts (coinbase1 and coinbase2) are not included in the output as they are already combined in the `coinbaseRaw` field. 