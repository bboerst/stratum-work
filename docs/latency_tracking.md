# Latency Tracking

The collector records when a `mining.notify` message arrives from a pool, then
optionally attaches an estimate of how long that message spent traveling over
the network. The web application can subtract that estimate when displaying or
ordering timing data.

In short:

```text
adjusted_time = collector_receive_time - estimated_one_way_latency
```

The stored receive timestamp is not rewritten. Latency adjustment is a display
choice in the web application.

## Why this exists

The collector timestamps each pool message when the socket read returns. That is
the best local fact the collector has, but it includes network transit time:

```text
pool sends job ---- network delay ---- collector receives job
                                      ^
                                      raw timestamp is taken here
```

For cross-pool timing comparisons, that raw receive time can be misleading. A
pool behind a slow route or Tor path may look later than it really was. Latency
tracking tries to estimate the delay and subtract it:

```text
pool sends job ---- estimated latency ---- collector receives job
^                                           ^
adjusted display time                      raw stored timestamp
```

## RTT and one-way latency

RTT means round-trip time: the time from sending a request to receiving the
matching response.

The collector cannot directly measure one-way pool-to-collector latency without
clock synchronization or cooperation from the pool. It therefore estimates:

```text
one_way_latency = RTT / 2
```

This assumes the path to the pool and the path back from the pool are roughly
symmetrical. If the path is asymmetric, the collector cannot detect that on its
own, so this is a best-effort correction.

## Wall-clock time vs monotonic time

The implementation uses two different clocks for two different jobs.

Wall-clock time answers: "What time was it?"

```python
self.last_recv_ts_ns = time.time_ns()
```

That value is used for the message's stored `timestamp`. It is an epoch
nanosecond timestamp, hex-encoded before being written into the notification
document.

Monotonic time answers: "How much time elapsed?"

```python
self.last_recv_monotonic_ns = time.monotonic_ns()
```

That value is used only for duration math, such as calculating application RTT.
It is a stopwatch-style clock. It does not represent calendar time, but it is
safer for elapsed-time measurements because it should not jump when the system
clock is corrected.

The important distinction:

```text
time.time_ns()       -> timestamp stored on the message
time.monotonic_ns()  -> stopwatch used to measure RTT
```

## Collector data flow

When the collector reads bytes from the pool socket, it records both clocks:

```python
new_buf = self.sock.recv(4096)
self.buf += new_buf
self.last_recv_ts_ns = time.time_ns()
self.last_recv_monotonic_ns = time.monotonic_ns()
```

When the parsed message is a `mining.notify`, the collector uses the wall-clock
receive timestamp as the raw event time:

```python
event_time = hex(receipt_ts_ns)[2:]
document = create_notification_document(
    msg,
    self.pool_name,
    self.extranonce1,
    self.extranonce2_length,
    event_time,
    latency=self.latency_tracker.estimate(),
)
```

If the tracker has an estimate, the document also gets:

```python
document["lat_ms"] = latency_ms
document["lat_m"] = latency_method
```

The resulting document shape is roughly:

```json
{
  "timestamp": "1875f0c2c9e0a800",
  "pool_name": "example-pool",
  "height": 900000,
  "job_id": "abc123",
  "lat_ms": 12.5,
  "lat_m": "tcp"
}
```

If no estimate is available yet, `lat_ms` and `lat_m` are omitted.

## Measurement type: `tcp`

`lat_m: "tcp"` means the latency estimate came from the operating system's TCP
RTT measurement for the pool connection.

For direct, non-proxied connections, the collector samples Linux `TCP_INFO`:

```python
buf = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, _TCP_INFO_LEN)
rtt_us = parse_tcp_info_rtt_us(buf)
```

The parsed value is `tcpi_rtt`, expressed in microseconds. The kernel maintains
this as a smoothed RTT estimate for the TCP connection.

The collector records it as nanoseconds:

```python
rtt_ns = rtt_us * 1_000
self._tcp_rtt_ns = rtt_ns
```

Then the estimate is:

```python
latency_ms = tcp_rtt_ns / 2 / 1e6
method = "tcp"
```

`tcp` is preferred for direct connections because it measures the network
transport layer and does not include Stratum server request processing time. It
is also passive once the connection has traffic: the collector samples the
kernel's current view after sends.

Limitations of `tcp`:

- It is only available where `TCP_INFO` exists and can be parsed.
- It is a smoothed kernel estimate, not a per-message measurement.
- It only describes the TCP connection the collector can see.
- Through a local SOCKS/Tor proxy, it would measure the collector-to-proxy hop,
  not the full collector-to-pool path.

Because of that last point, the collector intentionally skips TCP RTT sampling
when `use_proxy` is enabled:

```python
def _sample_tcp_rtt(self):
    if self.use_proxy:
        return
    self.latency_tracker.record_tcp_rtt_us(sample_tcp_rtt_us(self.sock))
```

## Measurement type: `app`

`lat_m: "app"` means the latency estimate came from Stratum request/response
timing measured by the collector.

The collector sends an id-bearing request, records the send time using
`time.monotonic_ns()`, and waits for a response with the same JSON-RPC id:

```python
request_id = self.id
self.id += 1
self.latency_tracker.record_send(request_id, time.monotonic_ns())
self.sock.sendall(payload.encode())
```

The socket reader is still the only reader. When any message arrives, the
collector checks whether it resolves a pending request id:

```python
request_id = msg.get("id")
send_ns = self._pending.pop(request_id, None)
rtt_ns = recv_monotonic_ns - send_ns
self._app_rtt_ns.append(rtt_ns)
```

For active probes, the request is currently `mining.subscribe`:

```python
payload = json.dumps({
    "id": request_id,
    "method": "mining.subscribe",
    "params": [],
}) + "\n"
```

The estimate uses the minimum of the most recent application RTT samples:

```python
latency_ms = min(self._app_rtt_ns) / 2 / 1e6
method = "app"
```

The minimum is used because application RTT includes more than just network
travel time. It can include pool processing, queueing, Tor variability, or other
delays. The smallest recent sample is treated as the least-noisy approximation
of the network path.

`app` is used for proxied connections because it measures end-to-end through the
proxy path. It is also the fallback for direct connections when TCP RTT is not
available.

Limitations of `app`:

- It includes server processing time, so it can overestimate network latency.
- It depends on request/response probes or other id-bearing Stratum requests.
- It is still converted to one-way latency with `RTT / 2`, so asymmetric paths
  remain unknowable.

## How the tracker chooses an estimate

The collector has one `LatencyTracker` per pool connection. On reconnect, that
tracker is reset because latency is path-specific.

The estimate logic is:

```python
def estimate(self):
    if not self.proxied and self._tcp_rtt_ns is not None:
        return (self._tcp_rtt_ns / 2 / 1e6, "tcp")
    if self._app_rtt_ns:
        return (min(self._app_rtt_ns) / 2 / 1e6, "app")
    return None
```

So:

- Direct connection with TCP RTT: use `tcp`.
- Direct connection without TCP RTT: fall back to `app` if samples exist.
- Proxied connection: ignore TCP RTT and use `app` if samples exist.
- No valid samples yet: omit latency fields.

The tracker rejects invalid or absurd samples:

```python
MAX_REASONABLE_RTT_NS = 30_000_000_000  # 30 seconds

if 0 < rtt_ns <= MAX_REASONABLE_RTT_NS:
    self._app_rtt_ns.append(rtt_ns)
```

Unanswered probe ids are also pruned so old pending requests do not linger
forever.

## Web application adjustment

The web app receives or fetches documents with raw `timestamp`, optional
`lat_ms`, and optional `lat_m`. It does not modify MongoDB records or stream
payloads.

When latency adjustment is enabled, it subtracts `lat_ms` from the timestamp at
display time:

```ts
const ns = BigInt("0x" + timestamp)
const adjusted = ns - BigInt(Math.round(latencyMs * 1e6))
return adjusted.toString(16)
```

`lat_ms` is milliseconds. The timestamp is nanoseconds. That is why the code
multiplies by `1e6`.

If adjustment is disabled, `lat_ms` is missing, `lat_ms` is invalid, or the
timestamp is not the collector's hex format, the helper returns the raw
timestamp unchanged:

```ts
if (!enabled || latencyMs == null || !Number.isFinite(latencyMs) || latencyMs <= 0) {
  return timestamp
}
```

The shared wrapper is:

```ts
export function effectiveTimestamp(data, enabled) {
  return adjustHexTimestamp(data.timestamp, data.lat_ms, enabled)
}
```

The effective timestamp drives table display, table timestamp sorting, chart
placement, and historical pool timing comparisons. The raw timestamp is kept
alongside derived rows so other views can receive the original value and avoid
subtracting latency twice.

## Display setting

Latency adjustment is a per-visual setting in the web app. It defaults to on and
is persisted in `localStorage`:

```ts
const STORAGE_PREFIX = "latency-adjusted:"
const DEFAULT_VALUE = true

{
  table: DEFAULT_VALUE,
  "timing-chart": DEFAULT_VALUE,
}
```

The table uses the `table` setting. The realtime timing chart and historical
pool timing panel use the shared `timing-chart` setting.

## Practical reading of fields

Given this document:

```json
{
  "timestamp": "1875f0c2c9e0a800",
  "lat_ms": 25.0,
  "lat_m": "app"
}
```

Read it as:

- The collector received the message at raw timestamp
  `1875f0c2c9e0a800`.
- The collector estimated the pool-to-collector network delay as 25 ms.
- That estimate came from application-level Stratum request/response timing.
- With latency adjustment on, the web app displays and sorts the message as if
  it happened 25 ms earlier.

With adjustment off, or with no `lat_ms`, the web app uses the raw timestamp.
