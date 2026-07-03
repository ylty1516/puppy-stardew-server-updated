/**
 * Shared helpers for the SMAPI game-state bridge.
 */

const fs = require('fs');
const config = require('../server');

const DEFAULT_GAME_STATE_MAX_AGE_SECONDS = 20;

function readGameStateBridge(maxAgeSeconds = DEFAULT_GAME_STATE_MAX_AGE_SECONDS) {
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
    const stale = ageSeconds === null || ageSeconds > maxAgeSeconds;

    return {
      ...data,
      available: true,
      stale,
      ageSeconds,
      staleAfterSeconds: maxAgeSeconds,
      file: config.GAME_STATE_FILE,
    };
  } catch (error) {
    return {
      ...emptyState,
      error: error.message,
    };
  }
}

function readFreshGameState(maxAgeSeconds = DEFAULT_GAME_STATE_MAX_AGE_SECONDS) {
  const gameState = readGameStateBridge(maxAgeSeconds);
  return gameState.available && !gameState.stale ? gameState : null;
}

function getVisiblePlayers(gameState) {
  if (!gameState || !Array.isArray(gameState.onlinePlayers)) {
    return [];
  }

  return gameState.onlinePlayers.filter(player => player && player.isHost !== true);
}

module.exports = {
  DEFAULT_GAME_STATE_MAX_AGE_SECONDS,
  getVisiblePlayers,
  readFreshGameState,
  readGameStateBridge,
};
