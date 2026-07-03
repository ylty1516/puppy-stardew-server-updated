#!/bin/bash
# 部署验证脚本 - 检查所有功能是否正常
# Deployment verification script

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0
CONTAINER_NAME=${CONTAINER_NAME:-puppy-stardew}

check_pass() {
    echo -e "${GREEN}✓ PASS${NC} - $1"
    PASS=$((PASS + 1))
}

check_fail() {
    echo -e "${RED}✗ FAIL${NC} - $1"
    FAIL=$((FAIL + 1))
}

check_warn() {
    echo -e "${YELLOW}⚠ WARN${NC} - $1"
    WARN=$((WARN + 1))
}

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Puppy Stardew Server Verification${NC}"
echo -e "${BLUE}  部署验证检查${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if ! command -v docker >/dev/null 2>&1; then
    check_fail "Docker command not found"
    exit 1
fi

if ! docker ps >/dev/null 2>&1; then
    check_fail "Docker is not running or current user cannot access it"
    exit 1
fi

get_state_summary() {
    docker exec "$CONTAINER_NAME" node -e '
const fs = require("fs");
const file = process.env.GAME_STATE_FILE || "/home/steam/web-panel/data/game-state.json";
const maxAgeSeconds = 30;
function print(fields) {
  console.log(fields.map(value => String(value).replace(/[\r\n|]/g, " ")).join("|"));
}
try {
  if (!fs.existsSync(file)) {
    print(["missing", -1, 0, 0, 0, 0, "", ""]);
    process.exit(0);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const updatedAtMs = Date.parse(data.updatedAt || "");
  const ageSeconds = Number.isFinite(updatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
    : -1;
  const fresh = ageSeconds >= 0 && ageSeconds <= maxAgeSeconds;
  const visiblePlayers = Array.isArray(data.onlinePlayers)
    ? data.onlinePlayers.filter(player => player && player.isHost !== true)
    : [];
  print([
    fresh ? "fresh" : "stale",
    ageSeconds,
    data.worldReady === true ? 1 : 0,
    data.multiplayerReady === true ? 1 : 0,
    fresh && data.joinable === true ? 1 : 0,
    fresh ? visiblePlayers.length : 0,
    data.joinableReason || "",
    data.updatedAt || ""
  ]);
} catch (error) {
  print(["error", -1, 0, 0, 0, 0, error.message, ""]);
}
' 2>/dev/null || true
}

# 获取日志
LOG=$(docker logs "$CONTAINER_NAME" 2>&1 || true)

echo -e "${CYAN}[1/10] Container Status${NC}"
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    check_pass "Container is running"
else
    check_fail "Container is not running"
    exit 1
fi
echo ""

echo -e "${CYAN}[2/10] Game Download${NC}"
if echo "$LOG" | grep -q "Game downloaded successfully"; then
    check_pass "Game downloaded successfully"
elif echo "$LOG" | grep -q "Game files found"; then
    check_pass "Game files already present"
elif echo "$LOG" | grep -q "downloading"; then
    check_warn "Game is currently downloading (check logs)"
else
    check_fail "Game download status unclear"
fi
echo ""

echo -e "${CYAN}[3/10] SMAPI Installation${NC}"
if echo "$LOG" | grep -q "SMAPI installed successfully"; then
    check_pass "SMAPI installed"
elif echo "$LOG" | grep -q "SMAPI already installed"; then
    check_pass "SMAPI already installed"
else
    check_warn "SMAPI installation status unclear"
fi
echo ""

echo -e "${CYAN}[4/10] Mods Installation${NC}"
if echo "$LOG" | grep -q "Mods installed successfully"; then
    check_pass "Mods installed"
elif echo "$LOG" | grep -q "Mods already installed"; then
    check_pass "Mods already installed"
else
    check_warn "Mods installation status unclear"
fi
echo ""

echo -e "${CYAN}[5/10] Mod: Always On Server${NC}"
if echo "$LOG" | grep -q "AlwaysOnServer" || echo "$LOG" | grep -q "Always On Server"; then
    check_pass "Always On Server mod loaded"
else
    check_warn "Always On Server mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[6/10] Mod: AutoHideHost${NC}"
if echo "$LOG" | grep -q "AutoHideHost"; then
    check_pass "AutoHideHost mod loaded"
else
    check_warn "AutoHideHost mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[7/10] Mod: ServerAutoLoad${NC}"
if echo "$LOG" | grep -q "ServerAutoLoad"; then
    check_pass "ServerAutoLoad mod loaded"
else
    check_warn "ServerAutoLoad mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[8/10] Virtual Display${NC}"
if echo "$LOG" | grep -q "Virtual display started"; then
    check_pass "Xvfb virtual display running"
else
    check_fail "Virtual display not started"
fi
echo ""

echo -e "${CYAN}[9/10] VNC Server${NC}"
if echo "$LOG" | grep -q "VNC server started"; then
    check_pass "VNC server running on port 5900"
elif echo "$LOG" | grep -q "VNC disabled"; then
    check_warn "VNC is disabled (ENABLE_VNC=false)"
else
    check_warn "VNC status unclear"
fi
echo ""

echo -e "${CYAN}[10/10] Game Server${NC}"
if echo "$LOG" | grep -q "Server is starting" || echo "$LOG" | grep -q "StardewModdingAPI"; then
    check_pass "Game server is starting/running"
else
    check_warn "Game server status unclear (may still be initializing)"
fi
echo ""

echo -e "${CYAN}[Runtime] Web Panel API${NC}"
if docker exec "$CONTAINER_NAME" sh -lc 'curl -fsS --max-time 5 http://127.0.0.1:18642/api/auth/status >/dev/null' 2>/dev/null; then
    check_pass "Web panel API is reachable"
else
    check_fail "Web panel API is not reachable on port 18642"
fi
echo ""

echo -e "${CYAN}[Runtime] SMAPI State Bridge${NC}"
STATE_SUMMARY=$(get_state_summary)
IFS='|' read -r STATE_FRESHNESS STATE_AGE STATE_WORLD_READY STATE_MULTIPLAYER_READY STATE_JOINABLE STATE_PLAYERS STATE_REASON STATE_UPDATED_AT <<< "$STATE_SUMMARY"
case "$STATE_FRESHNESS" in
    fresh)
        check_pass "game-state.json is fresh (${STATE_AGE}s old, ${STATE_PLAYERS:-0} visible player(s))"
        ;;
    stale)
        check_warn "game-state.json is stale (${STATE_AGE}s old)"
        ;;
    missing|"")
        check_warn "game-state.json has not been written yet"
        ;;
    *)
        check_warn "game-state.json could not be parsed: ${STATE_REASON:-unknown error}"
        ;;
esac
echo ""

echo -e "${CYAN}[Runtime] Player Joinability${NC}"
if [ "$STATE_FRESHNESS" != "fresh" ]; then
    check_warn "Joinability is unknown until the state bridge is fresh"
elif [ "$STATE_JOINABLE" = "1" ]; then
    check_pass "Players should be able to join now"
else
    case "$STATE_REASON" in
        world_not_ready|saving|menu_open|blocking_event)
            check_warn "Players cannot join right now: ${STATE_REASON}"
            ;;
        not_main_server|multiplayer_not_initialized)
            check_fail "Multiplayer hosting is not ready: ${STATE_REASON}"
            ;;
        *)
            check_warn "Joinability is not ready: ${STATE_REASON:-unknown}"
            ;;
    esac
fi
echo ""

echo -e "${CYAN}[Runtime] Metrics Endpoint${NC}"
if docker exec "$CONTAINER_NAME" sh -lc 'curl -fsS --max-time 5 "http://127.0.0.1:${METRICS_PORT:-9090}/metrics" | grep -q puppy_stardew_game_running' 2>/dev/null; then
    check_pass "Metrics endpoint is reachable"
else
    check_warn "Metrics endpoint is not reachable yet"
fi
echo ""

# 检查错误
echo -e "${CYAN}[Error Check] Searching for errors...${NC}"
ERROR_LINES=$(echo "$LOG" | grep -i "error" | grep -vi "Rate Limit" | tail -3 || true)
if [ -n "$ERROR_LINES" ]; then
    check_warn "Found error messages in logs (review recommended)"
    echo -e "${YELLOW}Recent errors:${NC}"
    echo "$ERROR_LINES"
else
    check_pass "No errors found in logs"
fi
echo ""

# 端口检查
echo -e "${CYAN}[Port Check] Checking open ports...${NC}"
if docker port "$CONTAINER_NAME" 24642/udp >/dev/null 2>&1; then
    check_pass "Game port 24642/udp is mapped: $(docker port "$CONTAINER_NAME" 24642/udp)"
else
    check_fail "Game port 24642/udp is not mapped"
fi

if docker port "$CONTAINER_NAME" 18642/tcp >/dev/null 2>&1; then
    check_pass "Web panel port 18642/tcp is mapped: $(docker port "$CONTAINER_NAME" 18642/tcp)"
else
    check_fail "Web panel port 18642/tcp is not mapped"
fi

if docker port "$CONTAINER_NAME" 5900/tcp >/dev/null 2>&1; then
    check_pass "VNC port 5900/tcp is mapped: $(docker port "$CONTAINER_NAME" 5900/tcp)"
else
    check_warn "VNC port 5900/tcp is not mapped (VNC may be disabled)"
fi
echo ""

# 总结
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Summary / 总结${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ Deployment looks good!${NC}"
    echo -e "${GREEN}✓ 部署看起来正常！${NC}"
    echo ""
    echo -e "Next steps:"
    echo -e "  1. Connect via VNC: localhost:5900 or server-ip:5900"
    echo -e "  2. Click CO-OP → Start new co-op farm"
    echo -e "  3. Players can connect via invite code"
    exit 0
else
    echo -e "${RED}✗ Deployment has issues${NC}"
    echo -e "${RED}✗ 部署存在问题${NC}"
    echo ""
    echo -e "Review full logs with: docker logs $CONTAINER_NAME"
    exit 1
fi
