#!/bin/bash
# Auto-Reconnect Server - Background Script
# 自动重连服务器 - 后台脚本
#
# This script monitors SMAPI logs for ServerOfflineMode
# and automatically re-enables the LAN server when detected.
# 此脚本监控 SMAPI 日志中的 ServerOfflineMode
# 检测到时自动重新启用 LAN 服务器。

# DO NOT use set -e for long-running background scripts
# 长期运行的后台脚本不使用 set -e

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
CHECK_INTERVAL=60  # Check every 60 seconds
OFFLINE_MARKER="[ServerOfflineMode]"
LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10

log() {
    echo -e "\033[0;36m[Auto-Reconnect]\033[0m $1"
}

# Send key with mutex lock
send_key_locked() {
    local key="$1"
    (
        if flock -w "$LOCK_TIMEOUT" 200; then
            xdotool key "$key" 2>/dev/null
        else
            log "⚠️ 无法获取按键锁"
            return 1
        fi
    ) 200>"$LOCK_FILE"
}

log "启动服务器自动重连监控服务..."
log "检查间隔: ${CHECK_INTERVAL}秒"

# Wait for game initialization
log "等待游戏初始化..."
sleep 20

# Track if we've seen ServerOfflineMode in current session
OFFLINE_DETECTED=false
LAST_OFFLINE_COUNT=0

# Main monitoring loop
while true; do
    if [ -f "$SMAPI_LOG" ]; then
        # Count ServerOfflineMode occurrences
        CURRENT_OFFLINE_COUNT=$(grep -c "$OFFLINE_MARKER" "$SMAPI_LOG" 2>/dev/null || echo "0")

        # Check if count increased (new offline event detected)
        if [ "$CURRENT_OFFLINE_COUNT" -gt "$LAST_OFFLINE_COUNT" ]; then
            log "⚠️ 检测到 ServerOfflineMode（计数: $LAST_OFFLINE_COUNT -> $CURRENT_OFFLINE_COUNT）"

            # Wait a moment to avoid false positives
            sleep 5

            # Re-verify
            VERIFY_COUNT=$(grep -c "$OFFLINE_MARKER" "$SMAPI_LOG" 2>/dev/null || echo "0")
            if [ "$VERIFY_COUNT" -gt "$LAST_OFFLINE_COUNT" ]; then
                log "✓ 确认 ServerOfflineMode，尝试重新启用服务器..."

                # Set DISPLAY for xdotool
                export DISPLAY=:99

                # Method 1: Try pressing F9 first (toggle AlwaysOnServer)
                if command -v xdotool >/dev/null 2>&1; then
                    log "  方式 1: 按 F9 切换 AlwaysOnServer..."

                    # Close any open menus first
                    for i in 1 2 3; do
                        send_key_locked Escape
                        sleep 0.2
                    done
                    sleep 1

                    # Press F9 twice to ensure server re-enables
                    send_key_locked F9
                    sleep 2
                    send_key_locked F9

                    log "  ✓ F9 按键已发送"

                    # Wait and verify
                    sleep 10

                    # Update last offline count
                    LAST_OFFLINE_COUNT=$VERIFY_COUNT
                    OFFLINE_DETECTED=true
                    log "✅ 已尝试重新启用服务器，请检查连接是否恢复"
                else
                    log "❌ xdotool 未安装，无法自动重连"
                    log "   请通过 VNC 手动按 F9 键"
                fi
            else
                log "ℹ️ False alarm，继续监控..."
            fi
        fi

        # Update last count periodically (every 10 checks) to prevent memory issues
        # In case log gets rotated, reset count if we detect a dramatic decrease
        NEW_OFFLINE_COUNT=$(grep -c "$OFFLINE_MARKER" "$SMAPI_LOG" 2>/dev/null || echo "0")
        if [ "$NEW_OFFLINE_COUNT" -lt "$LAST_OFFLINE_COUNT" ]; then
            log "ℹ️ 日志可能已轮转，重置计数器"
            LAST_OFFLINE_COUNT=$NEW_OFFLINE_COUNT
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
