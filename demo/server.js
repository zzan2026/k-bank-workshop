const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
app.use(express.json());

const PORT = 3001;
const DIRS = {
  input: path.join(__dirname, 'input'),
  output: path.join(__dirname, 'output'),
  apiBridge: path.join(__dirname, 'api-bridge'),
  exports: path.join(__dirname, 'exports'),
  samples: path.join(__dirname, 'samples'),
};

// Ensure dirs exist
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Utility: Logging ────────────────────────────────────────────────
const C = { reset: '\x1b[0m', bright: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m', blue: '\x1b[34m' };

function log(icon, color, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${C.bright}[${ts}]${C.reset} ${color}${icon}${C.reset} ${msg}`);
}

// ─── Utility: CSV / JSON / XML converters ────────────────────────────
function csvToRecords(csv) {
  const lines = csv.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

function recordsToCsv(records) {
  if (!records.length) return '';
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  records.forEach(r => lines.push(headers.map(h => r[h] ?? '').join(',')));
  return lines.join('\n');
}

function recordsToXml(records, rootTag = 'transactions', itemTag = 'transaction') {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n`;
  records.forEach(r => {
    xml += `  <${itemTag}>\n`;
    Object.entries(r).forEach(([k, v]) => { xml += `    <${k}>${escXml(String(v))}</${k}>\n`; });
    xml += `  </${itemTag}>\n`;
  });
  xml += `</${rootTag}>`;
  return xml;
}

function escXml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function xmlToRecords(xml) {
  const records = [];
  const itemRe = /<transaction>([\s\S]*?)<\/transaction>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const obj = {};
    const fieldRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(m[1])) !== null) obj[f[1]] = f[2].trim();
    records.push(obj);
  }
  return records;
}

function parseFile(content, ext) {
  if (ext === '.csv') return csvToRecords(content);
  if (ext === '.json') return JSON.parse(content);
  if (ext === '.xml') return xmlToRecords(content);
  return null;
}

// ─── 1. File-to-File Transformation ─────────────────────────────────
function handleFileTransform(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext);
  if (!['.csv', '.json', '.xml'].includes(ext)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  let records;
  try {
    records = parseFile(content, ext);
  } catch (e) {
    log('❌', C.red, `Failed to parse ${path.basename(filePath)}: ${e.message}`);
    return;
  }
  if (!records || !records.length) { log('⚠️', C.yellow, `No records in ${path.basename(filePath)}`); return; }

  log('📥', C.cyan, `Detected ${path.basename(filePath)} (${records.length} records)`);

  const conversions = { '.csv': ['.json', '.xml'], '.json': ['.csv', '.xml'], '.xml': ['.csv', '.json'] };
  conversions[ext].forEach(target => {
    let out;
    if (target === '.json') out = JSON.stringify(records, null, 2);
    else if (target === '.csv') out = recordsToCsv(records);
    else out = recordsToXml(records);
    const outFile = path.join(DIRS.output, `${base}${target}`);
    fs.writeFileSync(outFile, out);
    log('📤', C.green, `  → output/${base}${target}`);
  });

  // Also publish to Kafka topic
  publishToTopic('file-transforms', { source: path.basename(filePath), recordCount: records.length, timestamp: new Date().toISOString() });
  log('📡', C.magenta, `  → Published event to topic "file-transforms"`);
}

// ─── 2. File-to-REST API Bridge ──────────────────────────────────────
function handleApiBridge(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.csv', '.json', '.xml'].includes(ext)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  let records;
  try { records = parseFile(content, ext); } catch (e) { log('❌', C.red, `Bridge parse error: ${e.message}`); return; }
  if (!records || !records.length) return;

  log('🌉', C.blue, `API Bridge: processing ${path.basename(filePath)} (${records.length} records)`);

  records.forEach((record, i) => {
    const data = JSON.stringify(record);
    const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/transactions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        log('🌉', C.blue, `  → Record ${i + 1}: ${res.statusCode} ${JSON.parse(body).message || ''}`);
      });
    });
    req.on('error', e => log('❌', C.red, `  → Record ${i + 1} failed: ${e.message}`));
    req.write(data);
    req.end();
  });
}

// ─── File Watchers ───────────────────────────────────────────────────
const debounce = {};
function watchDir(dir, handler) {
  fs.watch(dir, (event, filename) => {
    if (!filename) return;
    if (event !== 'rename' && event !== 'change') return;
    const fp = path.join(dir, filename);
    const key = fp;
    if (debounce[key]) return;
    debounce[key] = true;
    setTimeout(() => { delete debounce[key]; }, 1000);
    setTimeout(() => {
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) handler(fp);
    }, 300);
  });
}

watchDir(DIRS.input, handleFileTransform);
watchDir(DIRS.apiBridge, handleApiBridge);

// ─── 3. REST API: Transaction Store ──────────────────────────────────
const transactions = [];

app.post('/api/transactions', (req, res) => {
  const txn = { id: transactions.length + 1, ...req.body, received_at: new Date().toISOString() };
  transactions.push(txn);
  log('💰', C.green, `Transaction received: #${txn.id} ${txn.txn_id || ''} ${txn.amount || ''} ${txn.currency || ''}`);
  res.json({ status: 'accepted', message: `Transaction #${txn.id} stored`, transaction: txn });
});

app.get('/api/transactions', (req, res) => {
  log('📋', C.cyan, `Listing ${transactions.length} transactions`);
  res.json({ count: transactions.length, transactions });
});

// ─── 3. REST-to-File Export ──────────────────────────────────────────
app.post('/api/export', (req, res) => {
  const format = (req.query.format || 'json').toLowerCase();
  if (!['csv', 'json', 'xml'].includes(format)) return res.status(400).json({ error: 'Format must be csv, json, or xml' });

  const ts = Date.now();
  const filename = `export-${ts}.${format}`;
  let content;
  if (format === 'json') content = JSON.stringify(transactions, null, 2);
  else if (format === 'csv') content = recordsToCsv(transactions);
  else content = recordsToXml(transactions);

  fs.writeFileSync(path.join(DIRS.exports, filename), content);
  log('💾', C.yellow, `Exported ${transactions.length} transactions → exports/${filename}`);
  res.json({ status: 'exported', file: filename, count: transactions.length });
});

// ─── 4. Kafka-style Pub/Sub ──────────────────────────────────────────
const topics = {};
const subscribers = {};

function publishToTopic(topic, message) {
  if (!topics[topic]) topics[topic] = [];
  const msg = { offset: topics[topic].length, timestamp: new Date().toISOString(), data: message };
  topics[topic].push(msg);
  // Notify SSE subscribers
  (subscribers[topic] || []).forEach(res => {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  });
  return msg;
}

app.post('/api/publish/:topic', (req, res) => {
  const msg = publishToTopic(req.params.topic, req.body);
  log('📡', C.magenta, `Published to "${req.params.topic}" offset=${msg.offset}`);
  res.json({ status: 'published', topic: req.params.topic, offset: msg.offset });
});

app.get('/api/subscribe/:topic', (req, res) => {
  const topic = req.params.topic;
  if (!topics[topic]) topics[topic] = [];
  if (!subscribers[topic]) subscribers[topic] = [];

  // SSE mode
  if (req.headers.accept === 'text/event-stream') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    log('👂', C.magenta, `SSE subscriber connected to "${topic}"`);
    // Send existing messages
    topics[topic].forEach(msg => res.write(`data: ${JSON.stringify(msg)}\n\n`));
    subscribers[topic].push(res);
    req.on('close', () => {
      subscribers[topic] = subscribers[topic].filter(s => s !== res);
      log('👋', C.magenta, `SSE subscriber disconnected from "${topic}"`);
    });
  } else {
    // Poll mode
    res.json({ topic, messages: topics[topic] });
  }
});

app.get('/api/topics', (req, res) => {
  const summary = {};
  Object.keys(topics).forEach(t => summary[t] = topics[t].length);
  res.json(summary);
});

// ─── Homepage ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Core Banking Integration Demo</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:#0f172a; color:#e2e8f0; min-height:100vh; }
    .header { background:linear-gradient(135deg,#1e293b,#0f172a); border-bottom:1px solid #1e293b; padding:32px 40px; }
    .header h1 { font-size:1.8rem; font-weight:700; margin-bottom:6px; }
    .header h1 span { color:#3b82f6; }
    .header p { color:#64748b; font-size:0.9rem; }
    .main { max-width:960px; margin:0 auto; padding:32px 24px; }
    .section-title { font-size:0.7rem; letter-spacing:2px; text-transform:uppercase; color:#64748b; font-weight:600; margin-bottom:16px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; margin-bottom:40px; }
    .card { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:24px; transition:border-color 0.2s; }
    .card:hover { border-color:#3b82f6; }
    .card-icon { font-size:1.5rem; margin-bottom:10px; }
    .card h3 { font-size:1rem; font-weight:600; margin-bottom:6px; }
    .card p { font-size:0.85rem; color:#94a3b8; line-height:1.6; }
    .endpoint { font-family:'Space Mono',monospace; font-size:0.8rem; background:#0f172a; border:1px solid #334155; border-radius:6px; padding:10px 14px; margin-top:12px; color:#38bdf8; display:flex; align-items:center; gap:8px; }
    .method { font-weight:700; font-size:0.7rem; padding:2px 8px; border-radius:4px; }
    .get { background:#22c55e20; color:#22c55e; }
    .post { background:#3b82f620; color:#3b82f6; }
    .try-section { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:24px; margin-bottom:24px; }
    .try-section h3 { font-size:1rem; margin-bottom:16px; }
    .btn { background:#3b82f6; color:#fff; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-family:'Inter',sans-serif; font-size:0.85rem; font-weight:500; transition:background 0.2s; margin-right:8px; margin-bottom:8px; }
    .btn:hover { background:#2563eb; }
    .btn-green { background:#22c55e; }
    .btn-green:hover { background:#16a34a; }
    .btn-yellow { background:#eab308; color:#0f172a; }
    .btn-yellow:hover { background:#ca8a04; }
    .output { font-family:'Space Mono',monospace; font-size:0.8rem; background:#0f172a; border:1px solid #334155; border-radius:6px; padding:16px; margin-top:16px; min-height:80px; white-space:pre-wrap; color:#94a3b8; overflow-x:auto; max-height:300px; overflow-y:auto; }
    .status { display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e; margin-right:8px; animation:pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    .footer { text-align:center; padding:24px; color:#475569; font-size:0.8rem; border-top:1px solid #1e293b; margin-top:40px; }
  </style>
</head>
<body>
  <div class="header">
    <h1><span>Core Banking</span> Integration Demo</h1>
    <p><span class="status"></span>Running on port ${PORT} &mdash; File watchers active</p>
  </div>
  <div class="main">
    <div class="section-title">Integration Patterns</div>
    <div class="cards">
      <div class="card">
        <div class="card-icon">📁</div>
        <h3>File-to-File Transform</h3>
        <p>Drop CSV, JSON, or XML files into <strong>input/</strong> and they auto-convert to all other formats in <strong>output/</strong>.</p>
      </div>
      <div class="card">
        <div class="card-icon">🌉</div>
        <h3>File-to-API Bridge</h3>
        <p>Drop files into <strong>api-bridge/</strong> and each record is automatically POSTed to the REST API.</p>
      </div>
      <div class="card">
        <div class="card-icon">💾</div>
        <h3>REST-to-File Export</h3>
        <p>Export stored transactions back to CSV, JSON, or XML files in <strong>exports/</strong>.</p>
        <div class="endpoint"><span class="method post">POST</span>/api/export?format=json</div>
      </div>
      <div class="card">
        <div class="card-icon">📡</div>
        <h3>Kafka-style Pub/Sub</h3>
        <p>Publish messages to topics and subscribe via SSE for real-time streaming.</p>
        <div class="endpoint"><span class="method post">POST</span>/api/publish/:topic</div>
        <div class="endpoint"><span class="method get">GET</span>/api/subscribe/:topic</div>
      </div>
    </div>

    <div class="section-title">API Endpoints</div>
    <div class="cards">
      <div class="card">
        <h3>Transactions</h3>
        <div class="endpoint"><span class="method get">GET</span>/api/transactions</div>
        <div class="endpoint"><span class="method post">POST</span>/api/transactions</div>
      </div>
      <div class="card">
        <h3>Topics</h3>
        <div class="endpoint"><span class="method get">GET</span>/api/topics</div>
      </div>
    </div>

    <div class="section-title">Try It Live</div>
    <div class="try-section">
      <h3>Quick Actions</h3>
      <button class="btn" onclick="listTxns()">List Transactions</button>
      <button class="btn btn-green" onclick="addSample()">Add Sample Transaction</button>
      <button class="btn btn-yellow" onclick="exportTxns('json')">Export JSON</button>
      <button class="btn btn-yellow" onclick="exportTxns('csv')">Export CSV</button>
      <button class="btn btn-yellow" onclick="exportTxns('xml')">Export XML</button>
      <div class="output" id="output">Click a button above to try the API...</div>
    </div>
  </div>
  <div class="footer">K-Bank Integration Workshop &mdash; Core Banking Demo</div>

  <script>
    const out = document.getElementById('output');
    function show(data) { out.textContent = JSON.stringify(data, null, 2); }

    async function listTxns() {
      out.textContent = 'Loading...';
      const res = await fetch('/api/transactions');
      show(await res.json());
    }

    async function addSample() {
      out.textContent = 'Sending...';
      const txn = {
        txn_id: 'TXN-' + Date.now(),
        account: 'ACC-' + Math.floor(Math.random()*9000+1000),
        amount: (Math.random()*10000).toFixed(2),
        currency: ['USD','EUR','GBP','SGD','THB'][Math.floor(Math.random()*5)],
        type: ['credit','debit'][Math.floor(Math.random()*2)],
        description: 'Sample transaction from dashboard'
      };
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(txn)
      });
      show(await res.json());
    }

    async function exportTxns(format) {
      out.textContent = 'Exporting...';
      const res = await fetch('/api/export?format=' + format, { method: 'POST' });
      show(await res.json());
    }
  </script>
</body>
</html>`);
});

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log(`${C.bright}╔══════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bright}║   🏦 Core Banking Integration Demo — Port ${PORT}          ║${C.reset}`);
  console.log(`${C.bright}╠══════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.bright}║${C.reset}  📁 Drop files in input/      → auto-convert to output/ ${C.bright}║${C.reset}`);
  console.log(`${C.bright}║${C.reset}  🌉 Drop files in api-bridge/ → POST to REST API        ${C.bright}║${C.reset}`);
  console.log(`${C.bright}║${C.reset}  💾 POST /api/export?format=  → export to exports/       ${C.bright}║${C.reset}`);
  console.log(`${C.bright}║${C.reset}  📡 /api/publish & subscribe  → Kafka-style pub/sub      ${C.bright}║${C.reset}`);
  console.log(`${C.bright}╚══════════════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
  log('✅', C.green, 'Watching input/ and api-bridge/ for files...');
  console.log('');
});
