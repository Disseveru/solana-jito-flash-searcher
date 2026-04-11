import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  getDashboardSnapshot,
  isBotRunning,
  isSimulationModeEnabled,
  onDashboardUpdate,
  pushDashboardLog,
  setBotRunning,
  setSimulationMode,
} from './dashboard-state.js';

const DASHBOARD_PORT = config.get('dashboard_port');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

let isStarted = false;

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MEV Bot Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Arial, Helvetica, sans-serif;
      }
      body {
        margin: 0;
        background: #050505;
        color: #ffffff;
      }
      main {
        max-width: 640px;
        margin: 0 auto;
        padding: 16px;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 1.8rem;
        text-align: center;
      }
      .controls {
        display: grid;
        gap: 12px;
      }
      button {
        width: 100%;
        border: 2px solid #ffffff;
        border-radius: 12px;
        font-size: 1.15rem;
        font-weight: 700;
        min-height: 58px;
        color: #ffffff;
        background: #222222;
      }
      button.running {
        background: #007f2d;
      }
      button.stopped {
        background: #8f1d1d;
      }
      button.dry-run {
        background: #1f4eb3;
      }
      button.live {
        background: #a66a00;
      }
      .profits {
        margin-top: 16px;
        display: grid;
        gap: 12px;
      }
      .card {
        border: 2px solid #ffffff;
        border-radius: 12px;
        padding: 12px;
        background: #111111;
      }
      .label {
        font-size: 1rem;
        opacity: 0.9;
      }
      .value {
        margin-top: 6px;
        font-size: 1.8rem;
        font-weight: 700;
      }
      .logs {
        margin-top: 16px;
      }
      pre {
        margin: 8px 0 0;
        border: 2px solid #ffffff;
        border-radius: 12px;
        background: #000000;
        color: #75ff6a;
        padding: 12px;
        min-height: 200px;
        max-height: 260px;
        overflow-y: auto;
        font-size: 0.86rem;
        line-height: 1.35;
        white-space: pre-wrap;
      }
      .url {
        margin-top: 12px;
        font-size: 0.92rem;
        color: #dddddd;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>MEV Bot Dashboard</h1>
      <section class="controls">
        <button id="toggle-run">START BOT</button>
        <button id="toggle-mode">Mode: Dry Run</button>
      </section>

      <section class="profits">
        <article class="card">
          <div class="label">Total SOL Earned</div>
          <div class="value" id="total-sol">0 SOL</div>
        </article>
        <article class="card">
          <div class="label">Last Trade Profit</div>
          <div class="value" id="last-profit">0 SOL</div>
        </article>
      </section>

      <section class="logs">
        <h2>Live Logs (Last 10)</h2>
        <pre id="logs">Waiting for activity...</pre>
      </section>
    </main>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const state = {
        botRunning: true,
        simulationMode: true,
        totalSolEarned: '0',
        lastTradeProfit: '0',
        logs: [],
      };

      const runButton = document.getElementById('toggle-run');
      const modeButton = document.getElementById('toggle-mode');
      const totalSol = document.getElementById('total-sol');
      const lastProfit = document.getElementById('last-profit');
      const logs = document.getElementById('logs');

      const socket = io();

      function render() {
        runButton.textContent = state.botRunning ? 'STOP BOT' : 'START BOT';
        runButton.className = state.botRunning ? 'running' : 'stopped';

        modeButton.textContent = state.simulationMode
          ? 'Mode: Dry Run (tap for Live)'
          : 'Mode: Live (tap for Dry Run)';
        modeButton.className = state.simulationMode ? 'dry-run' : 'live';

        totalSol.textContent = state.totalSolEarned + ' SOL';
        lastProfit.textContent = state.lastTradeProfit + ' SOL';

        logs.textContent = state.logs.length ? state.logs.join('\\n') : 'Waiting for activity...';
        logs.scrollTop = logs.scrollHeight;
      }

      socket.on('dashboard:state', (nextState) => {
        Object.assign(state, nextState);
        render();
      });

      runButton.addEventListener('click', () => {
        socket.emit('dashboard:setRunning', !state.botRunning);
      });

      modeButton.addEventListener('click', () => {
        socket.emit('dashboard:setSimulationMode', !state.simulationMode);
      });

      render();
    </script>
  </body>
</html>`;

onDashboardUpdate((snapshot) => {
  if (!isStarted) {
    return;
  }
  io.emit('dashboard:state', snapshot);
});

app.get('/', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

io.on('connection', (socket) => {
  socket.emit('dashboard:state', getDashboardSnapshot());

  socket.on('dashboard:setRunning', (nextValue: unknown) => {
    if (typeof nextValue !== 'boolean') return;

    setBotRunning(nextValue);
    pushDashboardLog(`Bot ${nextValue ? 'started' : 'stopped'} from dashboard.`);
  });

  socket.on('dashboard:setSimulationMode', (nextValue: unknown) => {
    if (typeof nextValue !== 'boolean') return;

    setSimulationMode(nextValue);
    pushDashboardLog(
      `Simulation mode changed to ${nextValue ? 'Dry Run' : 'Live'}.`,
    );
  });
});

export async function startDashboardServer(): Promise<void> {
  if (isStarted) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(DASHBOARD_PORT, () => {
      httpServer.removeListener('error', reject);
      isStarted = true;
      logger.info(`Dashboard server listening on port ${DASHBOARD_PORT}`);
      pushDashboardLog(
        `Dashboard online on port ${DASHBOARD_PORT}. Bot is ${isBotRunning() ? 'running' : 'stopped'} in ${isSimulationModeEnabled() ? 'Dry Run' : 'Live'} mode.`,
      );
      resolve();
    });
  });
}
