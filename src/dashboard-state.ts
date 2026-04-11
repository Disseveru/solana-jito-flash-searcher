import { config } from './config.js';

const LOG_LIMIT = 10;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export type DashboardSnapshot = {
  botRunning: boolean;
  simulationMode: boolean;
  totalSolEarned: string;
  lastTradeProfit: string;
  logs: string[];
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;

let botRunning = true;
let simulationMode = config.get('simulation_mode');
let totalProfitLamports = 0n;
let lastTradeProfitLamports = 0n;
const logs: string[] = [];
const listeners = new Set<DashboardListener>();

function emitUpdate(): void {
  const snapshot = getDashboardSnapshot();
  listeners.forEach((listener) => listener(snapshot));
}

export function formatLamportsAsSol(lamports: bigint): string {
  const isNegative = lamports < 0n;
  const absolute = isNegative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  const amount = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();

  return isNegative ? `-${amount}` : amount;
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return {
    botRunning,
    simulationMode,
    totalSolEarned: formatLamportsAsSol(totalProfitLamports),
    lastTradeProfit: formatLamportsAsSol(lastTradeProfitLamports),
    logs: [...logs],
  };
}

export function onDashboardUpdate(listener: DashboardListener): () => void {
  listeners.add(listener);
  listener(getDashboardSnapshot());
  return () => listeners.delete(listener);
}

export function isBotRunning(): boolean {
  return botRunning;
}

export function setBotRunning(nextValue: boolean): void {
  if (botRunning === nextValue) {
    return;
  }
  botRunning = nextValue;
  emitUpdate();
}

export function isSimulationModeEnabled(): boolean {
  return simulationMode;
}

export function setSimulationMode(nextValue: boolean): void {
  if (simulationMode === nextValue) {
    return;
  }
  simulationMode = nextValue;
  emitUpdate();
}

export function pushDashboardLog(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  logs.push(`[${timestamp}] ${message}`);
  if (logs.length > LOG_LIMIT) {
    logs.shift();
  }
  emitUpdate();
}

export function recordRealizedProfit(expectedProfitLamports: bigint): void {
  totalProfitLamports += expectedProfitLamports;
  lastTradeProfitLamports = expectedProfitLamports;
  emitUpdate();
}
