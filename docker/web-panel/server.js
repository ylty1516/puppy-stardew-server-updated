/**
 * Puppy Stardew Server - Web Management Panel
 * Main server entry point
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { AppError, sendError } = require('./errors');

// ─── Configuration ───────────────────────────────────────────────
const PORT = parseInt(process.env.PANEL_PORT || '18642', 10);

// Paths (inside container)
const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(__dirname, 'data');
const STATUS_FILE = process.env.STATUS_FILE || '/home/steam/.local/share/puppy-stardew/status.json';
const LOG_DIR = process.env.LOG_DIR || '/home/steam/.local/share/puppy-stardew/logs';
const SAVES_DIR = process.env.SAVES_DIR || '/home/steam/.config/StardewValley/Saves';
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/home/steam/.local/share/puppy-stardew/backups';
const GAME_DIR = process.env.GAME_DIR || '/home/steam/stardewvalley';
const SMAPI_LOG = process.env.SMAPI_LOG || '/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt';
const ENV_FILE = process.env.ENV_FILE || '/home/steam/web-panel/data/runtime.env';
const MANUAL_PAUSE_FILE = process.env.MANUAL_PAUSE_FILE || '/home/steam/web-panel/data/manual-pause.json';
const AUTO_PAUSE_FILE = process.env.AUTO_PAUSE_FILE || '/home/steam/web-panel/data/auto-pause.json';
const GAME_STATE_FILE = process.env.GAME_STATE_FILE || '/home/steam/web-panel/data/game-state.json';
const HOST_COMMAND_FILE = process.env.HOST_COMMAND_FILE || '/home/steam/web-panel/data/host-command.json';
const SERVER_AUTOLOAD_STATE_FILE = process.env.SERVER_AUTOLOAD_STATE_FILE || '/home/steam/web-panel/data/server-autoload-state.json';
const META_DIR = process.env.PUPPY_META_DIR || path.join(DATA_DIR, 'meta');
const MOD_GRAPH_FILE = process.env.MOD_GRAPH_FILE || path.join(META_DIR, 'mod_graph.json');
const WORLD_FINGERPRINT_FILE = process.env.WORLD_FINGERPRINT_FILE || path.join(META_DIR, 'world_fingerprint.json');
const ORCHESTRATION_STATE_FILE = process.env.ORCHESTRATION_STATE_FILE || path.join(META_DIR, 'orchestration-state.json');

// Export paths for use by API modules
const config = {
  PORT,
  DATA_DIR,
  STATUS_FILE,
  LOG_DIR,
  SAVES_DIR,
  BACKUPS_DIR,
  GAME_DIR,
  SMAPI_LOG,
  ENV_FILE,
  MANUAL_PAUSE_FILE,
  AUTO_PAUSE_FILE,
  GAME_STATE_FILE,
  HOST_COMMAND_FILE,
  SERVER_AUTOLOAD_STATE_FILE,
  META_DIR,
  MOD_GRAPH_FILE,
  WORLD_FINGERPRINT_FILE,
  ORCHESTRATION_STATE_FILE,
};
module.exports = config;

// ─── Express App ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Web Panel] Port ${PORT} is already in use. Stop the conflicting process or set PANEL_PORT to another port.`);
  } else if (err && err.code === 'EACCES') {
    console.error(`[Web Panel] No permission to listen on port ${PORT}. Use a higher port or adjust container permissions.`);
  } else {
    console.error('[Web Panel] HTTP server error:', err);
  }
  process.exit(1);
});

// Middleware
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: false, limit: '150mb' }));

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return sendError(res, req, new AppError('Request body is too large', {
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      cause: 'The uploaded payload exceeded the panel request limit.',
      action: 'Upload a smaller archive or increase the panel body limit intentionally.',
    }));
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, req, new AppError('Invalid JSON request body', {
      status: 400,
      code: 'INVALID_JSON',
      cause: 'The request body could not be parsed as JSON.',
      action: 'Retry with a valid JSON payload.',
    }));
  }
  return sendError(res, req, err);
});

// ─── Auth Routes (no JWT required) ───────────────────────────────
app.get('/api/auth/status', auth.getStatus);
app.post('/api/auth/setup', auth.setup);
app.post('/api/auth/login', auth.login);
app.get('/api/auth/verify', auth.verifyMiddleware, auth.verify);
app.post('/api/auth/password', auth.verifyMiddleware, auth.changePassword);

// ─── API Routes (JWT required) ──────────────────────────────────
// Status API
const statusAPI = require('./api/status');
app.get('/api/status', auth.verifyMiddleware, statusAPI.getStatus);

// World state API
const worldStateAPI = require('./api/world-state');
app.get('/api/world', auth.verifyMiddleware, worldStateAPI.getWorldState);
app.post('/api/world/accept', auth.verifyMiddleware, worldStateAPI.acceptWorldFingerprint);

// Logs API
const logsAPI = require('./api/logs');
app.get('/api/logs', auth.verifyMiddleware, logsAPI.getLogs);

// Changelog API
const changelogAPI = require('./api/changelog');
app.get('/api/changelog', auth.verifyMiddleware, changelogAPI.getChangelog);

// Players API
const playersAPI = require('./api/players');
app.get('/api/players', auth.verifyMiddleware, playersAPI.getPlayers);

// Saves API
const savesAPI = require('./api/saves');
app.get('/api/saves', auth.verifyMiddleware, savesAPI.getSaves);
app.get('/api/saves/backups', auth.verifyMiddleware, savesAPI.getBackups);
app.get('/api/saves/backup/status', auth.verifyMiddleware, savesAPI.getBackupStatus);
app.post('/api/saves/backup', auth.verifyMiddleware, savesAPI.createBackup);
app.post('/api/saves/upload', auth.verifyMiddleware, savesAPI.uploadSave);
app.post('/api/saves/default', auth.verifyMiddleware, savesAPI.setDefaultSave);
app.get('/api/saves/download/:filename', auth.verifyMiddleware, savesAPI.downloadBackup);

// Config API
const configAPI = require('./api/config');
app.get('/api/config', auth.verifyMiddleware, configAPI.getConfig);
app.put('/api/config', auth.verifyMiddleware, configAPI.updateConfig);

// Recommendation API
const recommendationsAPI = require('./api/recommendations');
app.get('/api/recommendations/server', auth.verifyMiddleware, recommendationsAPI.getServerRecommendations);

// Server control API
app.post('/api/server/restart', auth.verifyMiddleware, statusAPI.restartServer);
app.post('/api/container/restart', auth.verifyMiddleware, statusAPI.restartContainer);
app.get('/api/game/pause', auth.verifyMiddleware, statusAPI.getManualPause);
app.post('/api/game/pause', auth.verifyMiddleware, statusAPI.setManualPause);
app.get('/api/game/auto-pause', auth.verifyMiddleware, statusAPI.getAutoPause);
app.post('/api/game/auto-pause', auth.verifyMiddleware, statusAPI.setAutoPause);
const hostAPI = require('./api/host');
app.post('/api/host/expansion-init/start', auth.verifyMiddleware, hostAPI.startExpansionInit);
app.post('/api/host/expansion-init/finish', auth.verifyMiddleware, hostAPI.finishExpansionInit);

// Panel update API
const updateAPI = require('./api/update');
app.get('/api/update/status', auth.verifyMiddleware, updateAPI.getUpdateStatus);
app.post('/api/update', auth.verifyMiddleware, updateAPI.startUpdate);

// Maintenance API
const maintenanceAPI = require('./api/maintenance');
app.get('/api/maintenance/factory-reset/status', auth.verifyMiddleware, maintenanceAPI.getFactoryResetStatus);
app.post('/api/maintenance/factory-reset', auth.verifyMiddleware, maintenanceAPI.startFactoryReset);
app.get('/api/maintenance/uninstall/status', auth.verifyMiddleware, maintenanceAPI.getUninstallStatus);
app.post('/api/maintenance/uninstall', auth.verifyMiddleware, maintenanceAPI.startUninstall);

// Mods API
const modsAPI = require('./api/mods');
app.get('/api/public/mods', modsAPI.getPublicMods);
app.get('/api/public/mods/manifest.json', modsAPI.getPublicMods);
app.get('/api/public/mods/client-pack', modsAPI.downloadClientPack);
app.get('/api/public/mods/download/:folder', modsAPI.downloadPublicMod);
app.get('/api/mods', auth.verifyMiddleware, modsAPI.getMods);
app.get('/api/mods/client-pack', auth.verifyMiddleware, modsAPI.downloadClientPack);
app.get('/api/mods/download/:folder', auth.verifyMiddleware, modsAPI.downloadMod);
app.get('/api/mods/backups', auth.verifyMiddleware, modsAPI.listModBackups);
app.get('/api/mods/backups/download/:filename', auth.verifyMiddleware, modsAPI.downloadModBackup);
app.post('/api/mods/rollback/:filename', auth.verifyMiddleware, modsAPI.rollbackModBackup);
app.post('/api/mods/upload', auth.verifyMiddleware, modsAPI.uploadMod);
app.delete('/api/mods/custom', auth.verifyMiddleware, modsAPI.clearCustomMods);
app.delete('/api/mods/:folder', auth.verifyMiddleware, modsAPI.deleteMod);

// Diagnostics API
const diagnosticsAPI = require('./api/diagnostics');
app.get('/api/health', auth.verifyMiddleware, diagnosticsAPI.getHealth);
app.post('/api/health/repair', auth.verifyMiddleware, diagnosticsAPI.repairHealth);
app.get('/api/reports/crash', auth.verifyMiddleware, diagnosticsAPI.exportCrashReport);

// ─── Static Files ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/player-mods', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player-mods.html'));
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return sendError(res, req, new AppError('API route not found', {
      status: 404,
      code: 'API_NOT_FOUND',
      cause: 'No handler is registered for this API path.',
      action: 'Check the request URL and HTTP method.',
    }));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  return sendError(res, req, err);
});

// ─── WebSocket Server ────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Parse token from query string
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token || !auth.verifyToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[WebSocket] Client connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWebSocketMessage(ws, msg);
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'INVALID_WS_MESSAGE',
        message: 'Invalid WebSocket message format',
        cause: 'The message was not valid JSON.',
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    // Clean up any log subscriptions or terminal sessions
    if (ws._logWatcher) {
      ws._logWatcher.close();
      ws._logWatcher = null;
    }
    if (ws._terminalProc) {
      ws._terminalProc.kill();
      ws._terminalProc = null;
    }
  });
});

function handleWebSocketMessage(ws, msg) {
  switch (msg.type) {
    case 'subscribe':
      if (msg.channel === 'logs') {
        logsAPI.subscribeLogs(ws, msg.filter || 'all');
      } else if (msg.channel === 'status') {
        statusAPI.subscribeStatus(ws);
      }
      break;

    case 'unsubscribe':
      if (msg.channel === 'logs' && ws._logWatcher) {
        ws._logWatcher.close();
        ws._logWatcher = null;
      }
      break;

    case 'terminal:input':
      const terminalAPI = require('./api/terminal');
      terminalAPI.handleInput(ws, msg.data);
      break;

    case 'terminal:open':
      const terminalAPI2 = require('./api/terminal');
      terminalAPI2.openTerminal(ws);
      break;

    case 'terminal:close':
      if (ws._terminalProc) {
        ws._terminalProc.kill();
        ws._terminalProc = null;
      }
      break;

    default:
      ws.send(JSON.stringify({
        type: 'error',
        code: 'UNKNOWN_WS_MESSAGE',
        message: `Unknown message type: ${msg.type}`,
        cause: 'The panel does not have a handler for this WebSocket message type.',
      }));
  }
}

// ─── Initialize & Start ──────────────────────────────────────────
async function start() {
  // Initialize auth and detect whether first-run setup is required.
  await auth.initialize(DATA_DIR);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Web Panel] ✅ Management panel running on http://0.0.0.0:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[Web Panel] Failed to start:', err);
    process.exit(1);
  });
}
