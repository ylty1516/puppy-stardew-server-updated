#!/bin/bash
# Status Reporter - Prometheus metrics endpoint + JSON status file
# 状态报告器 - Prometheus 指标端点 + JSON 状态文件
#
# Serves Prometheus-format metrics on port 9090 via a lightweight HTTP handler.
# Also writes a JSON status file for local consumption.
#
# Metrics exposed:
#   puppy_stardew_game_running         - Whether the game process is alive (1/0)
#   puppy_stardew_uptime_seconds       - Game process uptime in seconds
#   puppy_stardew_players_online       - Number of connected players
#   puppy_stardew_memory_usage_mb      - Game process RSS memory in MB
#   puppy_stardew_cpu_usage_percent    - Game process CPU usage percent
#   puppy_stardew_events_passout_total - Total passout events detected
#   puppy_stardew_events_readycheck_total  - Total ready-check events
#   puppy_stardew_events_offline_total - Total offline-mode events
#   puppy_stardew_script_healthy       - Whether background scripts are alive (1/0)

STATUS_FILE="/home/steam/.local/share/puppy-stardew/status.json"
METRICS_FILE="/home/steam/.local/share/puppy-stardew/metrics.prom"
SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
GAME_STATE_FILE=${GAME_STATE_FILE:-/home/steam/web-panel/data/game-state.json}
GAME_STATE_MAX_AGE_SECONDS=${GAME_STATE_MAX_AGE_SECONDS:-30}
case "$GAME_STATE_MAX_AGE_SECONDS" in
    ''|*[!0-9]*)
        GAME_STATE_MAX_AGE_SECONDS=30
        ;;
esac
METRICS_PORT=${METRICS_PORT:-9090}
UPDATE_INTERVAL=15

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[Status-Reporter]${NC} $1"; }

mkdir -p "$(dirname "$STATUS_FILE")"
mkdir -p "$(dirname "$METRICS_FILE")"

# =============================================
# Metric collection functions
# =============================================

get_uptime_seconds() {
    local pid=$(pgrep -f StardewModdingAPI 2>/dev/null | head -1)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
        local start_time=$(stat -c %Y "/proc/$pid" 2>/dev/null)
        if [ -n "$start_time" ]; then
            echo $(($(date +%s) - start_time))
            return
        fi
    fi
    echo "0"
}

get_game_state_snapshot() {
    if node - "$GAME_STATE_FILE" "$GAME_STATE_MAX_AGE_SECONDS" <<'NODE' 2>/dev/null
const fs = require('fs');
const file = process.argv[2] || '';
const maxAgeSeconds = Math.max(5, Number(process.argv[3]) || 30);
const snapshot = {
  players: 0,
  fresh: 0,
  age: -1,
  world_ready: 0,
  multiplayer_ready: 0,
  joinable: 0,
  paused: 0,
  source: 'missing',
  updated_at: '',
};

try {
  if (!file || !fs.existsSync(file)) {
    throw new Error('missing');
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const updatedAtMs = Date.parse(data.updatedAt || '');
  const age = Number.isFinite(updatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
    : -1;
  const fresh = age >= 0 && age <= maxAgeSeconds;
  const visiblePlayers = Array.isArray(data.onlinePlayers)
    ? data.onlinePlayers.filter(player => player && player.isHost !== true)
    : [];

  snapshot.players = fresh ? visiblePlayers.length : 0;
  snapshot.fresh = fresh ? 1 : 0;
  snapshot.age = age;
  snapshot.world_ready = data.worldReady === true ? 1 : 0;
  snapshot.multiplayer_ready = data.multiplayerReady === true ? 1 : 0;
  snapshot.joinable = fresh && data.joinable === true ? 1 : 0;
  snapshot.paused = fresh && data.paused === true ? 1 : 0;
  snapshot.source = fresh ? 'smapi-state-bridge' : 'stale-smapi-state-bridge';
  snapshot.updated_at = typeof data.updatedAt === 'string' ? data.updatedAt : '';
} catch (error) {
  snapshot.source = error.message === 'missing' ? 'missing' : 'error';
}

for (const [key, value] of Object.entries(snapshot)) {
  console.log(`${key}=${String(value).replace(/[\r\n=]/g, ' ')}`);
}
NODE
    then
        return 0
    fi

    echo "players=0"
    echo "fresh=0"
    echo "age=-1"
    echo "world_ready=0"
    echo "multiplayer_ready=0"
    echo "joinable=0"
    echo "paused=0"
    echo "source=error"
    echo "updated_at="
}

get_player_count() {
    local snapshot players
    snapshot=$(get_game_state_snapshot)
    players=$(echo "$snapshot" | awk -F= '$1 == "players" { print $2; exit }')
    case "$players" in
        ''|*[!0-9]*)
            echo "0"
            ;;
        *)
            echo "$players"
            ;;
    esac
}

get_game_day() {
    if [ -f "$SMAPI_LOG" ]; then
        local day_info=""
        day_info=$(grep -oP "starting \K[a-z]+ \d+ Y\d+" "$SMAPI_LOG" 2>/dev/null | tail -1 || true)
        if [ -z "$day_info" ]; then
            day_info=$(grep -oP "Season:\s*\K[a-z]+, Day \d+, Year \d+" "$SMAPI_LOG" 2>/dev/null | tail -1 || true)
        fi
        echo "${day_info:-Unknown}"
    else
        echo "Not started"
    fi
}

get_game_paused() {
    if [ ! -f "$SMAPI_LOG" ]; then
        echo "0"
        return
    fi

    local latest_state
    latest_state=$(grep -nE "Disconnected: ServerOfflineMode|Starting LAN server|joined the game|player connected|farmhand connected|peer .* joined|client .* connected" "$SMAPI_LOG" 2>/dev/null | tail -1 || true)

    if echo "$latest_state" | grep -q "Disconnected: ServerOfflineMode"; then
        echo "1"
    else
        echo "0"
    fi
}

get_memory_usage_mb() {
    local pid=$(pgrep -f StardewModdingAPI 2>/dev/null | head -1)
    if [ -n "$pid" ] && [ -f "/proc/$pid/status" ]; then
        local rss=$(grep "VmRSS" "/proc/$pid/status" 2>/dev/null | awk '{print $2}')
        if [ -n "$rss" ]; then
            echo "$((rss / 1024))"
            return
        fi
    fi
    echo "0"
}

get_cpu_usage() {
    local pid=$(pgrep -f StardewModdingAPI 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
        local cpu=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ')
        echo "${cpu:-0.0}"
    else
        echo "0.0"
    fi
}

get_event_counts() {
    local passout=0 readycheck=0 offline=0
    if [ -f "$SMAPI_LOG" ]; then
        passout=$(grep -ciE "passed out|exhausted|collapsed" "$SMAPI_LOG" 2>/dev/null || echo "0")
        readycheck=$(grep -c "ReadyCheckDialog" "$SMAPI_LOG" 2>/dev/null || echo "0")
        offline=$(grep -c "ServerOfflineMode" "$SMAPI_LOG" 2>/dev/null || echo "0")
    fi
    echo "$passout $readycheck $offline"
}

check_script_health() {
    # Check that key background scripts are running
    local healthy=1
    if ! pgrep -f "event-handler.sh" >/dev/null 2>&1; then
        healthy=0
    fi
    echo "$healthy"
}

# =============================================
# Generate Prometheus-format metrics
# =============================================
update_metrics() {
    local game_running=0
    pgrep -f StardewModdingAPI >/dev/null 2>&1 && game_running=1

    local uptime=$(get_uptime_seconds)
    local state_snapshot
    state_snapshot=$(get_game_state_snapshot)
    local players=0
    local state_bridge_fresh=0
    local state_bridge_age=-1
    local state_world_ready=0
    local state_multiplayer_ready=0
    local state_joinable=0
    local state_paused=0
    local player_count_source="missing"
    local state_updated_at=""

    while IFS='=' read -r key value; do
        case "$key" in
            players) players=${value:-0} ;;
            fresh) state_bridge_fresh=${value:-0} ;;
            age) state_bridge_age=${value:--1} ;;
            world_ready) state_world_ready=${value:-0} ;;
            multiplayer_ready) state_multiplayer_ready=${value:-0} ;;
            joinable) state_joinable=${value:-0} ;;
            paused) state_paused=${value:-0} ;;
            source) player_count_source=${value:-missing} ;;
            updated_at) state_updated_at=${value:-} ;;
        esac
    done <<< "$state_snapshot"

    case "$players" in
        ''|*[!0-9]*)
            players=0
            ;;
    esac
    local game_day=$(get_game_day)
    local game_paused=$state_paused
    if [ "$state_bridge_fresh" != "1" ]; then
        game_paused=$(get_game_paused)
    fi
    local memory=$(get_memory_usage_mb)
    local cpu=$(get_cpu_usage)
    local events=($(get_event_counts))
    local passout=${events[0]:-0}
    local readycheck=${events[1]:-0}
    local offline=${events[2]:-0}
    local script_health=$(check_script_health)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Write Prometheus metrics file (atomic write via temp file)
    local tmp_metrics="${METRICS_FILE}.tmp"
    cat > "$tmp_metrics" << EOPROM
# HELP puppy_stardew_game_running Whether the Stardew Valley game process is running.
# TYPE puppy_stardew_game_running gauge
puppy_stardew_game_running $game_running

# HELP puppy_stardew_uptime_seconds Game process uptime in seconds.
# TYPE puppy_stardew_uptime_seconds gauge
puppy_stardew_uptime_seconds $uptime

# HELP puppy_stardew_players_online Number of players currently connected.
# TYPE puppy_stardew_players_online gauge
puppy_stardew_players_online $players

# HELP puppy_stardew_state_bridge_fresh Whether AutoHideHost game-state.json is fresh.
# TYPE puppy_stardew_state_bridge_fresh gauge
puppy_stardew_state_bridge_fresh $state_bridge_fresh

# HELP puppy_stardew_state_bridge_age_seconds Age of AutoHideHost game-state.json in seconds, or -1 if unavailable.
# TYPE puppy_stardew_state_bridge_age_seconds gauge
puppy_stardew_state_bridge_age_seconds $state_bridge_age

# HELP puppy_stardew_world_ready Whether the Stardew save is loaded.
# TYPE puppy_stardew_world_ready gauge
puppy_stardew_world_ready $state_world_ready

# HELP puppy_stardew_multiplayer_ready Whether the multiplayer server layer is initialized.
# TYPE puppy_stardew_multiplayer_ready gauge
puppy_stardew_multiplayer_ready $state_multiplayer_ready

# HELP puppy_stardew_joinable Whether players should be able to join right now.
# TYPE puppy_stardew_joinable gauge
puppy_stardew_joinable $state_joinable

# HELP puppy_stardew_memory_usage_mb Game process RSS memory usage in megabytes.
# TYPE puppy_stardew_memory_usage_mb gauge
puppy_stardew_memory_usage_mb $memory

# HELP puppy_stardew_cpu_usage_percent Game process CPU usage percentage.
# TYPE puppy_stardew_cpu_usage_percent gauge
puppy_stardew_cpu_usage_percent $cpu

# HELP puppy_stardew_events_passout_total Total number of passout events detected.
# TYPE puppy_stardew_events_passout_total counter
puppy_stardew_events_passout_total $passout

# HELP puppy_stardew_events_readycheck_total Total number of ready-check dialog events.
# TYPE puppy_stardew_events_readycheck_total counter
puppy_stardew_events_readycheck_total $readycheck

# HELP puppy_stardew_events_offline_total Total number of server-offline events.
# TYPE puppy_stardew_events_offline_total counter
puppy_stardew_events_offline_total $offline

# HELP puppy_stardew_script_healthy Whether background scripts are running.
# TYPE puppy_stardew_script_healthy gauge
puppy_stardew_script_healthy $script_health
EOPROM
    mv "$tmp_metrics" "$METRICS_FILE"

    # Write JSON status file for local tools
    local tmp_status="${STATUS_FILE}.tmp"
    cat > "$tmp_status" << EOJSON
{
  "timestamp": "$timestamp",
  "server": {
    "version": "1.1.0",
    "game_running": $([ "$game_running" = "1" ] && echo "true" || echo "false"),
    "uptime_seconds": $uptime
  },
  "game": {
    "day": "$game_day",
    "players_online": $players,
    "player_count_source": "$player_count_source",
    "paused": $([ "$game_paused" = "1" ] && echo "true" || echo "false"),
    "world_ready": $([ "$state_world_ready" = "1" ] && echo "true" || echo "false"),
    "multiplayer_ready": $([ "$state_multiplayer_ready" = "1" ] && echo "true" || echo "false"),
    "joinable": $([ "$state_joinable" = "1" ] && echo "true" || echo "false")
  },
  "state_bridge": {
    "fresh": $([ "$state_bridge_fresh" = "1" ] && echo "true" || echo "false"),
    "age_seconds": $state_bridge_age,
    "updated_at": "$state_updated_at",
    "max_age_seconds": $GAME_STATE_MAX_AGE_SECONDS
  },
  "resources": {
    "memory_mb": $memory,
    "cpu_percent": $cpu
  },
  "events": {
    "passout": $passout,
    "readycheck": $readycheck,
    "offline": $offline
  },
  "scripts_healthy": $([ "$script_health" = "1" ] && echo "true" || echo "false")
}
EOJSON
    mv "$tmp_status" "$STATUS_FILE"
}

# =============================================
# HTTP server using bash + nc (netcat)
# Serves /metrics endpoint on METRICS_PORT
# =============================================
serve_metrics() {
    log "Starting Prometheus metrics HTTP server on port $METRICS_PORT..."
    log "Prometheus 指标 HTTP 服务启动于端口 $METRICS_PORT..."

    while true; do
        # Read metrics file content
        local body=""
        if [ -f "$METRICS_FILE" ]; then
            body=$(cat "$METRICS_FILE" 2>/dev/null)
        else
            body="# No metrics available yet"
        fi

        local content_length=${#body}

        # Serve one request via nc (netcat-openbsd)
        # netcat-openbsd: -l PORT (no -p flag with -l)
        # -q 1: quit 1 second after EOF, -w 5: timeout 5s
        {
            echo -e "HTTP/1.1 200 OK\r"
            echo -e "Content-Type: text/plain; version=0.0.4; charset=utf-8\r"
            echo -e "Content-Length: ${content_length}\r"
            echo -e "Connection: close\r"
            echo -e "\r"
            echo -n "$body"
        } | nc -l "$METRICS_PORT" -q 1 -w 5 >/dev/null 2>&1
    done
}

# =============================================
# Main
# =============================================
log "Status reporter starting..."
log "状态报告器启动..."
log "  Metrics port: $METRICS_PORT"
log "  Update interval: ${UPDATE_INTERVAL}s"
log "  Status file: $STATUS_FILE"

# Wait for game to start
sleep 30

# Start HTTP server in background
serve_metrics &
SERVE_PID=$!
log "✓ HTTP metrics server started (PID: $SERVE_PID)"

# Metrics collection loop
while true; do
    update_metrics
    sleep $UPDATE_INTERVAL
done
