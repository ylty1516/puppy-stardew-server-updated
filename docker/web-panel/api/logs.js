/**
 * Logs API - log reading, diagnostics and WebSocket streaming.
 */

const fs = require('fs');
const path = require('path');
const config = require('../server');
const { sendError } = require('../errors');
const { annotateLine, buildDiagnostics } = require('../diagnostics');

const MAX_LINES = 1000;
const DEFAULT_LINES = 300;
const configuredTailBytes = parseInt(process.env.PANEL_LOG_TAIL_BYTES || String(2 * 1024 * 1024), 10);
const MAX_TAIL_BYTES = Number.isFinite(configuredTailBytes) && configuredTailBytes > 0
  ? configuredTailBytes
  : 2 * 1024 * 1024;

// Log file mapping
const LOG_FILES = {
  all: 'smapi-latest.log',
  error: 'errors.log',
  mod: 'mods.log',
  server: 'server.log',
  game: 'game.log',
  diagnostic: 'diagnostics.log',
};

function getCategorizedLogPath(filter) {
  const filename = LOG_FILES[filter] || LOG_FILES.all;
  return path.join(config.LOG_DIR, 'categorized', filename);
}

function getLogSource(filter) {
  if (filter === 'all' || filter === 'smapi') {
    return { path: config.SMAPI_LOG, filtered: false, source: 'smapi' };
  }

  if (filter === 'diagnostic') {
    const categorizedPath = getCategorizedLogPath(filter);
    if (fs.existsSync(categorizedPath)) {
      return { path: categorizedPath, filtered: false, source: 'diagnostic' };
    }
    return { path: config.SMAPI_LOG, filtered: true, source: 'smapi' };
  }

  if (filter === 'mod' || filter === 'server' || filter === 'game') {
    return { path: config.SMAPI_LOG, filtered: true, source: 'smapi' };
  }

  const categorizedPath = getCategorizedLogPath(filter);
  if (fs.existsSync(categorizedPath)) {
    return { path: categorizedPath, filtered: false, source: 'categorized' };
  }

  return { path: config.SMAPI_LOG, filtered: true, source: 'smapi' };
}

function matchesFilter(filter, line) {
  if (!line || filter === 'all' || filter === 'smapi') return true;
  if (filter === 'diagnostic') return !!annotateLine(line).issueCode;
  if (filter === 'error') return /ERROR|FATAL|Exception/i.test(line);
  if (filter === 'mod') {
    return /\[\d{2}:\d{2}:\d{2}\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(?!SMAPI\b|game\b)([^\]]+)\]/i.test(line);
  }
  if (filter === 'server') {
    return /Starting LAN server|Starting server\. Protocol|ServerOfflineMode|Multiplayer|Connection|joined the game|left the game|farmhand|player connected|player disconnected|peer .* joined|peer .* left|client .* connected|client .* disconnected/i.test(line);
  }
  if (filter === 'game') {
    return /\[\d{2}:\d{2}:\d{2}\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+game\]/i.test(line) &&
      !matchesFilter('server', line);
  }
  return true;
}

function normalizeLinesParam(value) {
  const parsed = parseInt(value || String(DEFAULT_LINES), 10);
  if (Number.isNaN(parsed)) return DEFAULT_LINES;
  return Math.max(25, Math.min(MAX_LINES, parsed));
}

function readTailLines(logPath) {
  const stat = fs.statSync(logPath);
  const bytesToRead = Math.min(stat.size, MAX_TAIL_BYTES);
  const start = Math.max(0, stat.size - bytesToRead);
  const fd = fs.openSync(logPath, 'r');

  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
    const content = buffer.subarray(0, bytesRead).toString('utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    return {
      lines: start > 0 ? lines.slice(1) : lines,
      truncated: start > 0,
      size: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function filterLines(lines, filter, source, search) {
  let filtered = lines;

  if (source.filtered) {
    filtered = filtered.filter(line => matchesFilter(filter, line));
  }

  if (search) {
    const searchLower = String(search).toLowerCase();
    filtered = filtered.filter(line => line.toLowerCase().includes(searchLower));
  }

  return filtered;
}

// ─── HTTP Handler ────────────────────────────────────────────────

function getLogs(req, res) {
  const filter = req.query.type || 'all';
  const lines = normalizeLinesParam(req.query.lines);
  const search = req.query.search || '';
  const source = getLogSource(filter);
  const logPath = source.path;

  if (!fs.existsSync(logPath)) {
    return res.json({
      lines: [],
      total: 0,
      file: path.basename(logPath),
      path: logPath,
      exists: false,
      diagnostics: buildDiagnostics([], { source: path.basename(logPath) }),
    });
  }

  try {
    const tail = readTailLines(logPath);
    const allLines = filterLines(tail.lines, filter, source, search);
    const result = allLines.slice(-lines).map(annotateLine);
    const diagnostics = buildDiagnostics(allLines.slice(-500), {
      source: path.basename(logPath),
      truncated: tail.truncated,
    });

    res.json({
      lines: result,
      total: allLines.length,
      file: path.basename(logPath),
      source: source.source,
      exists: true,
      truncated: tail.truncated,
      maxTailBytes: MAX_TAIL_BYTES,
      diagnostics,
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'LOG_READ_FAILED',
      message: 'Failed to read log file',
      cause: 'The panel could not read the selected log source.',
      details: e.message,
      action: 'Check log file permissions and whether the container has generated SMAPI logs yet.',
    });
  }
}

// ─── WebSocket Log Streaming ─────────────────────────────────────

function subscribeLogs(ws, filter) {
  const source = getLogSource(filter);
  const logPath = source.path;

  // Close existing watcher
  if (ws._logWatcher) {
    ws._logWatcher.close();
    ws._logWatcher = null;
  }

  if (!fs.existsSync(logPath)) {
    ws.send(JSON.stringify({
      type: 'log',
      line: {
        text: `Log file not found: ${path.basename(logPath)}`,
        level: 'warn',
        category: 'log',
        issueCode: 'LOG_FILE_MISSING',
      },
    }));
    return;
  }

  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch (e) {
    fileSize = 0;
  }

  const watcher = fs.watch(logPath, (eventType) => {
    if (eventType !== 'change') return;

    try {
      const stat = fs.statSync(logPath);
      if (stat.size <= fileSize) {
        // File was truncated or rotated.
        fileSize = 0;
      }

      const stream = fs.createReadStream(logPath, {
        start: fileSize,
        encoding: 'utf-8',
      });

      let newData = '';
      stream.on('data', (chunk) => { newData += chunk; });
      stream.on('end', () => {
        fileSize = stat.size;
        const lines = newData.split(/\r?\n/).filter(line => line.trim());
        for (const line of lines) {
          if (source.filtered && !matchesFilter(filter, line)) {
            continue;
          }
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'log',
              line: annotateLine(line),
            }));
          }
        }
      });
      stream.on('error', () => {});
    } catch (e) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'LOG_STREAM_FAILED',
          message: 'Log stream interrupted',
          cause: 'The log file may have been deleted, rotated, or temporarily inaccessible.',
        }));
      }
    }
  });

  ws._logWatcher = watcher;

  ws.send(JSON.stringify({
    type: 'log:subscribed',
    filter,
    file: path.basename(logPath),
  }));
}

module.exports = { getLogs, subscribeLogs };
