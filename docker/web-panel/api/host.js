/**
 * Host control helpers for SMAPI-only server actions.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../server');
const { AppError, sendError } = require('../errors');

const configuredCommandTimeoutMs = parseInt(process.env.PANEL_COMMAND_TIMEOUT_MS || '1500', 10);
const COMMAND_TIMEOUT_MS = Number.isFinite(configuredCommandTimeoutMs) && configuredCommandTimeoutMs > 0
  ? configuredCommandTimeoutMs
  : 1500;

function getSmapiPid() {
  try {
    return execSync('pgrep -f StardewModdingAPI', {
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT_MS,
    }).trim().split('\n')[0];
  } catch (error) {
    throw new AppError('SMAPI process not found', {
      status: 503,
      code: 'SMAPI_PROCESS_NOT_FOUND',
      cause: 'The game process is not running, so the panel cannot send host-control commands.',
      action: 'Start or restart the server, wait until SMAPI is loaded, then retry.',
    });
  }
}

function sendSmapiCommand(command) {
  const allowed = new Set([
    'autohide_expansion_mode start',
    'autohide_expansion_mode finish',
    'autohide_expansion_mode status',
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

  const pid = getSmapiPid();
  try {
    fs.writeFileSync(`/proc/${pid}/fd/0`, `${command}\n`);
    return { pid, command };
  } catch (error) {
    throw new AppError('Failed to send SMAPI command', {
      status: 500,
      code: 'SMAPI_COMMAND_SEND_FAILED',
      cause: 'The panel found SMAPI but could not write to its stdin.',
      details: error.message,
      action: 'Open the SMAPI terminal page and try the command manually, or restart the container.',
    });
  }
}

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

async function waitForExpansionState(mode, minUpdatedAtMs, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastState = null;

  do {
    lastState = readGameStateSnapshot();
    const updatedAtMs = lastState && lastState.updatedAt ? Date.parse(lastState.updatedAt) : NaN;
    const freshEnough = Number.isFinite(updatedAtMs) && updatedAtMs >= minUpdatedAtMs - 1000;
    const expansion = lastState && lastState.expansionModCompatibility;
    if (freshEnough && expansion && typeof expansion.autoSkipSkippableEvents === 'boolean') {
      const autoSkipDisabled = expansion.autoSkipSkippableEvents === false;
      if (mode === 'start' && autoSkipDisabled && (expansion.manualHostVisible === true || lastState.hostHidden === false)) {
        return {
          confirmed: true,
          state: lastState,
        };
      }

      if (mode === 'finish' && autoSkipDisabled && (expansion.manualHostVisible === false || lastState.hostHidden === true)) {
        return {
          confirmed: true,
          state: lastState,
        };
      }
    }

    await sleep(250);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    confirmed: false,
    state: lastState,
  };
}

function throwUnconfirmedExpansionMode(mode, observed) {
  const state = observed && observed.state ? observed.state : null;
  const expansion = state && state.expansionModCompatibility;
  throw new AppError('Host command was not confirmed by SMAPI state bridge', {
    status: 504,
    code: 'HOST_COMMAND_NOT_CONFIRMED',
    cause: 'The panel sent the SMAPI command, but AutoHideHost did not report the expected state before the confirmation timeout.',
    details: JSON.stringify({
      mode,
      updatedAt: state && state.updatedAt,
      worldReady: state && state.worldReady,
      hostHidden: state && state.hostHidden,
      expansionModCompatibility: expansion || null,
      readError: state && state.readError,
    }),
    action: 'Confirm AutoHideHost v1.2.9+ is loaded, check the SMAPI console, then retry after the save finishes loading.',
  });
}

async function startExpansionInit(req, res) {
  try {
    const commandAt = Date.now();
    const result = sendSmapiCommand('autohide_expansion_mode start');
    const observed = await waitForExpansionState('start', commandAt);
    if (!observed.confirmed) {
      throwUnconfirmedExpansionMode('start', observed);
    }

    res.json({
      success: true,
      action: 'start-expansion-init',
      message: 'Expansion mod initialization mode requested. Use VNC to complete the host-side intro event, then hide the host again.',
      expansionModCompatibility: observed.state.expansionModCompatibility || null,
      hostHidden: observed.state.hostHidden === true,
      ...result,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'HOST_EXPANSION_START_FAILED',
      message: 'Failed to start expansion mod initialization mode',
      cause: 'The panel could not ask AutoHideHost to show the host.',
      action: 'Check that SMAPI is running and AutoHideHost v1.2.9 or newer is loaded.',
    });
  }
}

async function finishExpansionInit(req, res) {
  try {
    const commandAt = Date.now();
    const result = sendSmapiCommand('autohide_expansion_mode finish');
    const observed = await waitForExpansionState('finish', commandAt);
    if (!observed.confirmed) {
      throwUnconfirmedExpansionMode('finish', observed);
    }

    res.json({
      success: true,
      action: 'finish-expansion-init',
      message: 'Host hide command sent. Large mod compatibility remains enabled.',
      expansionModCompatibility: observed.state.expansionModCompatibility || null,
      hostHidden: observed.state.hostHidden === true,
      ...result,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'HOST_EXPANSION_FINISH_FAILED',
      message: 'Failed to hide host',
      cause: 'The panel could not ask AutoHideHost to hide the host.',
      action: 'Check that SMAPI is running and AutoHideHost v1.2.9 or newer is loaded.',
    });
  }
}

module.exports = {
  startExpansionInit,
  finishExpansionInit,
};
