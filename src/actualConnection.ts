import fs from 'fs';
import path from 'path';
import os from 'os';
import api from '@actual-app/api';
import logger from './logger.js';

const DEFAULT_DATA_DIR = path.resolve(os.homedir() || '.', '.actual');

let initialized = false;
let initializing = false;
let initializationError: Error | null = null;

export async function connectToActual() {
  if (initialized) return;
  if (initializing) {
    while (initializing) await new Promise(r => setTimeout(r, 100));
    if (initializationError) throw initializationError;
    return;
  }
  initializing = true;

  try {
    const SERVER_URL = process.env.ACTUAL_SERVER_URL;
    const PASSWORD = process.env.ACTUAL_PASSWORD;
    const BUDGET_SYNC_ID = process.env.ACTUAL_BUDGET_SYNC_ID;
    const DATA_DIR = process.env.MCP_BRIDGE_DATA_DIR || DEFAULT_DATA_DIR;

    if (!SERVER_URL) throw new Error('ACTUAL_SERVER_URL not set');
    if (!PASSWORD) throw new Error('ACTUAL_PASSWORD not set');
    if (!BUDGET_SYNC_ID) throw new Error('ACTUAL_BUDGET_SYNC_ID not set');
    new URL(SERVER_URL);

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    logger.info(`Initializing Actual API with dataDir=${DATA_DIR}`);

    await api.init({
      dataDir: DATA_DIR,
      serverURL: SERVER_URL,
      password: PASSWORD,
    });

    await api.downloadBudget(BUDGET_SYNC_ID);

    initialized = true;
    logger.info('✅ Connected to Actual Finance and downloaded budget');
  } catch (err) {
    initializationError = err instanceof Error ? err : new Error(String(err));
    logger.error('❌ Failed to connect to Actual Finance:', initializationError);
    throw initializationError;
  } finally {
    initializing = false;
  }
}
