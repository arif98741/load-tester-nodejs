import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadTester } from './src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Only one test runs at a time.
let activeTest = null;

/** Send a JSON message to every connected dashboard. */
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

app.post('/api/start', (req, res) => {
  if (activeTest && activeTest.running) {
    return res.status(409).json({ error: 'A test is already running.' });
  }

  const config = req.body || {};
  if (!config.url) {
    return res.status(400).json({ error: 'A target URL is required.' });
  }

  const tester = new LoadTester(config);
  activeTest = tester;

  tester.on('tick', (stats) => broadcast('tick', stats));
  tester.on('done', (summary) => {
    broadcast('done', summary);
    activeTest = null;
  });
  tester.on('error', (err) => {
    broadcast('error', { message: err.message });
    activeTest = null;
  });

  tester.start();
  broadcast('started', { config: tester.config });
  res.json({ ok: true, config: tester.config });
});

app.post('/api/stop', (_req, res) => {
  if (activeTest && activeTest.running) {
    activeTest.stop('manual');
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'No test is running.' });
});

app.get('/api/status', (_req, res) => {
  res.json({ running: !!(activeTest && activeTest.running) });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', payload: { running: !!(activeTest && activeTest.running) } }));
});

server.listen(PORT, () => {
  console.log(`\n  Load Tester dashboard running at http://localhost:${PORT}\n`);
});
