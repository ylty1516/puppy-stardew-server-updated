/**
 * Log diagnostics for common Puppy Stardew Server failure modes.
 */

const RULES = [
  {
    code: 'STEAM_GUARD_REQUIRED',
    severity: 'warn',
    category: 'steam',
    title: 'Steam Guard is waiting for a code',
    cause: 'Steam requires a one-time code before the game can download or launch.',
    action: 'Open the web terminal or run docker attach puppy-stardew, enter the Steam Guard code, then detach with Ctrl+P Ctrl+Q.',
    pattern: /Steam Guard|two[- ]factor|set_steam_guard_code|AccountLogonDenied|steam guard code/i,
  },
  {
    code: 'STEAM_LOGIN_FAILED',
    severity: 'error',
    category: 'steam',
    title: 'Steam login or license check failed',
    cause: 'The Steam credentials may be wrong, Steam Guard may still be pending, or the account may not own Stardew Valley.',
    action: 'Verify STEAM_USERNAME and STEAM_PASSWORD, confirm the account owns Stardew Valley, then restart the container.',
    pattern: /Login Failure|Invalid Password|incorrect password|No subscription|license|must own|not own|password.*incorrect/i,
  },
  {
    code: 'STEAM_DOWNLOAD_FAILED',
    severity: 'error',
    category: 'steam',
    title: 'Steam game download failed',
    cause: 'SteamCMD could not complete the app update.',
    action: 'Check Steam credentials, network access, disk space, and Steam rate limits, then restart the container.',
    pattern: /Game download failed|app_update.*fail|Steam.*download.*fail|content servers unavailable|Update state.*failed/i,
  },
  {
    code: 'DISK_SPACE',
    severity: 'error',
    category: 'storage',
    title: 'Disk space is too low',
    cause: 'The host or Docker volume does not have enough free space for game files, logs, or backups.',
    action: 'Free disk space, prune old Docker data or backups, then restart the failed operation.',
    pattern: /No space left|ENOSPC|Disk write failure|insufficient disk|not enough space/i,
  },
  {
    code: 'PERMISSION_DENIED',
    severity: 'error',
    category: 'storage',
    title: 'File permission problem',
    cause: 'A mounted data directory is not writable by the container user.',
    action: 'Run init.sh or chown the data directory to UID 1000, then restart the container.',
    pattern: /Permission denied|EACCES|EPERM|wrong-owner|wrong owner|chown|access denied/i,
  },
  {
    code: 'SAVE_LOAD_FAILED',
    severity: 'error',
    category: 'save',
    title: 'Save file could not be loaded',
    cause: 'The selected save is missing, invalid, or not in Stardew Valley co-op save format.',
    action: 'Check the Saves page, upload a valid save zip, or clear SAVE_NAME to use auto-detection.',
    pattern: /Save directory not found|No valid Stardew Valley save|SaveGameInfo|SAVE_NAME.*not found|save.*not found|failed.*load.*save/i,
  },
  {
    code: 'MOD_EXCEPTION',
    severity: 'error',
    category: 'mod',
    title: 'A mod failed or threw an exception',
    cause: 'One of the SMAPI mods crashed, failed to load, or is incompatible with the current game or SMAPI version.',
    action: 'Review the mod name in the log line, disable recently uploaded mods, and verify mod versions.',
    pattern: /Mod crashed|failed loading mod|failed to load.*mod|Harmony|manifest\.json|Exception.*(mod|SMAPI|Harmony)/i,
  },
  {
    code: 'GAME_CRASH',
    severity: 'error',
    category: 'game',
    title: 'Game process crashed',
    cause: 'The Stardew Valley or SMAPI process exited unexpectedly.',
    action: 'Check nearby SMAPI errors, recent mod changes, memory usage, and crash restart limits.',
    pattern: /Unhandled exception|Fatal error|Segmentation fault|Aborted|core dumped|process exited unexpectedly|crash/i,
  },
  {
    code: 'SERVER_OFFLINE_MODE',
    severity: 'info',
    category: 'server',
    title: 'Server offline mode is active',
    cause: 'Always On Server paused hosting because no players are connected or the server was toggled offline.',
    action: 'If players cannot join, open VNC or terminal and verify Always On Server auto mode is enabled.',
    pattern: /ServerOfflineMode|Auto mode off|server offline/i,
  },
  {
    code: 'AUTOMATION_INPUT_FAILED',
    severity: 'warn',
    category: 'automation',
    title: 'Automation could not send input',
    cause: 'The background automation could not send an F9 or Enter key event to the game window.',
    action: 'Check VNC, xdotool, DISPLAY, and whether an in-game menu is blocking input.',
    pattern: /xdotool.*(not installed|failed)|unable to get key lock|cannot get key lock|F9.*not|ReadyCheckDialog|key lock/i,
  },
  {
    code: 'VNC_FAILED',
    severity: 'error',
    category: 'vnc',
    title: 'VNC failed to start or is unhealthy',
    cause: 'x11vnc could not start, the VNC password is missing, or the VNC port is not listening.',
    action: 'Set VNC_PASSWORD or allow the generated password, check port 5900, then restart the container.',
    pattern: /x11vnc|VNC_PASSWORD is empty|Port .*5900.*not listening|Failed to start x11vnc/i,
  },
  {
    code: 'BACKUP_FAILED',
    severity: 'error',
    category: 'backup',
    title: 'Backup failed',
    cause: 'The tar/gzip backup process could not read saves or write the backup archive.',
    action: 'Check save permissions, disk space, and backup directory access, then retry Backup Now.',
    pattern: /Backup failed|tar.*failed|gzip.*failed|Cannot stat|file changed as we read it/i,
  },
  {
    code: 'CONFIG_WRITE_FAILED',
    severity: 'error',
    category: 'config',
    title: 'Configuration could not be saved',
    cause: 'The panel could not write runtime.env or rejected unsafe config input.',
    action: 'Check panel data permissions and remove line breaks from config values.',
    pattern: /runtime\.env|Failed to update config|Refusing to write env|invalid line breaks/i,
  },
];

function parseLogLevel(line) {
  if (/\b(FATAL|ERROR)\b|Unhandled exception|Exception/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b|failed|timeout|timed out/i.test(line)) return 'warn';
  if (/\bDEBUG\b|\bTRACE\b/i.test(line)) return 'debug';
  return 'info';
}

function classifyLine(line) {
  const text = String(line || '');
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return {
        code: rule.code,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        cause: rule.cause,
        action: rule.action,
      };
    }
  }
  return null;
}

function annotateLine(line) {
  const issue = classifyLine(line);
  return {
    text: line,
    level: issue ? issue.severity : parseLogLevel(line),
    category: issue ? issue.category : 'general',
    issueCode: issue ? issue.code : '',
  };
}

function buildDiagnostics(lines, options = {}) {
  const stats = {
    total: 0,
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
  };
  const byCode = new Map();

  for (const rawLine of lines || []) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    stats.total += 1;
    const level = parseLogLevel(line);
    stats[level] = (stats[level] || 0) + 1;

    const issue = classifyLine(line);
    if (!issue) continue;

    const existing = byCode.get(issue.code) || {
      ...issue,
      count: 0,
      evidence: [],
      lastSeen: '',
    };
    existing.count += 1;
    existing.lastSeen = line;
    if (existing.evidence.length < 3) {
      existing.evidence.push(line);
    }
    byCode.set(issue.code, existing);
  }

  if (byCode.size === 0 && stats.error > 0) {
    byCode.set('UNCLASSIFIED_ERROR', {
      code: 'UNCLASSIFIED_ERROR',
      severity: 'error',
      category: 'general',
      title: 'Errors found, but no known cause matched',
      cause: 'The log contains error lines that do not match the built-in diagnostic rules.',
      action: 'Open the Errors filter and inspect the lines around the first error.',
      count: stats.error,
      evidence: [],
      lastSeen: '',
    });
  }

  const severityRank = { error: 0, warn: 1, info: 2, debug: 3 };
  const issues = Array.from(byCode.values()).sort((a, b) => {
    const severityDiff = (severityRank[a.severity] || 9) - (severityRank[b.severity] || 9);
    if (severityDiff !== 0) return severityDiff;
    return b.count - a.count;
  });

  return {
    generatedAt: new Date().toISOString(),
    source: options.source || '',
    truncated: !!options.truncated,
    stats,
    issues,
  };
}

module.exports = {
  annotateLine,
  buildDiagnostics,
  classifyLine,
  parseLogLevel,
};
