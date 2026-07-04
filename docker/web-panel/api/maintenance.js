/**
 * Maintenance API.
 *
 * Long-running destructive host tasks are executed by the manager container so
 * the web panel can report a real status instead of pretending the button works.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const config = require('../server');
const { AppError, sendError } = require('../errors');

const FACTORY_RESET_STATUS_FILE = path.join(config.DATA_DIR, 'factory-reset-status.json');
const FACTORY_RESET_LOG_FILE = path.join(config.DATA_DIR, 'factory-reset.log');
const MANAGER_TIMEOUT_MS = 8000;

function readTextTail(filePath, maxBytes = 32000) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const start = Math.max(0, stat.size - bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return '';
  }
}

function readLocalFactoryResetStatus() {
  let status = {
    state: 'idle',
    phase: 'idle',
    message: 'No factory reset has been started yet.',
    startedAt: '',
    updatedAt: '',
    completedAt: '',
    backupDir: '',
    logFile: FACTORY_RESET_LOG_FILE,
    exitCode: 0,
  };

  try {
    if (fs.existsSync(FACTORY_RESET_STATUS_FILE)) {
      status = {
        ...status,
        ...JSON.parse(fs.readFileSync(FACTORY_RESET_STATUS_FILE, 'utf8')),
      };
    }
  } catch (error) {
    status = {
      ...status,
      state: 'unknown',
      phase: 'status_read_failed',
      message: error.message || 'Failed to read factory reset status.',
    };
  }

  return {
    ...status,
    running: status.state === 'running',
    managerAvailable: false,
    logTail: readTextTail(FACTORY_RESET_LOG_FILE),
  };
}

function describeManagerError(error) {
  const rawMessage = error && error.message ? String(error.message) : 'Manager service is unavailable';
  const rawDetails = error && error.details ? String(error.details) : '';
  const text = [rawMessage, rawDetails, error && error.code].filter(Boolean).join('\n');

  if (/MANAGER_NOT_CONFIGURED/i.test(text)) {
    return {
      code: 'MANAGER_NOT_CONFIGURED',
      message: 'Maintenance manager is not configured.',
      cause: 'MANAGER_URL is empty, so the web panel cannot contact the stardew-manager service.',
      action: 'Recreate the stack with the latest docker-compose.yml so MANAGER_URL points to http://stardew-manager:18700.',
    };
  }

  if (/timeout|timed out/i.test(text)) {
    return {
      code: 'MANAGER_TIMEOUT',
      message: 'Maintenance manager request timed out.',
      cause: 'The stardew-manager container did not respond before the panel timeout.',
      action: 'Check "docker logs puppy-stardew-manager" and whether Docker is busy or stuck.',
    };
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|502|Bad Gateway/i.test(text)) {
    return {
      code: 'MANAGER_UNREACHABLE',
      message: 'Maintenance manager is unreachable.',
      cause: 'The web panel cannot reach the stardew-manager container that runs Docker maintenance tasks.',
      action: 'Run "docker ps | grep puppy-stardew-manager", then "docker logs puppy-stardew-manager". If it is missing, run "docker compose up -d --build stardew-manager stardew-server".',
    };
  }

  return {
    code: 'MANAGER_MAINTENANCE_FAILED',
    message: 'Maintenance manager returned an unexpected error.',
    cause: 'The stardew-manager service could not complete the maintenance request.',
    action: 'Check docker logs puppy-stardew-manager and verify Docker socket and project directory mounts.',
  };
}

function requestManager(method, route, body = null) {
  const managerUrl = process.env.MANAGER_URL || '';
  if (!managerUrl) {
    return Promise.reject(new AppError('Manager service is not configured', {
      status: 503,
      code: 'MANAGER_NOT_CONFIGURED',
      cause: 'MANAGER_URL is empty, so the panel cannot ask the manager container to run maintenance tasks.',
      action: 'Recreate the stack with the latest docker-compose.yml so the stardew-manager service is available.',
    }));
  }

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(route, managerUrl);
    } catch (error) {
      reject(new AppError('Invalid manager URL', {
        status: 500,
        code: 'INVALID_MANAGER_URL',
        cause: 'MANAGER_URL is not a valid URL.',
        action: 'Set MANAGER_URL to a valid internal manager URL.',
      }));
      return;
    }

    const payload = body ? JSON.stringify(body) : '';
    const client = parsed.protocol === 'https:' ? https : http;
    let timedOut = false;
    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: MANAGER_TIMEOUT_MS,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        let data = {};
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          data = { error: responseBody || `HTTP ${response.statusCode}` };
        }

        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve({
            ...data,
            managerAvailable: true,
          });
          return;
        }

        reject(new AppError(data.error || `HTTP ${response.statusCode}`, {
          status: response.statusCode || 500,
          code: data.code || 'MANAGER_MAINTENANCE_FAILED',
          cause: data.cause || 'The manager service rejected the maintenance request.',
          details: data.error || responseBody,
          action: data.action || 'Check docker logs puppy-stardew-manager and the maintenance log in the panel.',
        }));
      });
    });

    request.on('timeout', () => {
      timedOut = true;
      request.destroy(new Error('Manager request timed out'));
    });
    request.on('error', (error) => {
      reject(new AppError(timedOut ? 'Manager request timed out' : 'Manager service is unreachable', {
        status: 503,
        code: timedOut ? 'MANAGER_TIMEOUT' : 'MANAGER_UNREACHABLE',
        cause: timedOut
          ? 'The stardew-manager container did not respond before the panel timeout.'
          : 'The web panel could not connect to the stardew-manager container.',
        details: error.message,
        action: 'Check that the stardew-manager container is running and reachable at MANAGER_URL.',
      }));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

async function getFactoryResetStatus(req, res) {
  try {
    const status = await requestManager('GET', '/factory-reset/status');
    res.json(status);
  } catch (error) {
    const localStatus = readLocalFactoryResetStatus();
    const managerIssue = describeManagerError(error);
    res.json({
      ...localStatus,
      state: localStatus.state === 'idle' ? 'unknown' : localStatus.state,
      phase: localStatus.state === 'idle' ? 'manager_unavailable' : localStatus.phase,
      message: managerIssue.message,
      managerAvailable: false,
      managerUnavailable: true,
      canStart: false,
      managerError: error.message,
      code: managerIssue.code,
      cause: managerIssue.cause,
      action: managerIssue.action,
      updatedAt: new Date().toISOString(),
    });
  }
}

async function startFactoryReset(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    const result = await requestManager('POST', '/factory-reset', { confirmation });

    res.status(result.alreadyRunning ? 200 : 202).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: error.status || 500,
      code: error.code || 'FACTORY_RESET_START_FAILED',
      message: 'Failed to start factory reset',
      cause: error.cause || 'The panel could not start the factory reset task through the manager service.',
      details: error.details || error.message,
      action: error.action || 'Check MANAGER_URL, the stardew-manager container, Docker socket access, and project directory permissions.',
    });
  }
}

module.exports = {
  getFactoryResetStatus,
  startFactoryReset,
};
