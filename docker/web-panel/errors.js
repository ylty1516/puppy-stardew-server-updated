/**
 * Shared error helpers for the web panel.
 */

const crypto = require('crypto');

const DEFAULT_ACTION = 'Check the recent logs, then retry the operation.';

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = options.status || 500;
    this.code = options.code || 'INTERNAL_ERROR';
    this.cause = options.cause || '';
    this.details = options.details || '';
    this.action = options.action || DEFAULT_ACTION;
    this.metadata = options.metadata || undefined;
    this.expose = options.expose !== false;
  }
}

function requestId(req) {
  const incoming = req && req.headers && req.headers['x-request-id'];
  if (typeof incoming === 'string' && /^[A-Za-z0-9_.:-]{6,80}$/.test(incoming)) {
    return incoming;
  }

  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function trimOutput(value, maxLength = 1800) {
  if (!value) return '';
  const text = String(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function inferCause(error) {
  const text = [
    error && error.message,
    error && error.details,
    error && error.stderr,
    error && error.stdout,
  ].filter(Boolean).join('\n');

  if (/ENOENT|not found|command not found/i.test(text)) {
    return 'A required command or file was not found in the container.';
  }
  if (/EACCES|EPERM|Permission denied|access denied/i.test(text)) {
    return 'The panel could not access a required file or directory because of permissions.';
  }
  if (/ENOSPC|No space left|disk/i.test(text)) {
    return 'The host or container appears to be out of disk space.';
  }
  if (/timeout|timed out/i.test(text)) {
    return 'The operation timed out before the command completed.';
  }
  if (/invalid|corrupt|not a zip|End-of-central-directory/i.test(text)) {
    return 'The uploaded archive or request data appears to be invalid.';
  }

  return '';
}

function commandError(command, args, result, options = {}) {
  const stderr = trimOutput(result && result.stderr);
  const stdout = trimOutput(result && result.stdout);
  const systemError = result && result.error ? result.error.message : '';
  const detailParts = [
    systemError,
    stderr ? `stderr: ${stderr}` : '',
    stdout ? `stdout: ${stdout}` : '',
  ].filter(Boolean);

  return new AppError(options.message || `${command} failed`, {
    status: options.status || 500,
    code: options.code || (systemError && /ENOENT/i.test(systemError) ? 'COMMAND_NOT_FOUND' : 'COMMAND_FAILED'),
    cause: options.cause || inferCause({ message: systemError, details: detailParts.join('\n') }) || 'The command exited unsuccessfully.',
    details: detailParts.join('\n') || `Exit code: ${result && result.status}`,
    action: options.action || `Check container logs and verify that ${command} is installed and can access the target files.`,
    metadata: {
      command,
      args,
      exitCode: result && result.status,
      signal: result && result.signal,
    },
  });
}

function toPayload(req, error, defaults = {}) {
  const id = requestId(req);
  const status = error && error.status ? error.status : defaults.status || 500;
  const code = error && error.code ? error.code : defaults.code || 'INTERNAL_ERROR';
  const message = error && error.expose === false
    ? defaults.message || 'Unexpected server error'
    : (error && error.message) || defaults.message || 'Unexpected server error';
  const cause = (error && error.cause) || defaults.cause || inferCause(error) || '';
  const details = error && error.expose === false
    ? ''
    : (error && error.details) || defaults.details || '';
  const action = (error && error.action) || defaults.action || DEFAULT_ACTION;

  return {
    status,
    body: {
      error: message,
      code,
      cause,
      details,
      action,
      requestId: id,
      timestamp: new Date().toISOString(),
    },
  };
}

function logServerError(req, error, payload) {
  const status = payload.status;
  const level = status >= 500 ? 'error' : 'warn';
  const event = {
    level,
    scope: 'web-panel',
    requestId: payload.body.requestId,
    method: req && req.method,
    path: req && req.originalUrl,
    status,
    code: payload.body.code,
    message: payload.body.error,
    cause: payload.body.cause,
  };

  if (status >= 500 && error && error.stack) {
    event.stack = trimOutput(error.stack, 2400);
  }

  const logger = level === 'error' ? console.error : console.warn;
  logger(JSON.stringify(event));
}

function sendError(res, req, error, defaults = {}) {
  const payload = toPayload(req, error, defaults);
  logServerError(req, error, payload);
  return res.status(payload.status).json(payload.body);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = {
  AppError,
  asyncRoute,
  commandError,
  inferCause,
  sendError,
  trimOutput,
};
