# ⚡ Load Tester

A lightweight HTTP/REST load testing tool with a live web dashboard. Built on
Node.js with a tiny dependency footprint (Express + ws). The engine maintains a
fixed number of concurrent request loops and streams live metrics to the browser
over WebSockets.

## Features

- Configure target URL, method, headers, and body from the dashboard
- Control **concurrency**, **duration**, **max requests**, **timeout**, and per-worker **think time**
- **Dynamic per-request values** via `{{...}}` placeholders in the URL, headers, or body
- Live charts: requests/sec and latency (avg / p95 / p99)
- Live counters: completed, failed, in-flight, elapsed
- **Post-test report** with a health verdict, analytics cards (throughput, peak RPS,
  error rate, tail-latency ratio, latency trend over the run, data transferred) and
  charts: latency percentiles, latency distribution histogram, and a response/status
  breakdown doughnut
- Final summary with latency percentiles (min/avg/p50/p90/p95/p99), throughput, status-code and error breakdown
- **Download a CSV report** (Excel-compatible) containing the configuration, summary
  metrics, status-code/error breakdown, latency distribution, and the full per-second time series

## Requirements

- Node.js 18+

## Install & run

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

Set a custom port with `PORT=8080 npm start`.

## How it works

`src/engine.js` exposes a `LoadTester` class (an `EventEmitter`). It opens
`concurrency` independent loops; each loop fires a request, awaits the response,
records latency/status, and immediately fires the next — keeping exactly
`concurrency` requests in flight. A keep-alive agent reuses sockets. It emits a
`tick` snapshot every second and a `done` summary when the test stops (by
duration, request cap, or manual stop).

`server.js` wires the engine to an Express API (`/api/start`, `/api/stop`,
`/api/status`) and broadcasts engine events to all connected dashboards via
WebSocket.

## Dynamic per-request values

Any `{{token}}` in the **URL, header values, or body** is substituted fresh on
every request, so each request can carry a unique id, hash, or token:

| Token | Expands to | Example |
|-------|-----------|---------|
| `{{seq}}` | Sequence number (starts at "Sequence start", default 1) | `?id={{seq}}` → `?id=1`, `?id=2`, … |
| `{{uuid}}` | Random RFC-4122 UUID | `?id={{uuid}}` |
| `{{rand}}` | 12-char random hex hash | `?id={{rand}}` |
| `{{rand:N}}` | N-char random hex hash | `?id={{rand:6}}` → `?id=a3f9c1` |
| `{{randint:a:b}}` | Random integer in `[a, b]` | `?page={{randint:1:100}}` |
| `{{timestamp}}` | Current epoch milliseconds | `?t={{timestamp}}` |

Tokens combine freely, e.g. `https://abc.com/?id={{seq}}{{rand:8}}` produces
`?id=1a3f9c1d`, `?id=2b0b5224`, … (a sequential prefix plus a random hash). The
`{{seq}}` counter is shared across all concurrent workers, so values stay unique
even at high concurrency.

## ⚠️ Use responsibly

Only load test services **you own or have explicit permission to test**.
Generating high request volumes against systems you don't control may be illegal
and is indistinguishable from a denial-of-service attack.
