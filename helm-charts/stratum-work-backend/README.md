# Stratum Work Backend Helm Chart

This Helm chart deploys the Bitcoin Mining Pool Identification System backend service, which processes Bitcoin blocks and identifies which mining pool mined each block.

## Prerequisites

- Kubernetes 1.16+
- Helm 3.0+
- Postgres (TimescaleDB) database with the `db/migrations` schema applied
- RabbitMQ server
- Bitcoin node with RPC and ZMQ enabled

## Installing the Chart

To install the chart with the release name `my-backend`:

```bash
helm install my-backend ./helm-charts/stratum-work-backend
```

## Configuration

The following table lists the configurable parameters of the chart and their default values.

| Parameter | Description | Default |
| --------- | ----------- | ------- |
| `image.repository` | Image repository | `bboerst/stratum-work-backend` |
| `image.tag` | Image tag | `v1.0.0` (chart appVersion) |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `replicaCount` | Number of replicas | `1` |
| `args` | Command line arguments | `[]` |
| `existingSecret` | Secret exposed via `envFrom` (keys `DATABASE_URL`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, `BITCOIN_RPC_PASSWORD`) | `""` |
| `env` | Non-secret environment variables (override `existingSecret` keys of the same name) | See values.yaml |
| `priorityClassName` | Pod priority class | `""` |
| `service.enabled` | Enable service | `true` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `8001` |
| `resources` | CPU/Memory resource requests/limits | See values.yaml |

## Environment Variables

The backend service can be configured with the following environment variables:

### Bitcoin RPC Connection
- `BITCOIN_RPC_USER`: Bitcoin RPC username
- `BITCOIN_RPC_PASSWORD`: Bitcoin RPC password
- `BITCOIN_RPC_HOST`: Bitcoin RPC host
- `BITCOIN_RPC_PORT`: Bitcoin RPC port

### ZMQ Configuration
- `BITCOIN_ZMQ_BLOCK`: ZMQ endpoint for new block notifications
- `MIN_BLOCK_HEIGHT`: Minimum block height to process

### Postgres Connection
- `DATABASE_URL`: Postgres connection URL (from `existingSecret`)
- `ENABLE_HISTORICAL_DATA`: Set to `false` to disable database access

### RabbitMQ Connection
- `RABBITMQ_HOST`: RabbitMQ host
- `RABBITMQ_PORT`: RabbitMQ port
- `RABBITMQ_USERNAME`: RabbitMQ username
- `RABBITMQ_PASSWORD`: RabbitMQ password
- `RABBITMQ_EXCHANGE`: RabbitMQ exchange name

### Pool Definitions
- `POOL_LIST_URL`: URL to fetch mining pool definitions
- `POOL_UPDATE_INTERVAL`: Interval in seconds to check for pool definition updates
- `LOCAL_POOL_FILE`: Path to a local JSON file containing pool definitions

## Command Line Arguments

The backend service can be started with the following command line arguments:

- `--update-pools`: Update pool definitions and reindex blocks if needed
- `--reindex-blocks`: Force reindexing of all blocks 