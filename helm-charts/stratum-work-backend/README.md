# Stratum Work Backend Helm Chart

This Helm chart deploys the Bitcoin Mining Pool Identification System backend service, which processes Bitcoin blocks and identifies which mining pool mined each block.

## Prerequisites

- Kubernetes 1.16+
- Helm 3.0+
- MongoDB database
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
| `env` | Environment variables | See values.yaml |
| `envValueFrom` | Environment variables from Secrets/ConfigMaps (`valueFrom`), e.g. `PG_PASSWORD` | `{}` |
| `extraVolumes` / `extraVolumeMounts` | Extra volumes, e.g. a CA certificate for `PG_SSLROOTCERT` | `[]` |
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

### MongoDB Connection
- `MONGODB_URL`: MongoDB connection URL
- `MONGODB_DB`: MongoDB database name
- `MONGODB_USERNAME`: MongoDB username
- `MONGODB_PASSWORD`: MongoDB password

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

### Bitcoin RPC options
- `BITCOIN_RPC_SCHEME`: `http` (default) or `https`
- `BITCOIN_RPC_CA_FILE`: CA bundle for an https node with a private CA; never disable verification
- `BITCOIN_RPC_TIMEOUT`: RPC timeout in seconds (default 30)

### Storage backend (Postgres)
- `DB_BACKEND`: `mongodb` (default) or `postgres`
- `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_SSLMODE`, `PG_SSLROOTCERT`: Postgres connection, as separate fields (never a URL)
- `PG_PASSWORD`: from a Secret via `envValueFrom`

Example (CloudNativePG, verified TLS):
```yaml
env:
  DB_BACKEND: postgres
  PG_HOST: stratum-pg-rw
  PG_USER: backend
  PG_SSLMODE: verify-full
  PG_SSLROOTCERT: /etc/postgres-ca/ca.crt
envValueFrom:
  PG_PASSWORD:
    secretKeyRef: { name: stratum-pg-backend, key: password }
extraVolumes:
  - name: postgres-ca
    secret: { secretName: stratum-pg-ca, items: [{ key: ca.crt, path: ca.crt }] }
extraVolumeMounts:
  - { name: postgres-ca, mountPath: /etc/postgres-ca, readOnly: true }
```

## Command Line Arguments

The backend service can be started with the following command line arguments:

- `--update-pools`: Update pool definitions and reindex blocks if needed
- `--reindex-blocks`: Force reindexing of all blocks 