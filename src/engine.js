import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';

/**
 * Substitute per-request template placeholders in a string.
 * Supported tokens (case-insensitive name):
 *   {{seq}}            -> the request's sequence number
 *   {{uuid}}           -> a random RFC-4122 UUID
 *   {{rand}}           -> 12-char random hex hash
 *   {{rand:N}}         -> N-char random hex hash
 *   {{randint:a:b}}    -> random integer in [a, b]
 *   {{timestamp}}      -> current epoch milliseconds
 * Returns the input unchanged when it contains no "{{".
 */
function renderTemplate(str, seq) {
  if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
    const [name, ...args] = expr.split(':').map((s) => s.trim());
    switch (name.toLowerCase()) {
      case 'seq':
        return String(seq);
      case 'uuid':
        return crypto.randomUUID();
      case 'rand': {
        const len = parseInt(args[0], 10) || 12;
        return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
      }
      case 'randint': {
        const min = parseInt(args[0], 10) || 0;
        const max = parseInt(args[1], 10);
        const hi = Number.isFinite(max) ? max : 100;
        return String(min + Math.floor(Math.random() * (hi - min + 1)));
      }
      case 'timestamp':
        return String(Date.now());
      default:
        return match; // leave unknown tokens untouched
    }
  });
}

/** True if any of the request fields contain a template placeholder. */
function hasTemplate(config) {
  if (typeof config.url === 'string' && config.url.includes('{{')) return true;
  if (typeof config.body === 'string' && config.body.includes('{{')) return true;
  return Object.values(config.headers || {}).some((v) => typeof v === 'string' && v.includes('{{'));
}

/**
 * Compute a percentile from a sorted array of numbers.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Upper bounds (ms) for the latency-distribution histogram.
const HISTOGRAM_BOUNDS = [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000];

/**
 * Bucket latencies into a histogram for the distribution chart.
 * Returns [{ label, count }] including a final ">5000" overflow bucket.
 */
function histogram(latencies) {
  const counts = new Array(HISTOGRAM_BOUNDS.length + 1).fill(0);
  for (const ms of latencies) {
    let i = HISTOGRAM_BOUNDS.findIndex((b) => ms <= b);
    if (i === -1) i = HISTOGRAM_BOUNDS.length;
    counts[i]++;
  }
  const buckets = counts.map((count, i) => {
    const lo = i === 0 ? 0 : HISTOGRAM_BOUNDS[i - 1];
    const label = i === HISTOGRAM_BOUNDS.length ? `>${HISTOGRAM_BOUNDS[i - 1]}` : `${lo}–${HISTOGRAM_BOUNDS[i]}`;
    return { label, count };
  });

  // Trim leading/trailing empty buckets so the chart focuses on the populated range.
  let start = buckets.findIndex((b) => b.count > 0);
  let end = buckets.length - 1 - [...buckets].reverse().findIndex((b) => b.count > 0);
  if (start === -1) return []; // no data
  return buckets.slice(start, end + 1);
}

/**
 * Drives a single HTTP/HTTPS load test.
 *
 * Maintains `concurrency` independent request loops; each loop fires a request,
 * waits for it to finish, records the result, then immediately fires the next
 * one until the test stops. This keeps exactly `concurrency` requests in flight.
 *
 * Events:
 *   - 'tick'  -> periodic snapshot of live metrics
 *   - 'done'  -> final summary
 *   - 'error' -> fatal setup error (e.g. bad URL)
 */
export class LoadTester extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      url: config.url,
      method: (config.method || 'GET').toUpperCase(),
      headers: config.headers || {},
      body: config.body || null,
      concurrency: Math.max(1, parseInt(config.concurrency, 10) || 10),
      // Stop after this many seconds (0 = ignore).
      duration: parseInt(config.duration, 10) || 0,
      // Stop after this many requests (0 = ignore).
      totalRequests: parseInt(config.totalRequests, 10) || 0,
      // Per-request timeout in ms.
      timeout: parseInt(config.timeout, 10) || 10000,
      // Optional fixed think-time between requests per worker (ms).
      delay: parseInt(config.delay, 10) || 0,
      // Starting value for the {{seq}} placeholder.
      seqStart: Number.isFinite(parseInt(config.seqStart, 10)) ? parseInt(config.seqStart, 10) : 1,
    };

    // Monotonic counter handing each request its {{seq}} value.
    this._seqCounter = 0;
    this.running = false;
    this.startTime = 0;
    this.endTime = 0;

    // Aggregate counters.
    this.sent = 0;
    this.completed = 0;
    this.failed = 0;
    this.bytes = 0;
    this.latencies = [];
    this.statusCodes = {};
    this.errors = {};

    // Rolling window for live RPS (counts since last tick).
    this._windowCompleted = 0;
    this._lastTickTime = 0;
  }

  start() {
    this._templated = hasTemplate(this.config);

    // Validate against a rendered probe so placeholders don't trip up parsing.
    let parsed;
    try {
      parsed = new URL(renderTemplate(this.config.url, this.config.seqStart));
    } catch {
      this.emit('error', new Error(`Invalid URL: ${this.config.url}`));
      return;
    }

    this.running = true;
    this.startTime = performance.now();
    this._lastTickTime = this.startTime;

    const isHttps = parsed.protocol === 'https:';
    this._transport = isHttps ? https : http;
    this._agent = new this._transport.Agent({
      keepAlive: true,
      maxSockets: this.config.concurrency,
    });
    this._parsedUrl = parsed;

    // Periodic snapshot emitter.
    this._ticker = setInterval(() => this._emitTick(), 1000);

    // Hard stop on duration.
    if (this.config.duration > 0) {
      this._durationTimer = setTimeout(() => this.stop('duration'), this.config.duration * 1000);
    }

    // Launch the worker loops.
    for (let i = 0; i < this.config.concurrency; i++) {
      this._workerLoop();
    }
  }

  stop(reason = 'manual') {
    if (!this.running) return;
    this.running = false;
    this._stopReason = reason;
    clearInterval(this._ticker);
    clearTimeout(this._durationTimer);
    this.endTime = performance.now();
    if (this._agent) this._agent.destroy();
    // Give in-flight requests a beat to settle, then emit the summary.
    setTimeout(() => this.emit('done', this.summary()), 50);
  }

  _shouldContinue() {
    if (!this.running) return false;
    if (this.config.totalRequests > 0 && this.sent >= this.config.totalRequests) {
      return false;
    }
    return true;
  }

  async _workerLoop() {
    while (this._shouldContinue()) {
      this.sent++;
      const seq = this.config.seqStart + this._seqCounter++;
      await this._doRequest(seq);
      if (this.config.delay > 0 && this.running) {
        await new Promise((r) => setTimeout(r, this.config.delay));
      }
    }
    // If this loop hit the request cap, ensure the test finishes.
    if (this.running && this.config.totalRequests > 0 && this.sent >= this.config.totalRequests) {
      this.stop('totalRequests');
    }
  }

  _doRequest(seq) {
    return new Promise((resolve) => {
      // Resolve per-request template placeholders. Re-parse the URL only when it
      // actually contains a placeholder, so the common static case stays cheap.
      const u =
        this._templated && this.config.url.includes('{{')
          ? new URL(renderTemplate(this.config.url, seq))
          : this._parsedUrl;

      let headers = this.config.headers;
      if (this._templated) {
        headers = {};
        for (const [k, v] of Object.entries(this.config.headers)) {
          headers[k] = renderTemplate(v, seq);
        }
      }
      const body = this._templated ? renderTemplate(this.config.body, seq) : this.config.body;

      const started = performance.now();
      const options = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: this.config.method,
        headers: { ...headers },
        agent: this._agent,
        timeout: this.config.timeout,
      };

      if (body && this.config.method !== 'GET' && this.config.method !== 'HEAD') {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = this._transport.request(options, (res) => {
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
        });
        res.on('end', () => {
          const latency = performance.now() - started;
          this._record({ latency, status: res.statusCode, bytes: size });
          resolve();
        });
      });

      req.on('error', (err) => {
        const latency = performance.now() - started;
        this._record({ latency, error: err.code || err.message });
        resolve();
      });

      req.on('timeout', () => {
        req.destroy(new Error('ETIMEDOUT'));
      });

      if (body && this.config.method !== 'GET' && this.config.method !== 'HEAD') {
        req.write(body);
      }
      req.end();
    });
  }

  _record({ latency, status, bytes = 0, error }) {
    this.completed++;
    this._windowCompleted++;
    this.latencies.push(latency);
    this.bytes += bytes;

    if (error) {
      this.failed++;
      this.errors[error] = (this.errors[error] || 0) + 1;
    } else {
      this.statusCodes[status] = (this.statusCodes[status] || 0) + 1;
      // 4xx/5xx count as failures for the success-rate metric.
      if (status >= 400) this.failed++;
    }
  }

  _emitTick() {
    const now = performance.now();
    const windowSec = (now - this._lastTickTime) / 1000 || 1;
    const rps = this._windowCompleted / windowSec;
    this._windowCompleted = 0;
    this._lastTickTime = now;

    const elapsed = (now - this.startTime) / 1000;
    const sorted = [...this.latencies].sort((a, b) => a - b);

    this.emit('tick', {
      elapsed: +elapsed.toFixed(1),
      rps: +rps.toFixed(1),
      sent: this.sent,
      completed: this.completed,
      failed: this.failed,
      inFlight: this.sent - this.completed,
      avgLatency: this.latencies.length
        ? +(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length).toFixed(2)
        : 0,
      p50: +percentile(sorted, 50).toFixed(2),
      p95: +percentile(sorted, 95).toFixed(2),
      p99: +percentile(sorted, 99).toFixed(2),
    });
  }

  summary() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const durationSec = ((this.endTime || performance.now()) - this.startTime) / 1000;
    const sum = this.latencies.reduce((a, b) => a + b, 0);

    return {
      reason: this._stopReason,
      config: this.config,
      durationSec: +durationSec.toFixed(2),
      requests: {
        sent: this.sent,
        completed: this.completed,
        failed: this.failed,
        successRate: this.completed
          ? +(((this.completed - this.failed) / this.completed) * 100).toFixed(2)
          : 0,
      },
      throughput: {
        rps: +(this.completed / (durationSec || 1)).toFixed(2),
        bytes: this.bytes,
        kbPerSec: +(this.bytes / 1024 / (durationSec || 1)).toFixed(2),
      },
      latency: {
        min: +(sorted[0] || 0).toFixed(2),
        max: +(sorted[sorted.length - 1] || 0).toFixed(2),
        avg: this.latencies.length ? +(sum / this.latencies.length).toFixed(2) : 0,
        p50: +percentile(sorted, 50).toFixed(2),
        p90: +percentile(sorted, 90).toFixed(2),
        p95: +percentile(sorted, 95).toFixed(2),
        p99: +percentile(sorted, 99).toFixed(2),
      },
      statusCodes: this.statusCodes,
      errors: this.errors,
      distribution: histogram(this.latencies),
    };
  }
}
