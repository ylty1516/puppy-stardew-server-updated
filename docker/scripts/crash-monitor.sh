#!/bin/bash
# Game Wrapper with Auto-restart
# 游戏包装器，支持自动重启

GAME_DIR="/home/steam/stardewvalley"
MAX_RESTARTS=${MAX_CRASH_RESTARTS:-5}
RESTART_WINDOW=300  # 5 minutes

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[Game-Wrapper]${NC} $1"; }
log_error() { echo -e "${RED}[Game-Wrapper]${NC} $1"; }

RESTART_TIMES=()

can_restart() {
    local now=$(date +%s)
    local recent=0
    for t in "${RESTART_TIMES[@]}"; do
        [ $((now - t)) -lt $RESTART_WINDOW ] && recent=$((recent + 1))
    done
    [ $recent -lt $MAX_RESTARTS ]
}

cd "$GAME_DIR" || exit 1

while true; do
    log "启动游戏服务器..."
    ./StardewModdingAPI --server
    EXIT_CODE=$?

    log_error "游戏进程已退出（退出码: $EXIT_CODE）"

    if ! can_restart; then
        log_error "重启次数过多（${MAX_RESTARTS}次/${RESTART_WINDOW}秒）"
        log_error "容器将退出，请检查日志"
        exit 1
    fi

    RESTART_TIMES+=("$(date +%s)")
    [ ${#RESTART_TIMES[@]} -gt $MAX_RESTARTS ] && RESTART_TIMES=("${RESTART_TIMES[@]:1}")

    log "10秒后自动重启..."
    sleep 10
done

