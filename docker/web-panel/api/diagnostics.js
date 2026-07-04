/**
 * Diagnostics API - health checks and support report export.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../server');
const { AppError, commandError, sendError } = require('../errors');
const { buildDiagnostics } = require('../diagnostics');
const statusAPI = require('./status');
const modsAPI = require('./mods');

const configuredDiagnosticLogTailBytes = parseInt(process.env.PANEL_DIAGNOSTIC_LOG_TAIL_BYTES || String(256 * 1024), 10);
const configuredHealthCommandTimeoutMs = parseInt(process.env.PANEL_HEALTH_COMMAND_TIMEOUT_MS || '1500', 10);
const DIAGNOSTIC_LOG_TAIL_BYTES = Number.isFinite(configuredDiagnosticLogTailBytes) && configuredDiagnosticLogTailBytes > 0
  ? configuredDiagnosticLogTailBytes
  : 256 * 1024;
const HEALTH_COMMAND_TIMEOUT_MS = Number.isFinite(configuredHealthCommandTimeoutMs) && configuredHealthCommandTimeoutMs > 0
  ? configuredHealthCommandTimeoutMs
  : 1500;

const KNOWN_LARGE_CONTENT_MOD_PATTERNS = [
  { key: 'ridgeside', label: 'Ridgeside Village', patterns: ['ridgeside', 'rafseazz.ridgeside'] },
  { key: 'sve', label: 'Stardew Valley Expanded', patterns: ['stardew valley expanded', 'stardewvalleyexpanded', 'flashshifter.stardewvalleyexpanded'] },
  { key: 'eastscarp', label: 'East Scarp', patterns: ['east scarp', 'eastscarp'] },
  { key: 'downtown_zuzu', label: 'Downtown Zuzu', patterns: ['downtown zuzu', 'downtownzuzu'] },
  { key: 'boarding_house', label: 'Boarding House', patterns: ['boarding house', 'boardinghouse'] },
  { key: 'adventurers_guild_expanded', label: 'Adventurer Guild Expanded', patterns: ['adventurer guild expanded', 'adventurers guild expanded', 'adventurerguildexpanded'] },
];

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function readManifestFromDir(modDir, fallbackName = '') {
  const manifestPath = path.join(modDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const dependencies = Array.isArray(manifest.Dependencies)
      ? manifest.Dependencies
        .filter(dep => dep && dep.IsRequired !== false && dep.UniqueID)
        .map(dep => String(dep.UniqueID).trim())
        .filter(Boolean)
      : [];
    const contentPackFor = manifest.ContentPackFor && manifest.ContentPackFor.UniqueID
      ? String(manifest.ContentPackFor.UniqueID).trim()
      : '';
    const requiredDependencies = [...dependencies];
    if (contentPackFor) {
      requiredDependencies.push(contentPackFor);
    }

    return {
      folder: fallbackName || path.basename(modDir),
      id: manifest.UniqueID || fallbackName || path.basename(modDir),
      name: manifest.Name || fallbackName || path.basename(modDir),
      version: manifest.Version || 'unknown',
      description: manifest.Description || '',
      dependencies: Array.from(new Set(requiredDependencies)),
      contentPackFor,
      path: modDir,
    };
  } catch (error) {
    return {
      folder: fallbackName || path.basename(modDir),
      id: fallbackName || path.basename(modDir),
      name: fallbackName || path.basename(modDir),
      version: 'unknown',
      description: '',
      dependencies: [],
      contentPackFor: '',
      path: modDir,
      error: error.message,
    };
  }
}

function scanInstalledModManifests() {
  const modsDir = path.join(config.GAME_DIR, 'Mods');
  if (!fs.existsSync(modsDir)) {
    return {
      modsDir,
      manifests: [],
      installedIds: new Set(),
      missingDir: true,
    };
  }

  const manifests = [];
  for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = readManifestFromDir(path.join(modsDir, entry.name), entry.name);
    if (manifest) {
      manifests.push(manifest);
    }
  }

  const installedIds = new Set();
  for (const manifest of manifests) {
    installedIds.add(normalizeId(manifest.id));
    installedIds.add(normalizeId(manifest.name));
    installedIds.add(normalizeId(manifest.folder));
  }

  return {
    modsDir,
    manifests,
    installedIds,
    missingDir: false,
  };
}

function matchLargeContentMod(manifest) {
  const haystack = [
    manifest.id,
    manifest.name,
    manifest.folder,
    manifest.description,
  ].map(normalizeId).join(' ');

  return KNOWN_LARGE_CONTENT_MOD_PATTERNS.find(item =>
    item.patterns.some(pattern => haystack.includes(pattern))
  ) || null;
}

function buildLargeContentModCheck(status) {
  const scan = scanInstalledModManifests();
  if (scan.missingDir) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `${scan.modsDir} does not exist, so large content mods cannot be inspected yet.`,
      action: 'Start the server once or check the game directory mount.',
    };
  }

  const largeMods = scan.manifests
    .map(manifest => ({ manifest, match: matchLargeContentMod(manifest) }))
    .filter(item => item.match);

  if (largeMods.length === 0) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'ok',
      detail: 'No known large content mod was detected in the game Mods directory.',
      action: '',
    };
  }

  const missingDependencies = [];
  for (const item of largeMods) {
    for (const dependency of item.manifest.dependencies) {
      if (!scan.installedIds.has(normalizeId(dependency))) {
        missingDependencies.push(`${item.match.label}: ${dependency}`);
      }
    }
  }

  const gameState = status.gameState || {};
  const expansion = gameState.expansionModCompatibility || {};
  const eventProxy = gameState.eventProxy || {};
  const hostHidden = status.modRuntime?.hostHidden === true || gameState.hostHidden === true;
  const manualHostVisible = expansion.manualHostVisible === true;
  const autoSkipEnabled = expansion.autoSkipSkippableEvents === true;
  const hasExpansionBridge = typeof expansion.autoSkipSkippableEvents === 'boolean';
  const hasEventProxyBridge = typeof eventProxy.enabled === 'boolean';
  const eventProxyEnabled = eventProxy.enabled === true;
  const eventProxyLast = eventProxy.last && typeof eventProxy.last === 'object' ? eventProxy.last : null;
  const activeMenu = typeof gameState.activeMenu === 'string' ? gameState.activeMenu : '';
  const currentEvent = gameState.currentEvent && typeof gameState.currentEvent === 'object'
    ? gameState.currentEvent
    : null;
  const modNames = largeMods.map(item => `${item.match.label} ${item.manifest.version}`.trim()).join(', ');

  if (missingDependencies.length > 0) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'error',
      detail: `Detected ${modNames}. Missing required dependency/dependencies: ${missingDependencies.join('; ')}.`,
      action: 'Install the missing dependency mods on both the server and every player client, then restart the server.',
    };
  }

  if (!status.gameRunning || !gameState.available || gameState.stale) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}, but the live SMAPI state bridge is not fresh enough to confirm host event state.`,
      action: 'Start the server and wait for AutoHideHost v1.4.0+ to write a fresh game-state.json, then refresh diagnostics.',
    };
  }

  if (!hasExpansionBridge) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'error',
      detail: `Detected ${modNames}, but AutoHideHost did not report the large-mod compatibility state.`,
      action: 'Update AutoHideHost to v1.4.0 or newer, rebuild/restart the container, then run diagnostics again.',
    };
  }

  if (autoSkipEnabled) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'error',
      detail: `Detected ${modNames}. AutoHideHost is still configured to auto-skip skippable events, which can skip large mod intro/unlock events.`,
      action: 'Use the Large Mod Init button or run "autohide_expansion_mode start" in SMAPI to disable auto event skipping.',
    };
  }

  if (!hasEventProxyBridge) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'error',
      detail: `Detected ${modNames}, but AutoHideHost did not report player event proxy state.`,
      action: 'Update AutoHideHost to v1.4.0 or newer and restart the container so farmhand warps can proxy-check host-side events.',
    };
  }

  if (!eventProxyEnabled) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}. Player event proxy is disabled, so hidden-host intro/unlock checks will not run when players enter mod locations.`,
      action: 'Set EnableEventProxyTrigger=true in AutoHideHost config and restart the game container.',
    };
  }

  if (eventProxy.active) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'ok',
      detail: `Detected ${modNames}. Player event proxy is active for ${eventProxy.playerName || 'a player'} at ${eventProxy.location || 'unknown location'} (${eventProxy.state || 'checking'}).`,
      action: 'Wait for the proxy to finish. If it later fails, this diagnostic will show the exact blocker or timeout reason.',
    };
  }

  if (currentEvent) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}. The host is currently in event ${currentEvent.id || 'unknown'}${currentEvent.skippable ? ' (skippable)' : ''}.`,
      action: 'Wait for AutoHideHost to finish or skip the proxy event. If it stays longer than the proxy timeout, check the last proxy failure reason and SMAPI log.',
    };
  }

  if (activeMenu) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}. The host has an active menu: ${activeMenu}.`,
      action: 'Close the blocking menu through the panel/SMAPI if possible, then have a player re-enter the mod event location. If it persists, check SMAPI logs for the menu source.',
    };
  }

  if (eventProxyLast && eventProxyLast.success === false) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}. Last proxy attempt failed for ${eventProxyLast.playerName || 'unknown player'} at ${eventProxyLast.location || 'unknown location'}: ${eventProxyLast.message || 'unknown reason'}.`,
      action: 'Fix the reported blocker, then let any real player leave and re-enter the target location to trigger a fresh proxy check.',
    };
  }

  if (eventProxyLast && eventProxyLast.success === true && /^no_host_event_for_location/.test(eventProxyLast.message || '')) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'warn',
      detail: `Detected ${modNames}. Last proxy reached ${eventProxyLast.location || 'unknown location'}, but the game did not find a host-side event to start there.`,
      action: 'Check the mod event requirements such as day, time, weather, mail/global flags, NPC friendship, exact entrance tile, and whether the host or farmhand has already seen the required prerequisite event.',
    };
  }

  if (hostHidden && !manualHostVisible) {
    return {
      id: 'large_content_mod_events',
      label: 'Large content mod event compatibility',
      status: 'ok',
      detail: `Detected ${modNames}. The host is hidden and player event proxy is enabled; players entering event locations will automatically proxy-check host-side intro/unlock events.`,
      action: eventProxyLast
        ? `Last proxy result: ${eventProxyLast.success ? 'success' : 'failed'} at ${eventProxyLast.location || 'unknown location'} (${eventProxyLast.message || 'no message'}).`
        : 'Have a real player enter the mod event location once; this page will then report the proxy result.',
    };
  }

  return {
    id: 'large_content_mod_events',
    label: 'Large content mod event compatibility',
    status: 'ok',
    detail: `Detected ${modNames}. Required dependencies are installed, AutoHideHost is not auto-skipping events, and player event proxy is available.`,
    action: manualHostVisible ? 'The host is manually visible for troubleshooting. Hide the host again when finished so proxy mode can take over.' : '',
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    ...options,
  });

  if (!result || result.status !== 0) {
    throw commandError(command, args, result);
  }

  return result.stdout || '';
}

function checkCommand(command, label) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf-8',
    timeout: HEALTH_COMMAND_TIMEOUT_MS,
  });

  return {
    id: `command_${command}`,
    label,
    status: result.status === 0 ? 'ok' : 'error',
    detail: result.status === 0
      ? String(result.stdout || '').trim()
      : `${command} is not available in PATH`,
    action: result.status === 0 ? '' : `Install ${command} in the Docker image and restart the container.`,
  };
}

function checkPath(targetPath, label, options = {}) {
  const exists = fs.existsSync(targetPath);
  if (!exists) {
    return {
      id: `path_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      label,
      status: options.required === false ? 'warn' : 'error',
      detail: `${targetPath} does not exist`,
      action: options.required === false
        ? 'This may be created automatically after the server starts.'
        : 'Check Docker volume mounts and container permissions.',
    };
  }

  try {
    fs.accessSync(targetPath, options.writable ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
    return {
      id: `path_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      label,
      status: 'ok',
      detail: options.writable ? `${targetPath} is readable and writable` : `${targetPath} is readable`,
      action: '',
    };
  } catch (error) {
    return {
      id: `path_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      label,
      status: 'error',
      detail: error.message,
      action: 'Fix ownership or permissions for the mounted directory.',
    };
  }
}

function readRecentLogLines(limit = 700) {
  try {
    if (!fs.existsSync(config.SMAPI_LOG)) {
      return [];
    }

    const stat = fs.statSync(config.SMAPI_LOG);
    const bytesToRead = Math.min(stat.size, Number.isFinite(DIAGNOSTIC_LOG_TAIL_BYTES) ? DIAGNOSTIC_LOG_TAIL_BYTES : 256 * 1024);
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
      .split(/\r?\n/)
      .filter(line => line.trim())
      .slice(-limit);
  } catch (error) {
    return [];
  }
}

function buildHealth(req = null) {
  const status = statusAPI.collectStatus(req);
  const logLines = readRecentLogLines();
  const logDiagnostics = buildDiagnostics(logLines, {
    source: path.basename(config.SMAPI_LOG),
  });

  const checks = [
    checkCommand('zip', 'zip command'),
    checkCommand('unzip', 'unzip command'),
    checkCommand('tar', 'tar command'),
    checkCommand('gzip', 'gzip command'),
    checkPath(config.DATA_DIR, 'Panel data directory', { writable: true }),
    checkPath(config.SAVES_DIR, 'Stardew saves directory', { writable: true, required: false }),
    checkPath(path.join(config.GAME_DIR, 'Mods'), 'Game Mods directory', { writable: true, required: false }),
    checkPath(config.LOG_DIR, 'Panel log directory', { writable: true, required: false }),
  ];

  checks.push({
    id: 'game_process',
    label: 'Stardew/SMAPI process',
    status: status.gameRunning ? 'ok' : 'warn',
    detail: status.gameRunning ? 'Game process is running' : 'Game process is not running',
    action: status.gameRunning ? '' : 'Start or restart the server before players try to join.',
  });

  checks.push({
    id: 'smapi_state_bridge',
    label: 'SMAPI state bridge',
    status: status.modRuntime?.active ? 'ok' : (status.gameRunning ? 'warn' : 'error'),
    detail: status.modRuntime?.active
      ? `Fresh state, age ${status.modRuntime.ageSeconds || 0}s`
      : `State bridge ${status.modRuntime?.state || 'unknown'}`,
    action: status.modRuntime?.active ? '' : 'Check whether AutoHideHost is loaded and can write game-state.json.',
  });

  checks.push({
    id: 'joinability',
    label: 'Player joinability',
    status: status.joinability?.joinable ? 'ok' : 'warn',
    detail: status.joinability?.label || status.joinability?.reason || 'Unknown',
    action: status.joinability?.joinable ? '' : (status.joinability?.action || 'Check SMAPI logs and host state.'),
  });

  checks.push(buildLargeContentModCheck(status));

  if (logDiagnostics.issues.length > 0) {
    const hasError = logDiagnostics.issues.some(issue => issue.severity === 'error');
    checks.push({
      id: 'recent_log_diagnostics',
      label: 'Recent log diagnostics',
      status: hasError ? 'error' : 'warn',
      detail: `${logDiagnostics.issues.length} known issue(s) detected`,
      action: 'Open the Logs page or export a crash report for details.',
    });
  } else {
    checks.push({
      id: 'recent_log_diagnostics',
      label: 'Recent log diagnostics',
      status: 'ok',
      detail: 'No known issue patterns detected in recent logs',
      action: '',
    });
  }

  const summary = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, { ok: 0, warn: 0, error: 0 });

  return {
    generatedAt: new Date().toISOString(),
    overall: summary.error > 0 ? 'error' : (summary.warn > 0 ? 'warn' : 'ok'),
    summary,
    checks,
    status,
    diagnostics: logDiagnostics,
  };
}

function getHealth(req, res) {
  try {
    res.json(buildHealth(req));
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'HEALTH_CHECK_FAILED',
      message: 'Failed to run health checks',
      cause: 'The panel could not collect one or more health check inputs.',
      details: error.message,
      action: 'Check panel logs and file permissions.',
    });
  }
}

function copyIfExists(sourcePath, targetDir, filename = '') {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return false;
  }

  fs.cpSync(sourcePath, path.join(targetDir, filename || path.basename(sourcePath)), { recursive: true });
  return true;
}

function exportCrashReport(req, res) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-report-'));
  const archiveName = `ylty-stardew-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar.gz`;
  const archivePath = path.join(os.tmpdir(), archiveName);

  try {
    const health = buildHealth(req);
    let modManifest = null;
    try {
      modManifest = modsAPI.getPublicModManifest(req);
    } catch (error) {
      modManifest = { error: error.message };
    }

    fs.writeFileSync(path.join(tempRoot, 'health.json'), JSON.stringify(health, null, 2), 'utf-8');
    fs.writeFileSync(path.join(tempRoot, 'mod-manifest.json'), JSON.stringify(modManifest, null, 2), 'utf-8');
    fs.writeFileSync(path.join(tempRoot, 'recent-smapi-lines.txt'), readRecentLogLines(1200).join('\n'), 'utf-8');

    copyIfExists(config.SMAPI_LOG, tempRoot, 'SMAPI-latest.txt');
    copyIfExists(config.STATUS_FILE, tempRoot, 'status.json');
    copyIfExists(config.GAME_STATE_FILE, tempRoot, 'game-state.json');
    copyIfExists(config.MANUAL_PAUSE_FILE, tempRoot, 'manual-pause.json');
    copyIfExists(config.AUTO_PAUSE_FILE, tempRoot, 'auto-pause.json');
    copyIfExists(path.join(config.LOG_DIR, 'categorized'), tempRoot, 'categorized-logs');

    runCommand('tar', ['-czf', archivePath, '-C', tempRoot, '.'], {
      timeout: 180000,
    });

    res.download(archivePath, archiveName, (error) => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(archivePath, { force: true });
      if (error && !res.headersSent) {
        return sendError(res, req, error, {
          status: 500,
          code: 'REPORT_DOWNLOAD_FAILED',
          message: 'Failed to download crash report',
          cause: 'The report archive was created, but the panel could not send it to the browser.',
          details: error.message,
          action: 'Retry the export and check panel logs if it fails again.',
        });
      }
    });
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    return sendError(res, req, error, {
      status: 500,
      code: 'REPORT_CREATE_FAILED',
      message: 'Failed to create crash report',
      cause: error.cause || 'The panel could not create the diagnostic report archive.',
      details: error.details || error.message,
      action: error.action || 'Check tar/gzip availability, disk space, and panel data permissions.',
    });
  }
}

module.exports = {
  getHealth,
  exportCrashReport,
};
