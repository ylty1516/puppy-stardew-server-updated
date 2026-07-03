/**
 * Players API - Online player information
 */

const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../server');
const { getVisiblePlayers, readFreshGameState } = require('./game-state');

// Player history (in-memory)
const playerHistory = [];
const MAX_PLAYER_HISTORY = 288; // 24h at 5-min intervals

// Track connected players from log parsing
let connectedPlayers = [];
let lastLogParse = 0;

function getPlayersFromGameState(gameState) {
  const visiblePlayers = getVisiblePlayers(gameState);
  if (!gameState || !Array.isArray(gameState.onlinePlayers)) {
    return null;
  }

  return visiblePlayers.map(player => ({
    id: player.id || player.name || 'unknown',
    name: player.name || normalizePlayerLabel(player.id || ''),
    location: player.location || '',
    inBed: player.inBed === true,
  }));
}

function normalizePlayerLabel(value) {
  if (!value) {
    return 'Player';
  }

  if (/^\d+$/.test(value)) {
    return `Farmhand ${value.slice(-6)}`;
  }

  return value;
}

function parsePlayersFromLogs() {
  const now = Date.now();
  if (now - lastLogParse < 10000) return connectedPlayers; // Cache 10s

  try {
    const logPath = config.SMAPI_LOG;
    if (!fs.existsSync(logPath)) return connectedPlayers;

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    const players = new Map();

    for (const line of lines) {
      // Detect player connections
      const joinMatch = line.match(/(\w+) connected/i) ||
                        line.match(/peer (\w+) joined/i) ||
                        line.match(/(\w+) joined the game/i) ||
                        line.match(/farmhand (\w+) connected/i) ||
                        line.match(/client (\w+) connected/i) ||
                        line.match(/Received connection for vanilla player ([A-Za-z0-9_]+)/i) ||
                        line.match(/Approved request for farmhand ([A-Za-z0-9_]+)/i);
      if (joinMatch) {
        const id = joinMatch[1];
        if (id !== 'Server' && id !== 'SMAPI') {
          players.set(id, {
            id,
            name: normalizePlayerLabel(id),
            joinedAt: new Date().toISOString(),
          });
        }
      }

      // Detect player disconnections
      const leaveMatch = line.match(/(\w+) disconnected/i) ||
                         line.match(/peer (\w+) left/i) ||
                         line.match(/(\w+) left the game/i) ||
                         line.match(/farmhand (\w+) disconnected/i) ||
                         line.match(/client (\w+) disconnected/i) ||
                         line.match(/connection ([A-Za-z0-9_]+) disconnected/i) ||
                         line.match(/player ([A-Za-z0-9_]+) disconnected/i);
      if (leaveMatch) {
        players.delete(leaveMatch[1]);
      }
    }

    connectedPlayers = Array.from(players.values());
    lastLogParse = now;
  } catch (e) {
    // Log parsing failed, keep last known state
  }

  return connectedPlayers;
}

function getOnlineCount() {
  const gameState = readFreshGameState();
  const players = getPlayersFromGameState(gameState);
  if (players) {
    return players.length;
  }

  return 0;
}

// Record player count history every 5 minutes
setInterval(() => {
  const count = getOnlineCount();
  playerHistory.push({
    timestamp: new Date().toISOString(),
    count,
  });
  if (playerHistory.length > MAX_PLAYER_HISTORY) {
    playerHistory.shift();
  }
}, 5 * 60 * 1000);

// ─── Route Handler ───────────────────────────────────────────────

function getPlayers(req, res) {
  const gameState = readFreshGameState();
  const statePlayers = getPlayersFromGameState(gameState);
  if (statePlayers) {
    return res.json({
      online: statePlayers.length,
      max: 4,
      players: statePlayers,
      source: 'smapi-state-bridge',
      refreshedAt: gameState.updatedAt || null,
      history: playerHistory,
    });
  }

  parsePlayersFromLogs();

  res.json({
    online: 0,
    max: 4,
    players: [],
    source: 'untrusted',
    history: playerHistory,
  });
}

module.exports = { getPlayers };
