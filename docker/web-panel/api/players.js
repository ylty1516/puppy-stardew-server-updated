/**
 * Players API - Online player information
 */

const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../server');

// Player history (in-memory)
const playerHistory = [];
const MAX_PLAYER_HISTORY = 288; // 24h at 5-min intervals

// Track connected players from log parsing
let connectedPlayers = [];
let lastLogParse = 0;

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
  try {
    if (fs.existsSync(config.STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.STATUS_FILE, 'utf-8'));
      // Support nested structure
      if (data.game && data.game.players_online !== undefined) {
        return data.game.players_online || 0;
      }
      return data.players_online || 0;
    }
  } catch (e) {}
  return connectedPlayers.length;
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
  const players = parsePlayersFromLogs();
  const online = getOnlineCount();

  res.json({
    online: Math.max(online, players.length),
    max: 4,
    players,
    history: playerHistory,
  });
}

module.exports = { getPlayers };
