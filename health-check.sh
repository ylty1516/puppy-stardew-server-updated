#!/bin/bash
# =============================================================================
# Puppy Stardew Server - Health Check Script
# 小狗星谷服务器 - 健康检查脚本
# =============================================================================
# This script checks if your Stardew Valley server is running correctly.
# 此脚本检查您的星露谷物语服务器是否正常运行。
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# Container name
CONTAINER_NAME="puppy-stardew"

# Test results
TESTS_PASSED=0
TESTS_FAILED=0
WARNINGS=0

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${BOLD}  🏥 Puppy Stardew Server - Health Check${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
    WARNINGS=$((WARNINGS + 1))
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_test() {
    echo ""
    echo -e "${BOLD}$1${NC}"
}

# =============================================================================
# Health Check Tests
# =============================================================================

check_docker() {
    print_test "1. Checking Docker..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        return 1
    fi

    if ! docker ps &> /dev/null; then
        print_error "Docker is not running or requires sudo"
        return 1
    fi

    docker_version=$(docker --version | cut -d' ' -f3 | tr -d ',')
    print_success "Docker is running (version $docker_version)"
}

check_container_running() {
    print_test "2. Checking container status..."

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_error "Container is not running"

        # Check if it exists but is stopped
        if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            print_info "Container exists but is stopped. Start it with:"
            echo "  ${CYAN}docker compose up -d${NC}"
        else
            print_info "Container does not exist. Run the quick-start script:"
            echo "  ${CYAN}./quick-start.sh${NC}"
        fi
        return 1
    fi

    # Get container uptime
    uptime=$(docker inspect -f '{{.State.StartedAt}}' $CONTAINER_NAME)
    print_success "Container is running (started: $uptime)"
}

check_container_health() {
    print_test "3. Checking container health..."

    health_status=$(docker inspect -f '{{.State.Health.Status}}' $CONTAINER_NAME 2>/dev/null || echo "none")

    if [ "$health_status" = "healthy" ]; then
        print_success "Container health status: healthy"
    elif [ "$health_status" = "starting" ]; then
        print_warning "Container health status: starting (still initializing)"
    elif [ "$health_status" = "unhealthy" ]; then
        print_error "Container health status: unhealthy"
        print_info "Check logs: docker logs $CONTAINER_NAME"
        return 1
    else
        print_warning "No health check configured"
    fi
}

check_smapi_running() {
    print_test "4. Checking SMAPI (game process)..."

    if docker exec $CONTAINER_NAME pgrep -f StardewModdingAPI &> /dev/null; then
        # Get process details
        pid=$(docker exec $CONTAINER_NAME pgrep -f StardewModdingAPI)
        print_success "SMAPI is running (PID: $pid)"
    else
        print_error "SMAPI is not running"
        print_info "The game might still be downloading or initializing."
        print_info "Check logs: docker logs -f $CONTAINER_NAME"
        return 1
    fi
}

get_container_state_summary() {
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

check_web_panel() {
    print_test "5. Checking web panel..."

    if docker exec "$CONTAINER_NAME" sh -lc 'curl -fsS --max-time 5 http://127.0.0.1:18642/api/auth/status >/dev/null' 2>/dev/null; then
        print_success "Web panel API is reachable inside the container"
    else
        print_error "Web panel API is not reachable on port 18642"
        print_info "Check panel logs: docker logs $CONTAINER_NAME | grep -i \"Web Panel\""
        return 1
    fi
}

check_state_bridge() {
    print_test "6. Checking SMAPI state bridge..."

    local summary freshness age world_ready multiplayer_ready joinable players reason updated_at
    summary=$(get_container_state_summary)
    IFS='|' read -r freshness age world_ready multiplayer_ready joinable players reason updated_at <<< "$summary"

    case "$freshness" in
        fresh)
            print_success "State bridge is fresh (${age}s old, ${players:-0} visible player(s))"
            ;;
        stale)
            print_warning "State bridge exists but is stale (${age}s old)"
            print_info "AutoHideHost may have stopped writing game-state.json or the game may be frozen."
            ;;
        missing|"")
            print_warning "State bridge has not been written yet"
            print_info "Wait for the save to load, then rerun this check. If it never appears, verify AutoHideHost loaded."
            ;;
        *)
            print_warning "State bridge could not be parsed: ${reason:-unknown error}"
            ;;
    esac
}

check_joinability() {
    print_test "7. Checking player joinability..."

    local summary freshness age world_ready multiplayer_ready joinable players reason updated_at
    summary=$(get_container_state_summary)
    IFS='|' read -r freshness age world_ready multiplayer_ready joinable players reason updated_at <<< "$summary"

    if [ "$freshness" != "fresh" ]; then
        print_warning "Joinability is unknown because the SMAPI state bridge is not fresh"
        return 0
    fi

    if [ "$joinable" = "1" ]; then
        print_success "Game state says players should be able to join now"
        return 0
    fi

    case "$reason" in
        world_not_ready)
            print_warning "Save is not loaded yet; players cannot join until ServerAutoLoad finishes"
            ;;
        saving)
            print_warning "Game is saving; joinability should recover after saving finishes"
            ;;
        blocking_event)
            print_warning "A non-skippable event is blocking the host; use VNC if it stays stuck"
            ;;
        menu_open)
            print_warning "A host menu is open; automation may close it, otherwise use VNC"
            ;;
        not_main_server|multiplayer_not_initialized)
            print_error "Multiplayer hosting is not ready (${reason:-unknown})"
            print_info "Load the farm through Co-op/VNC or restart the container after the save is configured."
            return 1
            ;;
        *)
            print_warning "Game is not joinable yet (${reason:-unknown reason})"
            ;;
    esac
}

check_mods_loaded() {
    print_test "8. Checking mods..."

    # Check last 100 lines of logs for mod loading messages
    mod_count=$(docker logs --tail 100 $CONTAINER_NAME 2>&1 | grep -c "Loaded.*mod" || true)

    if [ "$mod_count" -ge 3 ]; then
        print_success "Mods loaded (detected $mod_count mods)"

        # List loaded mods
        print_info "Checking for core mods..."
        docker logs --tail 200 $CONTAINER_NAME 2>&1 | grep "Loaded.*mod" | grep -i "AlwaysOnServer\|AutoHideHost\|ServerAutoLoad" | while read -r line; do
            echo "  ${CYAN}→${NC} $(echo "$line" | grep -oP 'Loaded \K.*')"
        done
    elif [ "$mod_count" -gt 0 ]; then
        print_warning "Some mods loaded ($mod_count), but expected at least 3"
    else
        print_warning "No mods detected yet (server might still be starting)"
        print_info "Wait a few minutes and check again."
    fi
}

check_ports() {
    print_test "9. Checking port bindings..."

    # Check game port (24642/udp)
    if docker port $CONTAINER_NAME 24642/udp &> /dev/null; then
        game_port=$(docker port $CONTAINER_NAME 24642/udp)
        print_success "Game port is mapped: $game_port"
    else
        print_error "Game port (24642/udp) is not mapped"
        return 1
    fi

    # Check VNC port (5900/tcp) - optional
    if docker port $CONTAINER_NAME 5900/tcp &> /dev/null; then
        vnc_port=$(docker port $CONTAINER_NAME 5900/tcp)
        print_success "VNC port is mapped: $vnc_port"
    else
        print_info "VNC port not mapped (disabled or not configured)"
    fi

    if docker port $CONTAINER_NAME 18642/tcp &> /dev/null; then
        panel_port=$(docker port $CONTAINER_NAME 18642/tcp)
        print_success "Web panel port is mapped: $panel_port"
    else
        print_error "Web panel port (18642/tcp) is not mapped"
        return 1
    fi

    if docker port $CONTAINER_NAME 9090/tcp &> /dev/null; then
        metrics_port=$(docker port $CONTAINER_NAME 9090/tcp)
        print_success "Metrics port is mapped: $metrics_port"
    else
        print_warning "Metrics port (9090/tcp) is not mapped"
    fi
}

check_metrics_endpoint() {
    print_test "10. Checking metrics endpoint..."

    if docker exec "$CONTAINER_NAME" sh -lc 'curl -fsS --max-time 5 "http://127.0.0.1:${METRICS_PORT:-9090}/metrics" | grep -q puppy_stardew_game_running' 2>/dev/null; then
        print_success "Prometheus metrics endpoint is responding"
    else
        print_warning "Metrics endpoint is not responding yet"
        print_info "If this persists, check status-reporter.sh and the netcat dependency."
    fi
}

check_resources() {
    print_test "11. Checking resource usage..."

    # Get CPU and memory usage
    stats=$(docker stats $CONTAINER_NAME --no-stream --format "{{.CPUPerc}},{{.MemUsage}}")
    cpu=$(echo $stats | cut -d',' -f1)
    mem=$(echo $stats | cut -d',' -f2)

    echo "  ${CYAN}CPU:${NC} $cpu"
    echo "  ${CYAN}Memory:${NC} $mem"

    # Check if memory usage is too high (>90%)
    mem_percent=$(echo $mem | grep -oP '\d+\.\d+%' | head -1 | tr -d '%')
    if (( $(echo "$mem_percent > 90" | bc -l 2>/dev/null || echo 0) )); then
        print_warning "Memory usage is high (${mem_percent}%)"
        print_info "Consider increasing memory limit in docker-compose.yml"
    else
        print_success "Resource usage is normal"
    fi
}

check_disk_space() {
    print_test "12. Checking disk space..."

    # Check if data directory exists
    if [ ! -d "./data" ]; then
        print_warning "Data directory not found"
        return 1
    fi

    # Get data directory size
    data_size=$(du -sh ./data 2>/dev/null | cut -f1 || echo "unknown")
    echo "  ${CYAN}Data directory size:${NC} $data_size"

    # Check available disk space
    available_space=$(df -h . | tail -1 | awk '{print $4}')
    echo "  ${CYAN}Available space:${NC} $available_space"

    print_success "Disk space checked"
}

check_firewall() {
    print_test "13. Checking firewall..."

    # This is tricky to check automatically, so just provide guidance
    print_info "Make sure port 24642/udp is open in your firewall:"
    echo ""
    echo "  Ubuntu/Debian:"
    echo "    ${CYAN}sudo ufw allow 24642/udp${NC}"
    echo ""
    echo "  CentOS/RHEL:"
    echo "    ${CYAN}sudo firewall-cmd --add-port=24642/udp --permanent${NC}"
    echo "    ${CYAN}sudo firewall-cmd --reload${NC}"
    echo ""
}

show_summary() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}Summary:${NC}"
    echo -e "${GREEN}  ✅ Tests passed:  $TESTS_PASSED${NC}"
    if [ $TESTS_FAILED -gt 0 ]; then
        echo -e "${RED}  ❌ Tests failed:  $TESTS_FAILED${NC}"
    fi
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}  ⚠️  Warnings:     $WARNINGS${NC}"
    fi
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}${BOLD}🎉 Server is healthy!${NC}"
        echo ""
        echo "Players can connect to your server at:"
        echo "  ${CYAN}$(get_server_ip):24642${NC}"
    else
        echo -e "${YELLOW}${BOLD}⚠️  Some issues detected!${NC}"
        echo ""
        echo "Check the errors above and:"
        echo "  1. Review logs: ${CYAN}docker logs -f $CONTAINER_NAME${NC}"
        echo "  2. Restart if needed: ${CYAN}docker compose restart${NC}"
    fi
    echo ""
}

get_server_ip() {
    # Try to get public IP
    if command -v curl &> /dev/null; then
        public_ip=$(curl -s ifconfig.me 2>/dev/null || echo "")
        if [ -n "$public_ip" ]; then
            echo "$public_ip"
            return
        fi
    fi

    # Fall back to local IP
    if command -v hostname &> /dev/null; then
        hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip"
    else
        echo "your-server-ip"
    fi
}

# =============================================================================
# Main Script
# =============================================================================

main() {
    print_header

    check_docker || true
    check_container_running || true
    check_container_health || true
    check_smapi_running || true
    check_web_panel || true
    check_state_bridge || true
    check_joinability || true
    check_mods_loaded || true
    check_ports || true
    check_metrics_endpoint || true
    check_resources || true
    check_disk_space || true
    check_firewall || true

    show_summary
}

# Run main function
main
