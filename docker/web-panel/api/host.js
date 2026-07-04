/**
 * Host control helpers for SMAPI-side server actions.
 *
 * The panel writes a small command file and AutoHideHost executes it from the
 * game thread. This avoids fragile /proc/<pid>/fd/0 stdin writes, which can be
 * denied by container TTY/proc permissions.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError, sendError } = require('../errors');
const config = require('../server');

const HOST_COMMAND_TIMEOUT_MS = parseInt(process.env.HOST_COMMAND_TIMEOUT_MS || '12000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readGameStateSnapshot() {
  try {
    if (!config.GAME_STATE_FILE || !fs.existsSync(config.GAME_STATE_FILE)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(config.GAME_STATE_FILE, 'utf-8'));
  } catch (error) {
    return {
      readError: error.message,
    };
  }
}

function createCommandId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function writeHostCommand(command) {
  const allowed = new Set([
    'autohide_expansion_mode start',
    'autohide_expansion_mode finish',
    'hidehost',
    'showhost',
  ]);

  if (!allowed.has(command)) {
    throw new AppError('Unsupported host command', {
      status: 400,
      code: 'HOST_COMMAND_NOT_ALLOWED',
      cause: 'The requested command is not in the panel host-control allowlist.',
      action: 'Use the built-in host control buttons or the SMAPI terminal for manual commands.',
    });
  }

  if (!config.HOST_COMMAND_FILE) {
    throw new AppError('Host command file is not configured', {
      status: 500,
      code: 'HOST_COMMAND_FILE_NOT_CONFIGURED',
      cause: 'HOST_COMMAND_FILE is empty, so the panel has nowhere to send host-control requests.',
      action: 'Recreate the container with the latest environment defaults.',
    });
  }

  const payload = {
    id: createCommandId(),
    command,
    requestedAt: new Date().toISOString(),
    requestedBy: 'web-panel',
  };

  try {
    fs.mkdirSync(path.dirname(config.HOST_COMMAND_FILE), { recursive: true });
    const tmpPath = `${config.HOST_COMMAND_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, config.HOST_COMMAND_FILE);
    return payload;
  } catch (error) {
    throw new AppError('Failed to write host command file', {
      status: 500,
      code: 'HOST_COMMAND_WRITE_FAILED',
      cause: 'The panel could not write the host-control command file used by AutoHideHost.',
      details: error.message,
      action: 'Check permissions for /home/steam/web-panel/data and restart the container after updating.',
    });
  }
}

async function waitForHostCommand(commandId, timeoutMs = HOST_COMMAND_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastState = null;

  do {
    lastState = readGameStateSnapshot();
    const hostCommand = lastState && lastState.hostCommand;
    if (hostCommand && hostCommand.id === commandId) {
      return {
        confirmed: true,
        state: lastState,
        hostCommand,
      };
    }

    await sleep(300);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    confirmed: false,
    state: lastState,
    hostCommand: lastState && lastState.hostCommand ? lastState.hostCommand : null,
  };
}

function throwUnconfirmedHostCommand(command, commandId, observed) {
  const state = observed && observed.state ? observed.state : null;
  const missingHostCommandBridge = state && state.worldReady === true && !(observed && observed.hostCommand);
  const loadedVersion = state && state.autoHideHostVersion ? state.autoHideHostVersion : '';
  const action = missingHostCommandBridge
    ? 'The running AutoHideHost did not expose hostCommand status. Update/rebuild the panel, restart the container, and confirm the bundled AutoHideHost mod was upgraded to v1.4.0 or newer.'
    : 'Check that AutoHideHost v1.4.0 or newer is loaded, wait for the save to finish loading, then retry.';

  throw new AppError('Host command was not confirmed by AutoHideHost', {
    status: 504,
    code: 'HOST_COMMAND_NOT_CONFIRMED',
    cause: 'The panel wrote the command file, but AutoHideHost did not report that it executed the command before the timeout.',
    details: JSON.stringify({
      command,
      commandId,
      autoHideHostVersion: loadedVersion || null,
      worldReady: state && state.worldReady,
      hostHidden: state && state.hostHidden,
      hostCommand: observed && observed.hostCommand ? observed.hostCommand : null,
      readError: state && state.readError,
    }),
    action,
  });
}

function throwFailedHostCommand(observed) {
  const hostCommand = observed && observed.hostCommand ? observed.hostCommand : {};
  throw new AppError('AutoHideHost rejected the host command', {
    status: 409,
    code: 'HOST_COMMAND_REJECTED',
    cause: hostCommand.message || 'AutoHideHost reported that the command could not be executed.',
    details: JSON.stringify(hostCommand),
    action: 'Open Diagnostics to check whether the save is loaded, the host is the main server, and no blocking menu/event is active.',
  });
}

async function sendConfirmedHostCommand(command) {
  const request = writeHostCommand(command);
  const observed = await waitForHostCommand(request.id);
  if (!observed.confirmed) {
    throwUnconfirmedHostCommand(command, request.id, observed);
  }
  if (!observed.hostCommand || observed.hostCommand.success !== true) {
    throwFailedHostCommand(observed);
  }

  return {
    command,
    commandId: request.id,
    hostCommand: observed.hostCommand,
    state: observed.state,
  };
}

async function startExpansionInit(req, res) {
  try {
    const result = await sendConfirmedHostCommand('autohide_expansion_mode start');
    res.json({
      success: true,
      action: 'start-expansion-init',
      message: 'Expansion mod initialization mode confirmed. Player event proxy remains the normal path; this manual mode is only for troubleshooting.',
      expansionModCompatibility: result.state.expansionModCompatibility || null,
      eventProxy: result.state.eventProxy || null,
      hostHidden: result.state.hostHidden === true,
      hostCommand: result.hostCommand,
      commandId: result.commandId,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'HOST_EXPANSION_START_FAILED',
      message: 'Failed to start expansion mod initialization mode',
      cause: 'The panel could not ask AutoHideHost to show the host.',
      action: 'Check that SMAPI is running and AutoHideHost v1.4.0 or newer is loaded.',
    });
  }
}

async function finishExpansionInit(req, res) {
  try {
    const result = await sendConfirmedHostCommand('autohide_expansion_mode finish');
    res.json({
      success: true,
      action: 'finish-expansion-init',
      message: 'Host hide command confirmed. Large mod compatibility remains enabled.',
      expansionModCompatibility: result.state.expansionModCompatibility || null,
      eventProxy: result.state.eventProxy || null,
      hostHidden: result.state.hostHidden === true,
      hostCommand: result.hostCommand,
      commandId: result.commandId,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'HOST_EXPANSION_FINISH_FAILED',
      message: 'Failed to hide host',
      cause: 'The panel could not ask AutoHideHost to hide the host.',
      action: 'Check that SMAPI is running and AutoHideHost v1.4.0 or newer is loaded.',
    });
  }
}

module.exports = {
  startExpansionInit,
  finishExpansionInit,
};
