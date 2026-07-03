#!/bin/bash
# Unified Event Handler - Monitors SMAPI logs and handles all game events
# 统一事件处理器 - 监控 SMAPI 日志并处理所有游戏事件
#
# Replaces individual polling scripts with a single tail -F stream processor.
# 用单一的 tail -F 流式处理器替代多个独立轮询脚本。
#
# Handles:
#   - Passout (2AM)        : Escape + Enter confirmations
#   - ReadyCheckDialog     : Enter confirmations (earthquake etc.)
#   - ServerOfflineMode    : F9 to re-enable server
#   - Save loaded          : F9 to enable AlwaysOnServer auto mode

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10

# Cooldown tracking (seconds since epoch)
LAST_PASSOUT_TIME=0
LAST_READYCHECK_TIME=0
LAST_OFFLINE_TIME=0

# Cooldown durations (seconds)
PASSOUT_COOLDOWN=30
READYCHECK_COOLDOWN=10
OFFLINE_COOLDOWN=60

# Color codes for each event type
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

log_passout()    { echo -e "${YELLOW}[Event-Passout]${NC} $1"; }
log_readycheck() { echo -e "${PURPLE}[Event-ReadyCheck]${NC} $1"; }
log_reconnect()  { echo -e "${CYAN}[Event-Reconnect]${NC} $1"; }
log_enable()     { echo -e "${CYAN}[Event-AutoEnable]${NC} $1"; }
log_info()       { echo -e "${GREEN}[Event-Handler]${NC} $1"; }

# Set DISPLAY for xdotool
export DISPLAY=:99

# ============================================
# Send key with mutex lock
# 使用互斥锁发送按键
# ============================================
send_key_locked() {
    local key="$1"
    (
        if flock -w "$LOCK_TIMEOUT" 200; then
            xdotool key "$key" 2>/dev/null
        else
            log_info "⚠��� 无法获取按键锁 (key: $key)"
            return 1
        fi
    ) 200>"$LOCK_FILE"
}

# ============================================
# Check cooldown
# 检查冷却时间
# ============================================
check_cooldown() {
    local last_time="$1"
    local cooldown="$2"
    local current_time
    current_time=$(date +%s)
    if [ $((current_time - last_time)) -lt "$cooldown" ]; then
        return 1  # Still in cooldown
    fi
    return 0  # Cooldown expired
}

# ============================================
# Event handlers
# 事件处理函数
# ============================================

handle_passout() {
    if ! check_cooldown "$LAST_PASSOUT_TIME" "$PASSOUT_COOLDOWN"; then
        return
    fi

    log_passout "⚠️ 检测到晕倒事件（凌晨2点）"
    LAST_PASSOUT_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_passout "❌ xdotool 未安装"
        return
    fi

    sleep 3

    log_passout "  步骤 1: 关闭可能的菜单..."
    send_key_locked Escape
    sleep 0.5

    log_passout "  步骤 2: 连续确认对话框..."
    for i in 1 2 3 4 5; do
        send_key_locked Return
        sleep 1
    done

    log_passout "✅ 已尝试确认晕倒对话框"

    # Verify if new day started
    sleep 5
    if tail -20 "$SMAPI_LOG" 2>/dev/null | grep -qiE "Saving|woke up|Day [0-9]"; then
        log_passout "✅ 确认：新的一天已开始"
    fi
}

handle_readycheck() {
    if ! check_cooldown "$LAST_READYCHECK_TIME" "$READYCHECK_COOLDOWN"; then
        return
    fi

    log_readycheck "⚠️ 检测到 ReadyCheckDialog（特殊事件确认对话框）"
    LAST_READYCHECK_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_readycheck "❌ xdotool 未安装"
        return
    fi

    sleep 2

    log_readycheck "模拟按 Enter 键自动确认..."
    for i in 1 2 3; do
        send_key_locked Return
        sleep 0.5
    done
    log_readycheck "✅ 已发送确认按键"
}

handle_offline() {
    if ! check_cooldown "$LAST_OFFLINE_TIME" "$OFFLINE_COOLDOWN"; then
        return
    fi

    log_reconnect "⚠️ 检测到 ServerOfflineMode"
    LAST_OFFLINE_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_reconnect "❌ xdotool 未安装"
        return
    fi

    sleep 5

    log_reconnect "尝试重新启用服务器..."

    # Close menus
    for i in 1 2 3; do
        send_key_locked Escape
        sleep 0.2
    done
    sleep 1

    # Press F9 twice (off then on)
    send_key_locked F9
    sleep 2
    send_key_locked F9

    log_reconnect "✅ F9 按键已发送，等待验证..."
}

# Flag: has AlwaysOnServer been enabled this session?
AOS_ENABLED=false

handle_save_loaded() {
    if [ "$AOS_ENABLED" = "true" ]; then
        return
    fi

    log_enable "✓ 检测到存档已加载"

    if ! command -v xdotool >/dev/null 2>&1; then
        log_enable "❌ xdotool 未安装"
        return
    fi

    # Wait for mods to initialize
    log_enable "等待模组初始化..."
    sleep 5

    # Check if AlwaysOnServer is already enabled
    local on_count off_count
    on_count=$(grep -o "Auto [Mm]ode [Oo]n" "$SMAPI_LOG" 2>/dev/null | wc -l)
    off_count=$(grep -o "Auto mode off" "$SMAPI_LOG" 2>/dev/null | wc -l)

    log_enable "  状态: ON=$on_count, OFF=$off_count"

    if [ "$on_count" -gt "$off_count" ]; then
        log_enable "✅ Always On Server 已经处于启用状态"
        AOS_ENABLED=true
        return
    fi

    # Try to enable with F9 (up to 3 attempts)
    for attempt in 1 2 3; do
        log_enable "  尝试 #$attempt: 关闭菜单并按 F9..."

        for i in 1 2 3; do
            send_key_locked Escape
            sleep 0.3
        done
        sleep 1

        send_key_locked F9
        log_enable "  ✓ F9 按键已发送（尝试 #$attempt）"
        sleep 5

        # Check status
        on_count=$(grep -o "Auto [Mm]ode [Oo]n" "$SMAPI_LOG" 2>/dev/null | wc -l)
        off_count=$(grep -o "Auto mode off" "$SMAPI_LOG" 2>/dev/null | wc -l)

        if [ "$on_count" -gt "$off_count" ]; then
            log_enable "✅ Always On Server 已成功启用！"
            AOS_ENABLED=true
            return
        fi

        if [ "$attempt" -lt 3 ]; then
            log_enable "  未检测到启用，10秒后重试..."
            sleep 10
        fi
    done

    log_enable "⚠️ 3次尝试后仍未确认启用，建议通过 VNC 手动检查"
    AOS_ENABLED=true  # Prevent repeated attempts
}

# ============================================
# Main: Wait for game initialization
# 主程序：等待游戏初始化
# ============================================

log_info "========================================"
log_info "  Unified Event Handler Starting..."
log_info "  统一事件处理器启动中..."
log_info "========================================"
log_info ""
log_info "Monitoring events / 监控事件:"
log_info "  - Passout (2AM) / 凌晨2点晕倒"
log_info "  - ReadyCheckDialog / 特殊事件确认"
log_info "  - ServerOfflineMode / 服务器离线"
log_info "  - Save Loaded / 存档加载"
log_info ""

log_info "等待游戏初始化..."
sleep 20

# Wait for log file to exist
WAIT_COUNT=0
while [ ! -f "$SMAPI_LOG" ]; do
    if [ $((WAIT_COUNT % 12)) -eq 0 ]; then
        log_info "等待 SMAPI 日志文件创建..."
    fi
    sleep 5
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [ "$WAIT_COUNT" -gt 60 ]; then
        log_info "⚠️ 等待日志文件超时（5分钟），继续等待..."
        WAIT_COUNT=0
    fi
done

log_info "✓ SMAPI 日志文件就绪: $SMAPI_LOG"

# Heartbeat counter
LINE_COUNT=0
HEARTBEAT_INTERVAL=3600  # Log heartbeat every ~1 hour worth of lines

# ============================================
# Stream processing with tail -F
# 使用 tail -F 流式处理
# ============================================
# -n 0: Start from end of file (ignore old content)
# -F: Follow file even if rotated/replaced

log_info "开始实时日志监控 (tail -F)..."

tail -n 0 -F "$SMAPI_LOG" 2>/dev/null | while IFS= read -r line; do
    LINE_COUNT=$((LINE_COUNT + 1))

    # Heartbeat log
    if [ $((LINE_COUNT % $HEARTBEAT_INTERVAL)) -eq 0 ]; then
        log_info "💓 事件处理器运行正常（已处理 $LINE_COUNT 行日志）"
    fi

    # Match events by priority (most critical first)
    case "$line" in
        *"ServerOfflineMode"*|*"[ServerOfflineMode]"*)
            handle_offline
            ;;
        *"SAVE LOADED SUCCESSFULLY"*|*"Context: loaded save"*)
            handle_save_loaded
            ;;
        *"ReadyCheckDialog"*)
            handle_readycheck
            ;;
        *"passed out"*|*"Passed Out"*|*"exhausted"*|*"Exhausted"*|*"collapsed"*|*"Collapsed"*)
            handle_passout
            ;;
    esac
done

# If tail -F exits (shouldn't normally happen), restart
log_info "⚠️ tail -F 意外退出，10秒后重启..."
sleep 10
exec "$0" "$@"
