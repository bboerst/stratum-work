# stratum-work-collector

![Version: 0.3.0](https://img.shields.io/badge/Version-0.3.0-informational?style=flat-square) ![AppVersion: v1.0.7](https://img.shields.io/badge/AppVersion-v1.0.7-informational?style=flat-square)

A Helm chart for deploying the Pool Work Collector Python script

## Modes

- **Single-pool (legacy)** — `pools` empty. One StatefulSet named
  `stratum-work-collector-<poolName slug>` driven by `poolName` / `arguments`
  (as used by `helmfile.yaml.gotmpl`, one release per pool). Unchanged from 0.2.0.
- **Multi-pool** — `pools` non-empty. One release renders, per pool, a
  StatefulSet `collector-<slug>-<mode>` (1 replica). Each `mode: work` pool
  also gets a ClusterIP Service `collector-<slug>-work` (router target
  `collector-<slug>-work.<namespace>.svc:<targetPort>`) and, when
  `workMode.networkPolicy.enabled`, a router-only NetworkPolicy. The legacy
  values (`poolName`, `arguments`, `mode`, `connectionId`, `account`,
  `existingSecret`, `env`, `service`, `workMode.enabled/port`) are ignored.

`slug` = pool name lowercased, runs of non-alphanumerics replaced by `-`,
trimmed, max 34 chars (so the StatefulSet's `controller-revision-hash` pod
label stays within 63 chars). Duplicate slugs fail the render.

Per-pod env in multi-pool mode: `SITE`, `MODE`, `CONNECTION_ID`
(`<site>/<slug>/<mode>`), `ACCOUNT` (if set), `defaults.env`, and
`STRATUM_USERPASS`, which comes from one of:
1. `userpass` — a plain value (non-secret, e.g. `address.worker:x`)
2. `userpassSecretKey` — a required key in `defaults.existingSecret`
3. otherwise, the shared `STRATUM_USERPASS` key in `defaults.existingSecret`
   (optional for observe pools, required for work pools)

`RABBITMQ_PASSWORD` and `BITCOIN_RPC_PASSWORD` are optional secretKeyRefs
(the collector runs connect-only / uses its RPC default when they are
missing). `WORK_TOKEN` is a required secretKeyRef, set only on work pools.

### Multi-pool example

```yaml
site: us-ash-1
workMode:
  networkPolicy:
    routerNamespaceSelector:
      matchLabels: {kubernetes.io/metadata.name: stratum-router}
defaults:
  image: {tag: v1.1.0}
  rabbitmq: {host: rabbitmq.stratum-work.svc, port: 5672, username: collector}
  existingSecret: collector-env   # RABBITMQ_PASSWORD, BITCOIN_RPC_PASSWORD, WORK_TOKEN, ...
  bitcoin: {rpcHost: bitcoin-node.bitcoin.svc, rpcPort: 8332, rpcUser: collector}
  zmqEndpoint: tcp://bitcoin-node.bitcoin.svc:28332
  priorityClassName: stratum-critical
pools:
  - name: "Foundry USA"
    url: stratum+tcp://stratum.foundryusapool.com:3333
    mode: observe
    userpass: bc1qexampleaddress.observer:x
  - name: "Braiins Pool"
    url: stratum+tcp://stratum.braiins.com:3333
    mode: work
    account: example.worker
    userpassSecretKey: BRAIINS_USERPASS
    targetPort: 3333
```

This renders `collector-foundry-usa-observe` (StatefulSet) and
`collector-braiins-pool-work` (StatefulSet + Service + NetworkPolicy). See
`ci/multi-pool-values.yaml`.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| account | string | `""` | Env `ACCOUNT` (work mode worker name); omitted when empty |
| arguments[0] | string | `"--url"` |  |
| arguments[1] | string | `"stratum+tcp://beststratumpool.com:3333"` |  |
| arguments[2] | string | `"--log-level"` |  |
| arguments[3] | string | `"INFO"` |  |
| connectionId | string | `""` | Env `CONNECTION_ID`; omitted when empty |
| defaults.bitcoin.rpcHost | string | `""` | `--bitcoin-rpc-host` (multi-pool) |
| defaults.bitcoin.rpcPort | string | `""` | `--bitcoin-rpc-port` (multi-pool) |
| defaults.bitcoin.rpcUser | string | `""` | `--bitcoin-rpc-user` (multi-pool) |
| defaults.env | object | `{}` | Extra non-secret env for every pool (multi-pool) |
| defaults.existingSecret | string | `""` | Secret for `RABBITMQ_PASSWORD`, `BITCOIN_RPC_PASSWORD`, `STRATUM_USERPASS`, `WORK_TOKEN`, and per-pool `userpassSecretKey` keys (multi-pool; required if any pool is `work`) |
| defaults.image | object | `{}` | Merged over `image` (multi-pool) |
| defaults.logLevel | string | `"INFO"` | `--log-level` (multi-pool) |
| defaults.priorityClassName | string | `""` | Falls back to `priorityClassName` (multi-pool) |
| defaults.rabbitmq.host | string | `""` | `--rabbitmq-host` (multi-pool) |
| defaults.rabbitmq.port | string | `""` | `--rabbitmq-port` (multi-pool) |
| defaults.rabbitmq.username | string | `""` | `--rabbitmq-username` (multi-pool) |
| defaults.resources | object | `{}` | Falls back to `resources` (multi-pool) |
| defaults.zmqEndpoint | string | `""` | `--bitcoin-zmq-block` (multi-pool) |
| env | object | `{}` | Extra non-secret environment variables |
| existingSecret | string | `""` | Secret referenced for optional keys `STRATUM_USERPASS`, `RABBITMQ_PASSWORD`, `BITCOIN_RPC_PASSWORD`, `WORK_TOKEN` |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"bboerst/stratum-work-collector"` |  |
| mode | string | `""` | Env `MODE` (`observe` or `work`); omitted when empty |
| pools | list | `[]` | Multi-pool entries `{name, url, mode: observe\|work, userpass?, userpassSecretKey?, account?, targetPort? (3333), resources?, extraArgs?}`; non-empty enables multi-pool mode |
| poolName | string | `"Best Stratum Pool"` |  |
| priorityClassName | string | `""` |  |
| resources.requests.memory | string | `"40Mi"` |  |
| service.enabled | bool | `false` |  |
| service.externalIPs | list | `[]` |  |
| service.externalTrafficPolicy | string | `""` |  |
| service.healthCheckNodePort | int | `0` |  |
| service.loadBalancerIP | string | `""` |  |
| service.loadBalancerSourceRanges | list | `[]` |  |
| service.omitClusterIP | bool | `false` |  |
| service.ports.stratum | int | `3333` |  |
| service.sessionAffinity | string | `""` |  |
| service.type | string | `"ClusterIP"` |  |
| site | string | `""` | Env `SITE`; omitted when empty (single-pool). Required in multi-pool mode |
| workMode.enabled | bool | `false` | Single-pool work mode (router-facing proxy) |
| workMode.networkPolicy.enabled | bool | `true` | Router-only ingress policy for work pods (both modes) |
| workMode.networkPolicy.routerNamespaceSelector | object | `{}` | Namespaces the router may run in (`{}` = any) |
| workMode.networkPolicy.routerPodLabels | object | `{"stratum.work/component":"router"}` | Router pod labels allowed in |
| workMode.port | int | `3333` | Single-pool work listen port (`--stratum-client-port`) |

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.13.1](https://github.com/norwoodj/helm-docs/releases/v1.13.1)
