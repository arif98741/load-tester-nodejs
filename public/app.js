const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const startBtn = $('start-btn');
const stopBtn = $('stop-btn');
const formError = $('form-error');
const summaryBox = $('summary');

// Holds everything from the most recent test so it can be exported to CSV.
let testData = { config: null, ticks: [], summary: null };

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = text || state;
}

// ---- Charts ---------------------------------------------------------------
const chartBase = {
  type: 'line',
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: { ticks: { color: '#8b98a5' }, grid: { color: '#2a3441' } },
      y: { beginAtZero: true, ticks: { color: '#8b98a5' }, grid: { color: '#2a3441' } },
    },
    plugins: { legend: { labels: { color: '#e6edf3' } } },
  },
};

const rpsChart = new Chart($('rpsChart'), {
  ...chartBase,
  data: {
    labels: [],
    datasets: [{ label: 'Requests / sec', data: [], borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,.15)', fill: true, tension: 0.3 }],
  },
});

const latChart = new Chart($('latChart'), {
  ...chartBase,
  data: {
    labels: [],
    datasets: [
      { label: 'avg ms', data: [], borderColor: '#4f8cff', tension: 0.3 },
      { label: 'p95 ms', data: [], borderColor: '#d29922', tension: 0.3 },
      { label: 'p99 ms', data: [], borderColor: '#f85149', tension: 0.3 },
    ],
  },
});

// Report charts (rendered after a test completes).
const pctChart = new Chart($('pctChart'), {
  type: 'bar',
  options: {
    ...chartBase.options,
    plugins: { legend: { display: false }, title: { display: true, text: 'Latency percentiles (ms)', color: '#e6edf3' } },
  },
  data: {
    labels: ['p50', 'p90', 'p95', 'p99', 'max'],
    datasets: [{ data: [], backgroundColor: ['#3fb950', '#4f8cff', '#d29922', '#f0883e', '#f85149'] }],
  },
});

const distChart = new Chart($('distChart'), {
  type: 'bar',
  options: {
    ...chartBase.options,
    plugins: { legend: { display: false }, title: { display: true, text: 'Latency distribution (req count)', color: '#e6edf3' } },
  },
  data: { labels: [], datasets: [{ data: [], backgroundColor: '#4f8cff' }] },
});

const statusChart = new Chart($('statusChart'), {
  type: 'doughnut',
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { color: '#e6edf3' } },
      title: { display: true, text: 'Response breakdown', color: '#e6edf3' },
    },
  },
  data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] },
});

function resetCharts() {
  for (const c of [rpsChart, latChart]) {
    c.data.labels = [];
    c.data.datasets.forEach((d) => (d.data = []));
    c.update();
  }
}

// ---- Post-test report -----------------------------------------------------
const STATUS_COLORS = { '2': '#3fb950', '3': '#4f8cff', '4': '#d29922', '5': '#f85149' };

function renderReport(summary, ticks) {
  const { requests, latency, throughput, statusCodes, errors } = summary;

  // Verdict banner.
  const verdict = $('verdict');
  const errRate = requests.completed ? (requests.failed / requests.completed) * 100 : 0;
  let cls = 'good';
  let head = '✅ Healthy';
  if (errRate >= 5 || latency.p99 > 1000) { cls = 'warn'; head = '⚠️ Degraded'; }
  if (errRate >= 25 || requests.completed === 0) { cls = 'bad'; head = '❌ Failing'; }
  verdict.className = `verdict ${cls}`;
  verdict.innerHTML = `${head}<span class="sub">${requests.successRate}% success over ${requests.completed.toLocaleString()} requests · ${throughput.rps} req/s · p99 ${latency.p99} ms</span>`;

  // Latency trend: compare avg latency in the first vs last third of the run.
  let trend = 'n/a';
  if (ticks.length >= 3) {
    const third = Math.max(1, Math.floor(ticks.length / 3));
    const avg = (arr) => arr.reduce((s, t) => s + t.avgLatency, 0) / arr.length;
    const first = avg(ticks.slice(0, third));
    const last = avg(ticks.slice(-third));
    const delta = first ? ((last - first) / first) * 100 : 0;
    if (delta > 20) trend = `↑ +${delta.toFixed(0)}% (degraded)`;
    else if (delta < -20) trend = `↓ ${delta.toFixed(0)}% (improved)`;
    else trend = `→ stable (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%)`;
  }
  const peakRps = ticks.length ? Math.max(...ticks.map((t) => t.rps)) : throughput.rps;
  const tailRatio = latency.p50 ? (latency.p99 / latency.p50).toFixed(1) : '—';

  // Analytics cards.
  const cards = [
    { k: 'Throughput', v: `${throughput.rps}`, note: 'requests / sec' },
    { k: 'Peak RPS', v: `${peakRps.toFixed(0)}`, note: 'highest 1s window' },
    { k: 'Error rate', v: `${errRate.toFixed(2)}%`, note: `${requests.failed} of ${requests.completed}` },
    { k: 'Avg latency', v: `${latency.avg} ms`, note: `min ${latency.min} ms` },
    { k: 'Tail ratio', v: `${tailRatio}×`, note: 'p99 ÷ p50' },
    { k: 'Latency trend', v: trend, note: 'first vs last third' },
    { k: 'Data transferred', v: `${(throughput.bytes / 1048576).toFixed(2)} MB`, note: `${throughput.kbPerSec} KB/s` },
    { k: 'Duration', v: `${summary.durationSec}s`, note: `stopped: ${summary.reason}` },
  ];
  $('analytics').innerHTML = cards
    .map((c) => `<div class="card"><div class="v">${c.v}</div><div class="k">${c.k}</div><div class="note">${c.note}</div></div>`)
    .join('');

  // Percentile chart.
  pctChart.data.datasets[0].data = [latency.p50, latency.p90, latency.p95, latency.p99, latency.max];
  pctChart.update();

  // Distribution chart.
  distChart.data.labels = summary.distribution.map((b) => b.label);
  distChart.data.datasets[0].data = summary.distribution.map((b) => b.count);
  distChart.update();

  // Status/error breakdown.
  const labels = [];
  const data = [];
  const colors = [];
  for (const [code, count] of Object.entries(statusCodes)) {
    labels.push(`HTTP ${code}`);
    data.push(count);
    colors.push(STATUS_COLORS[code[0]] || '#8b98a5');
  }
  for (const [err, count] of Object.entries(errors)) {
    labels.push(err);
    data.push(count);
    colors.push('#6e40c9');
  }
  statusChart.data.labels = labels;
  statusChart.data.datasets[0].data = data;
  statusChart.data.datasets[0].backgroundColor = colors;
  statusChart.update();
}

function pushPoint(stats) {
  const t = stats.elapsed + 's';
  rpsChart.data.labels.push(t);
  rpsChart.data.datasets[0].data.push(stats.rps);
  latChart.data.labels.push(t);
  latChart.data.datasets[0].data.push(stats.avgLatency);
  latChart.data.datasets[1].data.push(stats.p95);
  latChart.data.datasets[2].data.push(stats.p99);
  rpsChart.update();
  latChart.update();
}

// ---- Live metrics ---------------------------------------------------------
function renderMetrics(s) {
  $('m-rps').textContent = s.rps;
  $('m-completed').textContent = s.completed;
  $('m-failed').textContent = s.failed;
  $('m-inflight').textContent = s.inFlight;
  $('m-avg').textContent = s.avgLatency;
  $('m-p95').textContent = s.p95;
  $('m-p99').textContent = s.p99;
  $('m-elapsed').textContent = s.elapsed;
}

// ---- WebSocket ------------------------------------------------------------
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => {
    const { type, payload } = JSON.parse(e.data);
    if (type === 'hello' || type === 'started') {
      if (payload.config) testData.config = payload.config;
      if (payload.running) setStatus('running', 'running');
    } else if (type === 'tick') {
      testData.ticks.push(payload);
      renderMetrics(payload);
      pushPoint(payload);
    } else if (type === 'done') {
      onFinished();
      testData.summary = payload;
      summaryBox.classList.remove('hidden');
      renderReport(payload, testData.ticks);
      $('summary-json').textContent = JSON.stringify(payload, null, 2);
      setStatus('done', `done (${payload.reason})`);
    } else if (type === 'error') {
      onFinished();
      formError.textContent = payload.message;
      setStatus('error', 'error');
    }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();

function onRunning() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus('running', 'running');
}
function onFinished() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

// ---- Click-to-insert placeholders -----------------------------------------
// Clicking a token in the hint drops it into the URL field at the caret
// (replacing any selection). We remember the caret because clicking the token
// would otherwise move focus out of the input.
const urlInput = $('url');
let urlCaret = { start: urlInput.value.length, end: urlInput.value.length };

const rememberCaret = () => {
  urlCaret = { start: urlInput.selectionStart, end: urlInput.selectionEnd };
};
['keyup', 'click', 'select', 'input'].forEach((evt) => urlInput.addEventListener(evt, rememberCaret));

document.querySelectorAll('.hint code').forEach((token) => {
  // Keep focus/selection in the input when the token is clicked.
  token.addEventListener('mousedown', (e) => e.preventDefault());
  token.addEventListener('click', () => {
    const text = token.textContent;
    const v = urlInput.value;
    const { start, end } = urlCaret;
    urlInput.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    urlInput.focus();
    urlInput.setSelectionRange(pos, pos);
    rememberCaret();
  });
});

// ---- Form actions ---------------------------------------------------------
$('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  let headers = {};
  let body = $('body').value.trim() || null;
  try {
    if ($('headers').value.trim()) headers = JSON.parse($('headers').value);
  } catch {
    formError.textContent = 'Headers must be valid JSON.';
    return;
  }

  const config = {
    url: $('url').value.trim(),
    method: $('method').value,
    concurrency: +$('concurrency').value,
    duration: +$('duration').value,
    totalRequests: +$('totalRequests').value,
    timeout: +$('timeout').value,
    delay: +$('delay').value,
    seqStart: +$('seqStart').value,
    headers,
    body,
  };

  resetCharts();
  summaryBox.classList.add('hidden');
  testData = { config, ticks: [], summary: null };

  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok) {
    formError.textContent = data.error || 'Failed to start test.';
    return;
  }
  onRunning();
});

stopBtn.addEventListener('click', async () => {
  await fetch('/api/stop', { method: 'POST' });
});

// ---- CSV report export ----------------------------------------------------
/** Quote a CSV cell, escaping embedded quotes. */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

function buildCsvReport() {
  const { config, ticks, summary } = testData;
  const lines = [];

  // Section 1: test configuration.
  lines.push('# Test Configuration');
  lines.push(csvRow(['Key', 'Value']));
  if (config) {
    for (const [k, v] of Object.entries(config)) {
      lines.push(csvRow([k, typeof v === 'object' ? JSON.stringify(v) : v]));
    }
  }
  lines.push('');

  // Section 2: summary metrics.
  if (summary) {
    lines.push('# Summary');
    lines.push(csvRow(['Metric', 'Value']));
    lines.push(csvRow(['stop reason', summary.reason]));
    lines.push(csvRow(['duration (s)', summary.durationSec]));
    lines.push(csvRow(['requests sent', summary.requests.sent]));
    lines.push(csvRow(['requests completed', summary.requests.completed]));
    lines.push(csvRow(['requests failed', summary.requests.failed]));
    lines.push(csvRow(['success rate (%)', summary.requests.successRate]));
    lines.push(csvRow(['throughput (req/s)', summary.throughput.rps]));
    lines.push(csvRow(['throughput (KB/s)', summary.throughput.kbPerSec]));
    lines.push(csvRow(['total bytes', summary.throughput.bytes]));
    lines.push(csvRow(['latency min (ms)', summary.latency.min]));
    lines.push(csvRow(['latency avg (ms)', summary.latency.avg]));
    lines.push(csvRow(['latency p50 (ms)', summary.latency.p50]));
    lines.push(csvRow(['latency p90 (ms)', summary.latency.p90]));
    lines.push(csvRow(['latency p95 (ms)', summary.latency.p95]));
    lines.push(csvRow(['latency p99 (ms)', summary.latency.p99]));
    lines.push(csvRow(['latency max (ms)', summary.latency.max]));
    lines.push('');

    // Section 3: status-code breakdown.
    lines.push('# Status Codes');
    lines.push(csvRow(['Status', 'Count']));
    for (const [code, count] of Object.entries(summary.statusCodes)) {
      lines.push(csvRow([code, count]));
    }
    lines.push('');

    // Section 4: errors (if any).
    const errKeys = Object.keys(summary.errors);
    if (errKeys.length) {
      lines.push('# Errors');
      lines.push(csvRow(['Error', 'Count']));
      for (const k of errKeys) lines.push(csvRow([k, summary.errors[k]]));
      lines.push('');
    }

    // Section 4b: latency distribution.
    if (summary.distribution && summary.distribution.length) {
      lines.push('# Latency Distribution (ms)');
      lines.push(csvRow(['Bucket', 'Count']));
      for (const b of summary.distribution) lines.push(csvRow([b.label, b.count]));
      lines.push('');
    }
  }

  // Section 5: per-second time series.
  lines.push('# Time Series (1s interval)');
  lines.push(csvRow(['elapsed_s', 'rps', 'completed', 'failed', 'in_flight', 'avg_ms', 'p50_ms', 'p95_ms', 'p99_ms']));
  for (const t of ticks) {
    lines.push(csvRow([t.elapsed, t.rps, t.completed, t.failed, t.inFlight, t.avgLatency, t.p50, t.p95, t.p99]));
  }

  return lines.join('\r\n');
}

$('download-btn').addEventListener('click', () => {
  if (!testData.summary && !testData.ticks.length) return;
  // BOM so Excel detects UTF-8 correctly.
  const csv = '﻿' + buildCsvReport();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = url;
  a.download = `load-test-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
