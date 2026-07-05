/**
 * Status API - Server status and metrics
 */

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('../server');
const { AppError, commandError, sendError } = require('../errors');
const { MAX_PLAYERS, getVisiblePlayers, readGameStateBridge } = require('./game-state');
const { buildWorldState, deriveOrchestration } = require('./world-state');

// Status history (in-memory, capped for small 2c/2g servers)
const statusHistory = [];
const configuredStatusHistoryLimit = parseInt(process.env.PANEL_STATUS_HISTORY_LIMIT || '180', 10);
const MAX_HISTORY = Number.isFinite(configuredStatusHistoryLimit) && configuredStatusHistoryLimit > 0
  ? configuredStatusHistoryLimit
  : 180;

// WebSocket subscribers
const statusSubscribers = new Set();

// Cache
let cachedStatus = null;
let cacheTime = 0;
const configuredStatusCacheTtl = parseInt(process.env.PANEL_STATUS_CACHE_MS || '5000', 10);
const configuredStatusLogTailBytes = parseInt(process.env.PANEL_STATUS_LOG_TAIL_BYTES || String(128 * 1024), 10);
const configuredCommandTimeoutMs = parseInt(process.env.PANEL_COMMAND_TIMEOUT_MS || '1500', 10);
const CACHE_TTL = Number.isFinite(configuredStatusCacheTtl) && configuredStatusCacheTtl > 0 ? configuredStatusCacheTtl : 5000;
const STATUS_LOG_TAIL_BYTES = Number.isFinite(configuredStatusLogTailBytes) && configuredStatusLogTailBytes > 0
  ? configuredStatusLogTailBytes
  : 128 * 1024;
const COMMAND_TIMEOUT_MS = Number.isFinite(configuredCommandTimeoutMs) && configuredCommandTimeoutMs > 0
  ? configuredCommandTimeoutMs
  : 1500;

function readRecentLogLines(limit = 400) {
  try {
    if (!fs.existsSync(config.SMAPI_LOG)) {
      return [];
    }

    const stat = fs.statSync(config.SMAPI_LOG);
    const bytesToRead = Math.min(stat.size, Number.isFinite(STATUS_LOG_TAIL_BYTES) ? STATUS_LOG_TAIL_BYTES : 128 * 1024);
    const start = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(config.SMAPI_LOG, 'r');
    let content = '';
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
      content = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    return content
      .split('\n')
      .filter(Boolean)
      .slice(-limit);
  } catch (error) {
    return [];
  }
}

function extractLogHints(lines = readRecentLogLines(500)) {
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

function describeJoinHandshake(lines = readRecentLogLines(500)) {
  const state = {
    stage: 'none',
    connectionId: '',
    line: '',
    label: 'No recent player join attempt',
    action: 'Have a player try to join, then refresh this page.',
  };

  for (const line of lines) {
    let match = line.match(/Sending available farmhands to connection ID\s+([A-Za-z0-9_.:-]+)/i);
    if (match) {
      state.stage = 'sent_farmhand_list';
      state.connectionId = match[1];
      state.line = line;
      state.label = 'Server sent the farmhand list';
      state.action = 'If the player still sees no free slot, the next check is whether the list is empty or the client did not request a farmhand after receiving it.';
      continue;
    }

    if (/Received context for farmhand|received farmhand request|Server received farmhand request/i.test(line)) {
      state.stage = 'farmhand_requested';
      state.line = line;
      state.label = 'Client selected or requested a farmhand';
      state.action = 'Wait for approval or check the next SMAPI line if the join still fails.';
      continue;
    }

    if (/Approved request for farmhand|farmhand .* connected|joined the game|player .* connected/i.test(line)) {
      state.stage = 'approved';
      state.line = line;
      state.label = 'Join request approved';
      state.action = '';
      continue;
    }

    if (/no available.*(farmhand|cabin|slot)|no empty cabin|no available cabins|farm is full|server.*full|not enough cabin/i.test(line)) {
      state.stage = 'rejected_no_slots';
      state.line = line;
      state.label = 'Server reported no free farmhand slot';
      state.action = 'Check playerLimit, enableFarmhandCreation, cabins, and whether the loaded save was opened through a true co-op host flow.';
      continue;
    }

    if (state.stage === 'sent_farmhand_list' && /disconnect|disconnected|lost connection|left the game|connection closed/i.test(line)) {
      state.stage = 'disconnected_after_farmhand_list';
      state.line = line;
      state.label = 'Player disconnected after the farmhand list was sent';
      state.action = 'This usually means the client could not choose a farmhand or rejected the slot list. Compare the client mod set and run the save slot audit.';
    }
  }

  return state;
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
    localIps = execSync('hostname -I 2>/dev/null', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS })
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

function readAutoPauseState() {
  const emptyState = {
    enabled: true,
    updatedAt: '',
    updatedBy: '',
    reason: '',
    file: config.AUTO_PAUSE_FILE,
    exists: false,
    inheritedDefault: true,
  };

  try {
    if (!config.AUTO_PAUSE_FILE || !fs.existsSync(config.AUTO_PAUSE_FILE)) {
      return emptyState;
    }

    const data = JSON.parse(fs.readFileSync(config.AUTO_PAUSE_FILE, 'utf-8'));
    return {
      ...emptyState,
      enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '',
      reason: typeof data.reason === 'string' ? data.reason : '',
      exists: true,
      inheritedDefault: false,
    };
  } catch (error) {
    return {
      ...emptyState,
      error: error.message,
      exists: true,
    };
  }
}

function writeAutoPauseState(enabled, reason = '') {
  if (!config.AUTO_PAUSE_FILE) {
    throw new AppError('Auto pause state path is not configured', {
      status: 500,
      code: 'AUTO_PAUSE_NOT_CONFIGURED',
      cause: 'AUTO_PAUSE_FILE is empty, so the panel cannot write the auto pause control file.',
      action: 'Set AUTO_PAUSE_FILE or use the default container path.',
    });
  }

  const state = {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
    updatedBy: 'web-panel',
    reason: String(reason || '').slice(0, 240),
  };

  const dir = require('path').dirname(config.AUTO_PAUSE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${config.AUTO_PAUSE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, config.AUTO_PAUSE_FILE);

  return {
    ...state,
    file: config.AUTO_PAUSE_FILE,
    exists: true,
    inheritedDefault: false,
  };
}

function readServerAutoloadState() {
  const emptyState = {
    available: false,
    stale: true,
    ageSeconds: null,
    phase: 'unknown',
    ok: false,
    message: '',
    targetSave: '',
    file: config.SERVER_AUTOLOAD_STATE_FILE || '',
  };

  try {
    if (!config.SERVER_AUTOLOAD_STATE_FILE || !fs.existsSync(config.SERVER_AUTOLOAD_STATE_FILE)) {
      return emptyState;
    }

    const data = JSON.parse(fs.readFileSync(config.SERVER_AUTOLOAD_STATE_FILE, 'utf-8'));
    const updatedAtMs = Date.parse(data.updatedAt || '');
    const ageSeconds = Number.isFinite(updatedAtMs)
      ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
      : null;

    return {
      ...emptyState,
      ...data,
      available: true,
      ageSeconds,
      stale: ageSeconds === null || ageSeconds > 60,
      file: config.SERVER_AUTOLOAD_STATE_FILE,
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

function describeModRuntime(gameState, gameRunning) {
  if (!gameRunning) {
    return {
      active: false,
      state: 'stopped',
      ageSeconds: null,
      updatedAt: null,
      lastAutomation: null,
      hostHidden: false,
    };
  }

  if (!gameState || !gameState.available) {
    return {
      active: false,
      state: 'missing',
      ageSeconds: null,
      updatedAt: null,
      lastAutomation: null,
      hostHidden: false,
    };
  }

  if (gameState.stale) {
    return {
      active: false,
      state: 'stale',
      ageSeconds: gameState.ageSeconds,
      updatedAt: gameState.updatedAt || null,
      lastAutomation: gameState.lastAutomation || null,
      hostHidden: gameState.hostHidden === true,
    };
  }

  return {
    active: true,
    state: 'active',
    ageSeconds: gameState.ageSeconds,
    updatedAt: gameState.updatedAt || null,
    lastAutomation: gameState.lastAutomation || null,
    hostHidden: gameState.hostHidden === true,
  };
}

function buildTimePauseStatus(status) {
  const singlePause = status.singleFarmhandMenuPause || {};
  const manualRequested = status.manualPause && status.manualPause.enabled === true;
  const autoApplied = status.autoPause && (status.autoPause.applied === true || status.autoPause.state === 'paused');
  const singleMenuApplied = singlePause && (singlePause.applied === true || singlePause.state === 'paused');
  const paused = status.paused === true || manualRequested || autoApplied || singleMenuApplied;
  let source = paused ? 'game' : 'running';
  let reason = paused ? 'game_paused' : 'time_running';

  if (manualRequested) {
    source = 'manual';
    reason = status.manualPause.reason || 'manual_pause_enabled';
  } else if (autoApplied) {
    source = 'auto_empty';
    reason = status.autoPause.reason || 'empty_server';
  } else if (singleMenuApplied) {
    source = 'single_menu';
    reason = singlePause.reason || 'single_farmhand_menu';
  } else if (!paused) {
    source = 'running';
    reason = 'time_running';
  } else if (!status.gameState || !status.gameState.available || status.gameState.stale) {
    source = 'inferred';
    reason = 'state_bridge_missing_or_stale';
  }

  return {
    paused,
    source,
    reason,
    bridgeFresh: status.gameState && status.gameState.available === true && status.gameState.stale !== true,
    manualRequested,
    autoApplied,
    singleMenuApplied,
    updatedAt: status.gameState && status.gameState.updatedAt ? status.gameState.updatedAt : status.timestamp,
  };
}

function collectStatus(req = null) {
  const now = Date.now();
  if (cachedStatus && now - cacheTime < CACHE_TTL) {
    return cachedStatus;
  }

  const requestHost = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers['host'])) || '';
  const autoPauseControl = readAutoPauseState();

  const status = {
    timestamp: new Date().toISOString(),
    gameRunning: false,
    uptime: 0,
    players: { online: 0, max: MAX_PLAYERS, list: [], source: 'unknown' },
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
    autoPause: {
      enabled: autoPauseControl.enabled === true,
      applied: false,
      state: 'unknown',
      reason: '',
      onlinePlayers: 0,
      emptySeconds: 0,
      delaySeconds: 0,
      startupGraceSeconds: 0,
      autoResumeOnPlayerJoin: true,
      emptySince: null,
      configuredEnabled: null,
      controlFile: config.AUTO_PAUSE_FILE,
      controlError: autoPauseControl.error || '',
      control: autoPauseControl,
      guard: {
        safeToSwitch: false,
        blockers: [],
      },
    },
    serverAutoload: readServerAutoloadState(),
    singleFarmhandMenuPause: {
      enabled: false,
      applied: false,
      state: 'unknown',
      reason: '',
      onlineFarmhands: 0,
      playerId: '',
      playerName: '',
      menuType: '',
      clientFresh: false,
      timeoutSeconds: 0,
      clientModId: '',
    },
    eventProxy: {
      enabled: false,
      active: false,
      state: 'unknown',
      reason: '',
      playerName: '',
      playerId: '',
      location: '',
      tileX: 0,
      tileY: 0,
      eventId: '',
      activeSeconds: 0,
      cooldownSeconds: 0,
      noEventWaitSeconds: 0,
      skipEventDelaySeconds: 0,
      eventTimeoutSeconds: 0,
      offMapPosition: false,
      ignoredLocations: '',
      last: null,
    },
    timePause: {
      paused: false,
      source: 'unknown',
      reason: '',
      bridgeFresh: false,
      manualRequested: false,
      autoApplied: false,
      singleMenuApplied: false,
      updatedAt: null,
    },
    gameState: readGameStateBridge(),
    worldState: {
      available: false,
      fingerprint: '',
      modGraph: null,
      save: null,
      binding: null,
      issues: [],
      error: '',
    },
    orchestration: {
      state: 'INIT',
      phase: 'initializing',
      explicit: true,
      blockers: [],
      worldFingerprint: '',
      worldFingerprintShort: '',
      modGraphHash: '',
      modGraphHashShort: '',
      updatedAt: null,
    },
    joinability: {
      joinable: false,
      reason: 'unknown',
      label: 'Unknown',
      action: '',
    },
    modRuntime: {
      active: false,
      state: 'unknown',
      ageSeconds: null,
      updatedAt: null,
      lastAutomation: null,
      hostHidden: false,
    },
    health: {
      containerRunning: true,
      gameProcessRunning: false,
      smapiStateFresh: false,
      saveLoaded: false,
      multiplayerReady: false,
      joinable: false,
    },
    connection: {
      joinIp: '',
      joinPort: 24642,
      online: 0,
      max: MAX_PLAYERS,
      source: 'unknown',
      trusted: false,
      refreshedAt: null,
      ageSeconds: null,
      joinable: false,
      reason: 'unknown',
      hostHidden: false,
      lastCheckedAt: new Date().toISOString(),
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
    const pidStr = execSync('pgrep -f StardewModdingAPI', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }).trim().split('\n')[0];
    status.gameRunning = true;
    status.health.gameProcessRunning = true;

    // If we didn't get data from status.json, collect live
    if (status.cpu === 0 && status.memory.used === 0 && pidStr) {
      try {
        const cpuStr = execSync('ps -p ' + pidStr + ' -o %cpu= 2>/dev/null', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }).trim();
        status.cpu = parseFloat(cpuStr) || 0;
      } catch (e2) {}
      try {
        const rssStr = execSync('grep VmRSS /proc/' + pidStr + '/status 2>/dev/null | awk \'{print $2}\'', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }).trim();
        if (rssStr) status.memory.used = Math.round(parseInt(rssStr, 10) / 1024);
      } catch (e2) {}
    }

    // If no uptime from status.json, compute from process start time
    if (status.uptime === 0 && pidStr) {
      try {
        const startTime = execSync('stat -c %Y /proc/' + pidStr + ' 2>/dev/null', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }).trim();
        if (startTime) status.uptime = Math.floor(Date.now() / 1000) - parseInt(startTime, 10);
      } catch (e2) {}
    }
  } catch (e) {
    // Process not found
  }

  const recentLogLines = readRecentLogLines(500);
  const hints = extractLogHints(recentLogLines);
  status.joinHandshake = describeJoinHandshake(recentLogLines);
  if ((status.day === 'Unknown' || !status.day) && hints.day) {
    status.day = hints.day;
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
    const visiblePlayers = getVisiblePlayers(gameState);
    status.players.online = visiblePlayers.length;
    status.players.list = visiblePlayers;
    status.players.source = 'smapi-state-bridge';
    status.players.refreshedAt = gameState.updatedAt || null;
    status.day = formatGameDay(gameState) || status.day;
    status.season = gameState.season || status.season;
    if (typeof gameState.paused === 'boolean') {
      status.paused = gameState.paused;
    }
    if (gameState.autoPause && typeof gameState.autoPause === 'object') {
      status.autoPause = {
        ...status.autoPause,
        enabled: gameState.autoPause.enabled === true,
        applied: gameState.autoPause.applied === true,
        state: typeof gameState.autoPause.state === 'string' ? gameState.autoPause.state : status.autoPause.state,
        reason: typeof gameState.autoPause.reason === 'string' ? gameState.autoPause.reason : '',
        onlinePlayers: Number.isFinite(gameState.autoPause.onlinePlayers) ? gameState.autoPause.onlinePlayers : visiblePlayers.length,
        emptySeconds: Number.isFinite(gameState.autoPause.emptySeconds) ? gameState.autoPause.emptySeconds : 0,
        delaySeconds: Number.isFinite(gameState.autoPause.delaySeconds) ? gameState.autoPause.delaySeconds : 0,
        startupGraceSeconds: Number.isFinite(gameState.autoPause.startupGraceSeconds) ? gameState.autoPause.startupGraceSeconds : 0,
        autoResumeOnPlayerJoin: gameState.autoPause.autoResumeOnPlayerJoin !== false,
        emptySince: gameState.autoPause.emptySince || null,
        configuredEnabled: typeof gameState.autoPause.configuredEnabled === 'boolean' ? gameState.autoPause.configuredEnabled : status.autoPause.configuredEnabled,
        controlFile: typeof gameState.autoPause.controlFile === 'string' ? gameState.autoPause.controlFile : status.autoPause.controlFile,
        controlError: typeof gameState.autoPause.controlError === 'string' ? gameState.autoPause.controlError : status.autoPause.controlError,
        control: autoPauseControl,
      };
    }
    if (gameState.singleFarmhandMenuPause && typeof gameState.singleFarmhandMenuPause === 'object') {
      status.singleFarmhandMenuPause = {
        ...status.singleFarmhandMenuPause,
        enabled: gameState.singleFarmhandMenuPause.enabled === true,
        applied: gameState.singleFarmhandMenuPause.applied === true,
        state: typeof gameState.singleFarmhandMenuPause.state === 'string'
          ? gameState.singleFarmhandMenuPause.state
          : status.singleFarmhandMenuPause.state,
        reason: typeof gameState.singleFarmhandMenuPause.reason === 'string' ? gameState.singleFarmhandMenuPause.reason : '',
        onlineFarmhands: Number.isFinite(gameState.singleFarmhandMenuPause.onlineFarmhands)
          ? gameState.singleFarmhandMenuPause.onlineFarmhands
          : visiblePlayers.length,
        playerId: typeof gameState.singleFarmhandMenuPause.playerId === 'string' ? gameState.singleFarmhandMenuPause.playerId : '',
        playerName: typeof gameState.singleFarmhandMenuPause.playerName === 'string' ? gameState.singleFarmhandMenuPause.playerName : '',
        menuType: typeof gameState.singleFarmhandMenuPause.menuType === 'string' ? gameState.singleFarmhandMenuPause.menuType : '',
        clientFresh: gameState.singleFarmhandMenuPause.clientFresh === true,
        timeoutSeconds: Number.isFinite(gameState.singleFarmhandMenuPause.timeoutSeconds)
          ? gameState.singleFarmhandMenuPause.timeoutSeconds
          : status.singleFarmhandMenuPause.timeoutSeconds,
        clientModId: typeof gameState.singleFarmhandMenuPause.clientModId === 'string'
          ? gameState.singleFarmhandMenuPause.clientModId
          : status.singleFarmhandMenuPause.clientModId,
      };
    }
    if (gameState.eventProxy && typeof gameState.eventProxy === 'object') {
      const proxy = gameState.eventProxy;
      const lastProxy = proxy.last && typeof proxy.last === 'object' ? proxy.last : null;
      status.eventProxy = {
        ...status.eventProxy,
        enabled: proxy.enabled === true,
        active: proxy.active === true,
        state: typeof proxy.state === 'string' ? proxy.state : status.eventProxy.state,
        reason: typeof proxy.reason === 'string' ? proxy.reason : '',
        playerName: typeof proxy.playerName === 'string' ? proxy.playerName : '',
        playerId: typeof proxy.playerId === 'string' ? proxy.playerId : '',
        location: typeof proxy.location === 'string' ? proxy.location : '',
        tileX: Number.isFinite(proxy.tileX) ? proxy.tileX : 0,
        tileY: Number.isFinite(proxy.tileY) ? proxy.tileY : 0,
        eventId: typeof proxy.eventId === 'string' ? proxy.eventId : '',
        activeSeconds: Number.isFinite(proxy.activeSeconds) ? proxy.activeSeconds : 0,
        cooldownSeconds: Number.isFinite(proxy.cooldownSeconds) ? proxy.cooldownSeconds : 0,
        noEventWaitSeconds: Number.isFinite(proxy.noEventWaitSeconds) ? proxy.noEventWaitSeconds : 0,
        skipEventDelaySeconds: Number.isFinite(proxy.skipEventDelaySeconds) ? proxy.skipEventDelaySeconds : 0,
        eventTimeoutSeconds: Number.isFinite(proxy.eventTimeoutSeconds) ? proxy.eventTimeoutSeconds : 0,
        offMapPosition: proxy.offMapPosition === true,
        ignoredLocations: typeof proxy.ignoredLocations === 'string' ? proxy.ignoredLocations : '',
        last: lastProxy ? {
          playerName: typeof lastProxy.playerName === 'string' ? lastProxy.playerName : '',
          location: typeof lastProxy.location === 'string' ? lastProxy.location : '',
          eventId: typeof lastProxy.eventId === 'string' ? lastProxy.eventId : '',
          success: lastProxy.success === true,
          message: typeof lastProxy.message === 'string' ? lastProxy.message : '',
          at: typeof lastProxy.at === 'string' ? lastProxy.at : null,
        } : null,
      };
    }
  } else {
    status.players.online = 0;
    status.players.list = [];
    status.players.source = status.gameState.available ? 'stale-smapi-state-bridge' : 'untrusted';
  }

  if (status.manualPause.enabled) {
    status.paused = true;
  }

  status.health.gameProcessRunning = status.gameRunning === true;
  status.modRuntime = describeModRuntime(status.gameState, status.gameRunning);
  status.joinability = describeJoinable(status.gameState, status.gameRunning);
  status.health.joinable = status.joinability.joinable;
  status.connection = {
    joinIp: status.network.joinIp || '',
    joinPort: status.network.joinPort || 24642,
    online: status.players.online || 0,
    max: status.players.max || MAX_PLAYERS,
    source: status.players.source || 'unknown',
    trusted: status.players.source === 'smapi-state-bridge',
    refreshedAt: status.players.refreshedAt || null,
    ageSeconds: status.gameState && typeof status.gameState.ageSeconds === 'number' ? status.gameState.ageSeconds : null,
    joinable: status.joinability.joinable === true,
    reason: status.joinability.reason || 'unknown',
    hostHidden: status.modRuntime.hostHidden === true,
    lastCheckedAt: status.timestamp,
  };
  const autoPauseBlockers = [];
  if (!status.gameRunning) autoPauseBlockers.push('game_not_running');
  if (!status.gameState.available || status.gameState.stale) autoPauseBlockers.push('state_bridge_not_fresh');
  if (status.manualPause.enabled) autoPauseBlockers.push('manual_pause_enabled');
  if (status.gameState && status.gameState.saving === true) autoPauseBlockers.push('saving');
  if (status.gameState && status.gameState.eventUp === true) autoPauseBlockers.push('event_active');
  if (status.joinability.reason === 'blocking_event') autoPauseBlockers.push('blocking_event');
  status.autoPause.guard = {
    safeToSwitch: autoPauseBlockers.length === 0,
    blockers: autoPauseBlockers,
  };
  if (status.autoPause.applied === true
    || status.autoPause.state === 'paused'
    || status.singleFarmhandMenuPause.applied === true
    || status.singleFarmhandMenuPause.state === 'paused') {
    status.paused = true;
  }
  status.timePause = buildTimePauseStatus(status);

  try {
    const worldState = buildWorldState();
    status.worldState = {
      available: true,
      generatedAt: worldState.generatedAt,
      fingerprint: worldState.fingerprint,
      fingerprintShort: worldState.fingerprint.slice(0, 12),
      smapiVersion: worldState.smapiVersion,
      modGraph: worldState.modGraph,
      save: worldState.save,
      binding: worldState.binding,
      issues: worldState.issues,
      files: worldState.files,
    };
    status.orchestration = deriveOrchestration(status, worldState);
  } catch (error) {
    status.worldState = {
      ...status.worldState,
      error: error.message,
    };
    status.orchestration = {
      ...status.orchestration,
      state: status.gameRunning ? 'DEGRADED' : 'STOPPED',
      phase: 'world_state_failed',
      blockers: ['world_state_failed'],
      updatedAt: status.timestamp,
    };
  }

  if (!status.scriptsHealthy) {
    try {
      execSync('pgrep -f "event-handler.sh" >/dev/null 2>&1', { timeout: COMMAND_TIMEOUT_MS });
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
    const uptimeStr = execSync('cat /proc/uptime', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS });
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
}, 20000);

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

function getAutoPause(req, res) {
  res.json(readAutoPauseState());
}

function setAutoPause(req, res) {
  try {
    if (!req.body || typeof req.body.enabled !== 'boolean') {
      return sendError(res, req, new AppError('Invalid auto pause request', {
        status: 400,
        code: 'INVALID_AUTO_PAUSE_REQUEST',
        cause: 'The request must include a boolean "enabled" field.',
        action: 'Refresh the panel and use the Auto Pause button again.',
      }));
    }

    const state = writeAutoPauseState(req.body.enabled, req.body.reason || '');
    cachedStatus = null;
    res.json({
      success: true,
      autoPauseControl: state,
      autoPause: {
        enabled: state.enabled,
        state: state.enabled ? 'waiting' : 'disabled',
        control: state,
      },
      message: state.enabled ? 'Automatic empty-server pause enabled' : 'Automatic empty-server pause disabled',
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'AUTO_PAUSE_UPDATE_FAILED',
      message: 'Failed to update auto pause state',
      cause: 'The panel could not write the auto pause control file.',
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
  collectStatus,
  getStatus,
  subscribeStatus,
  restartServer,
  restartContainer,
  getManualPause,
  setManualPause,
  getAutoPause,
  setAutoPause,
};
