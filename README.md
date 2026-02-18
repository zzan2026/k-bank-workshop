# 🏦 Core Banking Integration Demo

Interactive demo showing bidirectional integration patterns between a Core Banking platform and Bank K's external systems, with a live web dashboard.

## What It Demonstrates

### Inbound (Bank K → Core Banking)
- **CSV file** → Middleware converts → JSON (REST + Kafka + MQ)
- **XML file** → Middleware converts → JSON (REST + Kafka + MQ)

### Outbound (Core Banking → Bank K)
- **Payment Status** — JSON → Middleware → CSV/XML for Bank K
- **Account Statement** — JSON ledger → Middleware → CSV/XML
- **Notifications** — JSON event → Middleware → XML
- **FX Rates** — JSON rates → Middleware → CSV/XML
- **REST API / Kafka / MQ** — JSON → Middleware → CSV for Bank K

### Key Concepts
- **Middleware** sits between systems, handling format conversion
- **Bank K** only speaks CSV and XML
- **Core Banking** works natively with JSON, REST API, Kafka, and MQ
- **Drill-down** on any event to see the exact source format and output format side by side

---

## Prerequisites

- **Node.js** v18 or later — [https://nodejs.org](https://nodejs.org)

To check if Node.js is installed:
```bash
node --version
npm --version
```

---

## Installation & Running

### macOS / Linux

```bash
# 1. Navigate to the demo folder
cd workshop/demo

# 2. Install dependencies
npm install

# 3. Start the server
node server.js

# 4. Open in browser
open http://localhost:3001
```

### Windows (Command Prompt)

```cmd
REM 1. Navigate to the demo folder
cd workshop\demo

REM 2. Install dependencies
npm install

REM 3. Start the server
node server.js

REM 4. Open in browser
start http://localhost:3001
```

### Windows (PowerShell)

```powershell
# 1. Navigate to the demo folder
cd workshop\demo

# 2. Install dependencies
npm install

# 3. Start the server
node server.js

# 4. Open in browser
Start-Process http://localhost:3001
```

### Windows (Git Bash / WSL)

```bash
# Same as macOS / Linux
cd workshop/demo
npm install
node server.js
# Open http://localhost:3001 in your browser
```

---

## Installing Node.js on Windows

If you don't have Node.js installed:

1. **Download** the Windows installer from [https://nodejs.org](https://nodejs.org) (LTS recommended)
2. **Run** the `.msi` installer — accept defaults, ensure "Add to PATH" is checked
3. **Restart** your terminal (Command Prompt / PowerShell)
4. **Verify** installation:
   ```cmd
   node --version
   npm --version
   ```

Alternatively, using **winget**:
```cmd
winget install OpenJS.NodeJS.LTS
```

Or using **Chocolatey**:
```cmd
choco install nodejs-lts
```

---

## Using the Dashboard

1. **Open** [http://localhost:3001](http://localhost:3001) in any modern browser
2. **Left column (Core Banking)** — Click buttons to trigger outbound events
3. **Right column (Bank K)** — Click buttons to send CSV/XML inbound
4. **Click any event row** to drill down and see:
   - Source format (what was sent)
   - Middleware conversion step (if applicable)
   - Output format (what was received on the other side)
   - Tabbed view for multi-format outputs
5. **🔄 Reset Demo** button clears all data for a fresh run

---

## Project Structure

```
demo/
├── server.js          # Express server with all integration logic
├── package.json       # Dependencies (express)
├── public/
│   └── index.html     # Web dashboard (single-page app)
├── samples/
│   └── transactions.csv
├── input/             # Drop CSV/XML here (Bank K → Core Banking)
├── output/            # Auto-generated transformed files
├── api-bridge/        # File-to-REST bridge folder
├── outbound/          # Files delivered to Bank K
└── exports/           # Exported transaction files
```

---

## Port

The server runs on **port 3001** by default. If you need to change it, edit the `PORT` constant at the top of `server.js`.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `node` not recognised | Install Node.js and restart your terminal |
| Port 3001 in use | Kill the other process or change `PORT` in `server.js` |
| `npm install` fails | Check internet connection; try `npm install --legacy-peer-deps` |
| Files not transforming | Ensure you drop `.csv` or `.xml` files into `input/` |
| Windows file watch issues | File watchers may behave differently on Windows; restart the server if files aren't detected |
