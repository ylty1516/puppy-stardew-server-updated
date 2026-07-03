/**
 * Status API - Server status and metrics
 */

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('../server');
const { AppError, commandError, sendError } = require('../errors');

// Status history (in-memory, last 1 hour, every 15s = 240 entries)
const statusHistory = [];
const MAX_HISTORY = 240;

// WebSocket subscribers
const statusSubscribers = new Set();

// Cache
let cachedStatus = null;
let cacheTime = 0;
const CACHE_TTL = 3000; // 3 seconds

function readRecentLogLines(limit = 400) {
  try {
    if (!fs.existsSync(config.SMAPI_LOG)) {
      return [];
    }

    return fs.readFileSync(config.SMAPI_LOG, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit);
  } catch (error) {
    return [];
  }
}

function extractLogHints() {
  const lines = readRecentLogLines(500);
  let day = '';
  const connectedPlayers = new Set();
  let paused = false;

  function addPlayer(id) {
    if (id && id !== 'Server' && id !== 'SMAPI') {
      connectedPlayers.add(id);
    }
  }

  function removePlayer(id) {
    if (id) {
      connectedPlayers.delete(id);
    }
  }

  for (const line of lines) {
    const contextMatch = line.match(/Context:\s+loaded save '.*?', starting ([a-z]+ \d+ Y\d+)/i);
    if (contextMatch) {
      day = contextMatch[1];
    }

    const seasonMatch = line.match(/Season:\s*([a-z]+, Day \d+, Year \d+)/i);
    if (seasonMatch) {
      day = seasonMatch[1];
    }

    if (/Disconnected:\s*ServerOfflineMode/i.test(line)) {
      paused = true;
      connectedPlayers.clear();
    }

    if (/Starting LAN server|Starting server\. Protocol/i.test(line)) {
      paused = false;
    }

    let match = line.match(/Received connection for vanilla player ([A-Za-z0-9_]+)/i) ||
      line.match(/Approved request for farmhand ([A-Za-z0-9_]+)/i) ||
      line.match(/([A-Za-z0-9_]+) joined the game/i) ||
      line.match(/farmhand ([A-Za-z0-9_]+) connected/i) ||
      line.match(/client ([A-Za-z0-9_]+) connected/i) ||
      line.match(/peer ([A-Za-z0-9_]+) joined/i) ||
      line.match(/([A-Za-z0-9_]+) connected/i);
    if (match) {
      addPlayer(match[1]);
      paused = false;
      continue;
    }

    match = line.match(/([A-Za-z0-9_]+) left the game/i) ||
      line.match(/farmhand ([A-Za-z0-9_]+) disconnected/i) ||
      line.match(/client ([A-Za-z0-9_]+) disconnected/i) ||
      line.match(/peer ([A-Za-z0-9_]+) left/i) ||
      line.match(/connection ([A-Za-z0-9_]+) disconnected/i) ||
      line.match(/player ([A-Za-z0-9_]+) disconnected/i) ||
      line.match(/([A-Za-z0-9_]+) disconnected/i);
    if (match) {
      removePlayer(match[1]);
      if (connectedPlayers.size === 0) {
        paused = true;
      }
    }
  }

  return { day, players: connectedPlayers.size, paused };
}

function normalizeJoinHost(host) {
  if (!host) return '';

  const firstHost = host.split(',')[0].trim();
  const match = firstHost.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (match) {
    return match[1];
  }

  return firstHost.replace(/:\d+$/, '');
}

function getNetworkInfo(requestHost = '') {
  const configuredPublicIp = process.env.PUBLIC_IP || process.env.SERVER_IP || '';
  let localIps = [];

  try {
    localIps = execSync('hostname -I 2>/dev/null', { encoding: 'utf-8' })
      .trim()
      .split(/\s+/)
      .filter(ip => ip && ip !== '127.0.0.1' && ip !== '::1');
  } catch (error) {}

  const hostFromRequest = normalizeJoinHost(requestHost);
  const derivedJoinIp = hostFromRequest && hostFromRequest !== 'localhost' && hostFromRequest !== '127.0.0.1'
    ? hostFromRequest
    : '';

  return {
    joinIp: configuredPublicIp || derivedJoinIp || localIps[0] || '',
    localIps,
    joinPort: 24642,
    metricsPort: parseInt(process.env.METRICS_PORT || '9090', 10),
  };
}

function readManualPauseState() {
  const emptyState = {
    enabled: false,
    updatedAt: '',
    updatedBy: '',
    reason: '',
    file: config.MANUAL_PAUSE_FILE,
  };

  try {
    if (!config.MANUAL_PAUSE_FILE || !fs.existsSync(config.MANUAL_PAUSE_FILE)) {
      return emptyState;
    }

    const data = JSON.parse(fs.readFileSync(config.MANUAL_PAUSE_FILE, 'utf-8'));
    return {
      ...emptyState,
      enabled: data.enabled === true,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '',
      reason: typeof data.reason === 'string' ? data.reason : '',
    };
  } catch (error) {
    return {
      ...emptyState,
      error: error.message,
    };
  }
}

function writeManualPauseState(enabled, reason = '') {
  if (!config.MANUAL_PAUSE_FILE) {
    throw new AppError('Manual pause state path is not configured', {
      status: 500,
      code: 'MANUAL_PAUSE_NOT_CONFIGURED',
      cause: 'MANUAL_PAUSE_FILE is empty, so the panel cannot write the pause control file.',
      action: 'Set MANUAL_PAUSE_FILE or use the default container path.',
    });
  }

  const state = {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
    updatedBy: 'web-panel',
    reason: String(reason || '').slice(0, 240),
  };

  const dir = require('path').dirname(config.MANUAL_PAUSE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${config.MANUAL_PAUSE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, config.MANUAL_PAUSE_FILE);

  return {
    ...state,
    file: config.MANUAL_PAUSE_FILE,
  };
}

function readGameStateBridge() {
  const emptyState = {
    available: false,
    stale: true,
    ageSeconds: null,
    file: config.GAME_STATE_FILE,
  };

  try {
    if (!config.GAME_STATE_FILE || !fs.existsSync(config.GAME_STATE_FILE)) {
      return emptyState;
    }

    const data = JSON.parse(fs.readFileSync(config.GAME_STATE_FILE, 'utf-8'));
    const updatedAtMs = Date.parse(data.updatedAt || '');
    const ageSeconds = Number.isFinite(updatedAtMs)
      ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
      : null;
    const stale = ageSeconds === null || ageSeconds > 15;

    return {
      ...data,
      available: true,
      stale,
      ageSeconds,
      file: config.GAME_STATE_FILE,
    };
  } catch (error) {
    return {
      ...emptyState,
      error: error.message,
    };
  }
}

function formatGameDay(gameState) {
  if (!gameState || !gameState.worldReady) return '';
  const season = gameState.season || '';
  const day = gameState.day || 0;
  const year = gameState.year || 0;
  const time = gameState.timeOfDay || 0;
  const label = [season, day ? `Day ${day}` : '', year ? `Y${year}` : ''].filter(Boolean).join(' ');
  return time ? `${label} ${time}`.trim() : label;
}

function describeJoinable(gameState, gameRunning) {
  if (!gameRunning) {
    return {
      joinable: false,
      reason: 'game_process_stopped',
      label: 'Game process is not running',
      action: 'Start or restart the container.',
    };
  }

  if (!gameState || !gameState.available) {
    return {
      joinable: false,
      reason: 'state_bridge_missing',
      label: 'Waiting for SMAPI state bridge',
      action: 'Wait for the save to load, or check whether AutoHideHost is loaded.',
    };
  }

  if (gameState.stale) {
    return {
      joinable: false,
      reason: 'state_bridge_stale',
      label: 'SMAPI state is stale',
      action: 'Check whether the game is frozen or AutoHideHost stopped writing game-state.json.',
    };
  }

  const reason = gameState.joinableReason || (gameState.joinable ? 'ready' : 'unknown');
  const messages = {
    ready: ['Ready to join', 'Players should be able to join now.'],
    world_not_ready: ['Save is not loaded', 'Wait for ServerAutoLoad or load the save through VNC.'],
    not_main_server: ['Host is not the main server', 'Reload through Co-op so the host opens the multiplayer session.'],
    multiplayer_not_initialized: ['Multiplayer layer is not initialized', 'Use VNC to reload the save through Co-op, then retry.'],
    saving: ['Game is saving', 'Wait for saving to finish before joining or backing up.'],
    blocking_event: ['Blocked by an event', 'Advance or skip the host event if players cannot move.'],
    menu_open: ['Host menu is open', 'Automation may close it; use VNC if it stays open.'],
    unknown: ['Not joinable yet', 'Check SMAPI logs and host state.'],
  };
  const [label, action] = messages[reason] || messages.unknown;

  return {
    joinable: gameState.joinable === true,
    reason,
    label,
    action,
  };
}

function collectStatus(req = null) {
  const now = Date.now();
  if (cachedStatus && now - cacheTime < CACHE_TTL) {
    return cachedStatus;
  }

  const requestHost = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers['host'])) || '';

  const status = {
    timestamp: new Date().toISOString(),
    gameRunning: false,
    uptime: 0,
    players: { online: 0, max: 4 },
    cpu: 0,
    memory: { used: 0, limit: 2048 },
    day: 'Unknown',
    season: 'Unknown',
    backupCount: 0,
    modCount: 0,
    version: 'v1.1.0',
    scriptsHealthy: false,
    paused: false,
    manualPause: readManualPauseState(),
    gameState: readGameStateBridge(),
    joinability: {
      joinable: false,
      reason: 'unknown',
      label: 'Unknown',
      action: '',
    },
    health: {
      containerRunning: true,
      gameProcessRunning: false,
      smapiStateFresh: false,
      saveLoaded: false,
      multiplayerReady: false,
      joinable: false,
    },
    events: {
      passout: 0,
      readycheck: 0,
      offline: 0,
    },
    network: getNetworkInfo(requestHost),
  };

  // Read status.json from status-reporter.sh
  // The JSON has nested structure: { server: { game_running, uptime_seconds }, game: { day, players_online }, resources: { memory_mb, cpu_percent } }
  try {
    if (fs.existsSync(config.STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.STATUS_FILE, 'utf-8'));
      // Support nested structure from status-reporter.sh
      if (data.server) {
        status.gameRunning = data.server.game_running === true || data.server.game_running === 1;
        status.uptime = data.server.uptime_seconds || 0;
      }
      if (data.game) {
        status.players.online = data.game.players_online || 0;
        if (data.game.day) status.day = data.game.day;
        if (typeof data.game.paused === 'boolean') status.paused = data.game.paused;
      }
      if (data.resources) {
        status.cpu = parseFloat(data.resources.cpu_percent) || 0;
        status.memory.used = data.resources.memory_mb || 0;
      }
      if (data.events) {
        status.events.passout = data.events.passout || 0;
        status.events.readycheck = data.events.readycheck || 0;
        status.events.offline = data.events.offline || 0;
      }
      if (typeof data.scripts_healthy === 'boolean') {
        status.scriptsHealthy = data.scripts_healthy;
      }
      // Also support flat structure for backward compatibility
      if (!data.server && !data.game && !data.resources) {
        status.gameRunning = data.server_status === 'running' || data.game_running === 1;
        status.uptime = data.uptime_seconds || 0;
        status.players.online = data.players_online || 0;
        status.cpu = data.cpu_usage_percent || 0;
        status.memory.used = data.memory_usage_mb || 0;
        if (data.game_day) status.day = data.game_day;
        if (data.season) status.season = data.season;
        if (typeof data.paused === 'boolean') status.paused = data.paused;
        status.events.passout = data.passout || 0;
        status.events.readycheck = data.readycheck || 0;
        status.events.offline = data.offline || 0;
        if (typeof data.scripts_healthy === 'boolean') {
          status.scriptsHealthy = data.scripts_healthy;
        }
      }
    }
  } catch (e) {
    // status.json may not exist yet
  }

  // Check if game process is running (and collect live metrics if no status.json)
  try {
    const pidStr = execSync('pgrep -f StardewModdingAPI', { encoding: 'utf-8' }).trim().split('\n')[0];
    status.gameRunning = true;
    status.health.gameProcessRunning = true;

    // If we didn't get data from status.json, collect live
    if (status.cpu === 0 && status.memory.used === 0 && pidStr) {
      try {
        const cpuStr = execSync('ps -p ' + pidStr + ' -o %cpu= 2>/dev/null', { encoding: 'utf-8' }).trim();
        status.cpu = parseFloat(cpuStr) || 0;
      } catch (e2) {}
      try {
        const rssStr = execSync('grep VmRSS /proc/' + pidStr + '/status 2>/dev/null | awk \'{print $2}\'', { encoding: 'utf-8' }).trim();
        if (rssStr) status.memory.used = Math.round(parseInt(rssStr, 10) / 1024);
      } catch (e2) {}
    }

    // If no uptime from status.json, compute from process start time
    if (status.uptime === 0 && pidStr) {
      try {
        const startTime = execSync('stat -c %Y /proc/' + pidStr + ' 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (startTime) status.uptime = Math.floor(Date.now() / 1000) - parseInt(startTime, 10);
      } catch (e2) {}
    }
  } catch (e) {
    // Process not found
  }

  const hints = extractLogHints();
  if ((status.day === 'Unknown' || !status.day) && hints.day) {
    status.day = hints.day;
  }
  if (status.players.online === 0 && hints.players > 0) {
    status.players.online = hints.players;
  }
  if (hints.paused) {
    status.paused = true;
  }

  if (status.manualPause.enabled) {
    status.paused = true;
  }

  status.health.gameProcessRunning = status.gameRunning === true;

  if (status.gameState.available && !status.gameState.stale) {
    const gameState = status.gameState;
    status.gameRunning = status.gameRunning || gameState.worldReady === true;
    status.health.smapiStateFresh = true;
    status.health.saveLoaded = gameState.worldReady === true;
    status.health.multiplayerReady = gameState.multiplayerReady === true;
    status.health.joinable = gameState.joinable === true;
    status.players.online = Array.isArray(gameState.onlinePlayers)
      ? gameState.onlinePlayers.filter(player => player && player.isHost !== true).length
      : status.players.online;
    status.players.list = Array.isArray(gameState.onlinePlayers) ? gameState.onlinePlayers : [];
    status.day = formatGameDay(gameState) || status.day;
    status.season = gameState.season || status.season;
    if (typeof gameState.paused === 'boolean') {
      status.paused = gameState.paused;
    }
  }

  if (status.manualPause.enabled) {
    status.paused = true;
  }

  status.health.gameProcessRunning = status.gameRunning === true;
  status.joinability = describeJoinable(status.gameState, status.gameRunning);
  status.health.joinable = status.joinability.joinable;

  if (!status.scriptsHealthy) {
    try {
      execSync('pgrep -f "event-handler.sh" >/dev/null 2>&1');
      status.scriptsHealthy = true;
    } catch (error) {}
  }

  // Count backups
  try {
    if (fs.existsSync(config.BACKUPS_DIR)) {
      status.backupCount = fs.readdirSync(config.BACKUPS_DIR)
        .filter(f => f.endsWith('.tar.gz') || f.endsWith('.zip')).length;
    }
  } catch (e) {}

  // Count mods
  try {
    const modsDir = `${config.GAME_DIR}/Mods`;
    if (fs.existsSync(modsDir)) {
      status.modCount = fs.readdirSync(modsDir)
        .filter(f => {
          const manifestPath = `${modsDir}/${f}/manifest.json`;
          return fs.existsSync(manifestPath);
        }).length;
    }
  } catch (e) {}

  // Get system uptime
  try {
    const uptimeStr = execSync('cat /proc/uptime', { encoding: 'utf-8' });
    status.systemUptime = Math.floor(parseFloat(uptimeStr.split(' ')[0]));
  } catch (e) {}

  cachedStatus = status;
  cacheTime = now;

  // Push to history
  statusHistory.push({
    timestamp: status.timestamp,
    cpu: status.cpu,
    memory: status.memory.used,
    players: status.players.online,
  });
  if (statusHistory.length > MAX_HISTORY) {
    statusHistory.shift();
  }

  return status;
}

// Periodically broadcast status to WebSocket subscribers
setInterval(() => {
  if (statusSubscribers.size === 0) return;
  const status = collectStatus();
  const msg = JSON.stringify({ type: 'status', data: status });
  for (const ws of statusSubscribers) {
    if (ws.readyState === 1) {
      ws.send(msg);
    } else {
      statusSubscribers.delete(ws);
    }
  }
}, 5000);

// ─── Route Handlers ──────────────────────────────────────────────

function getStatus(req, res) {
  const status = collectStatus(req);
  res.json(status);
}

function subscribeStatus(ws) {
  statusSubscribers.add(ws);
  // Send current status immediately
  const status = collectStatus();
  ws.send(JSON.stringify({ type: 'status', data: status }));

  ws.on('close', () => statusSubscribers.delete(ws));
}

function restartServer(req, res) {
  try {
    const result = spawnSync('sh', ['-lc', 'pkill -f "StardewModdingAPI|Stardew Valley" >/dev/null 2>&1 || true'], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    if (result.error) {
      throw commandError('sh', ['-lc', 'pkill -f "StardewModdingAPI|Stardew Valley"'], result, {
        code: 'GAME_RESTART_COMMAND_FAILED',
        message: 'Failed to restart game process',
        action: 'Check container permissions and whether the shell can signal the game process.',
      });
    }

    res.json({ success: true, message: 'Game restart initiated' });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'GAME_RESTART_FAILED',
      message: 'Failed to restart server',
      cause: 'The panel could not signal the Stardew Valley process.',
      details: e.message,
      action: 'Check the container logs, then restart the Docker container if the game process is stuck.',
    });
  }
}

function restartContainer(req, res) {
  const managerUrl = process.env.MANAGER_URL || '';

  if (managerUrl) {
    scheduleContainerRecreate(managerUrl).then(() => {
      res.json({ success: true, message: 'Container recreate initiated' });
    }).catch((error) => {
      return sendError(res, req, error, {
        status: 500,
        code: 'CONTAINER_RECREATE_FAILED',
        message: 'Failed to recreate container',
        cause: 'The manager service did not accept the recreate request.',
        details: error.message,
        action: 'Check MANAGER_URL, the stardew-manager container, and Docker socket access.',
      });
    });
    return;
  }

  try {
    const result = spawnSync('sh', ['-lc', '(sleep 1; kill -TERM 1) >/dev/null 2>&1 &'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.error) {
      throw commandError('sh', ['-lc', '(sleep 1; kill -TERM 1)'], result, {
        code: 'CONTAINER_RESTART_COMMAND_FAILED',
        message: 'Failed to schedule container restart',
      });
    }

    if (result.status !== 0) {
      throw commandError('sh', ['-lc', '(sleep 1; kill -TERM 1)'], result, {
        code: 'CONTAINER_RESTART_COMMAND_FAILED',
        message: 'Failed to schedule container restart',
      });
    }

    res.json({ success: true, message: 'Container restart initiated' });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'CONTAINER_RESTART_FAILED',
      message: 'Failed to restart container',
      cause: 'The panel could not signal PID 1 or request a manager recreate.',
      details: e.message,
      action: 'Check container privileges or restart from Docker Compose.',
    });
  }
}

function getManualPause(req, res) {
  res.json(readManualPauseState());
}

function setManualPause(req, res) {
  try {
    if (!req.body || typeof req.body.enabled !== 'boolean') {
      return sendError(res, req, new AppError('Invalid manual pause request', {
        status: 400,
        code: 'INVALID_MANUAL_PAUSE_REQUEST',
        cause: 'The request must include a boolean "enabled" field.',
        action: 'Refresh the panel and use the Pause Time button again.',
      }));
    }

    const state = writeManualPauseState(req.body.enabled, req.body.reason || '');
    cachedStatus = null;
    res.json({
      success: true,
      manualPause: state,
      message: state.enabled ? 'Manual game-time pause enabled' : 'Manual game-time pause disabled',
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'MANUAL_PAUSE_UPDATE_FAILED',
      message: 'Failed to update manual pause state',
      cause: 'The panel could not write the manual pause control file.',
      details: e.message,
      action: 'Check web panel data permissions and container volume access.',
    });
  }
}

function scheduleContainerRecreate(managerUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL('/recreate', managerUrl);
    } catch (error) {
      reject(new AppError('Invalid manager URL', {
        status: 500,
        code: 'INVALID_MANAGER_URL',
        cause: 'MANAGER_URL is not a valid URL.',
        action: 'Set MANAGER_URL to a valid http or https URL, or leave it empty to use in-container restart.',
      }));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ service: 'stardew-server' });

    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }

        reject(new Error(body || `Manager returned HTTP ${response.statusCode}`));
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Manager request timed out'));
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

module.exports = {
  getStatus,
  subscribeStatus,
  restartServer,
  restartContainer,
  getManualPause,
  setManualPause,
};
