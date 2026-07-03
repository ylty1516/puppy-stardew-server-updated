#!/bin/bash
# Auto-Handle Passout (2AM) - Background Script
# 自动处理凌晨2点晕倒 - 后台脚本
#
# When players stay up past 2 AM, they pass out and should automatically rest.
# Sometimes the host fails to trigger rest, causing the game to freeze.
# This script detects the passout event and confirms dialogs to proceed.
# 当玩家熬夜到凌晨2点，会晕倒并自动休息。
# 有时主机无法触发休息，导致游戏卡住。
# 此脚本检测晕倒事件并确认对话框以继续游戏。

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
CHECK_INTERVAL=5  # Check every 5 seconds
LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10

log() {
    echo -e "\033[0;33m[Auto-Handle-Passout]\033[0m $1"
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

log "启动凌晨2点晕倒自动处理服务..."
log "检查间隔: ${CHECK_INTERVAL}秒"

# Set DISPLAY environment variable
export DISPLAY=:99

# Wait for game initialization
log "等待游戏初始化..."
sleep 20

# Track last handled count to avoid duplicate handling (count-based deduplication)
# 使用计数器方式去重，避免同一事件重复触发
LAST_PASSOUT_COUNT=0

# Initialize baseline count after game starts
if [ -f "$SMAPI_LOG" ]; then
    LAST_PASSOUT_COUNT=$(grep -ciE "passed out|exhausted|collapsed" "$SMAPI_LOG" 2>/dev/null || echo "0")
    log "初始基线计数: $LAST_PASSOUT_COUNT"
fi

while true; do
    if [ -f "$SMAPI_LOG" ]; then
        # Count passout event occurrences in log (count-based approach prevents re-triggering)
        # 统计日志中晕倒事件的总次数（基于计数的方式防止重复触发）
        CURRENT_PASSOUT_COUNT=$(grep -ciE "passed out|exhausted|collapsed" "$SMAPI_LOG" 2>/dev/null || echo "0")

        # Only trigger if count increased (new event detected)
        # 仅当计数增加时触发（检测到新事件）
        if [ "$CURRENT_PASSOUT_COUNT" -gt "$LAST_PASSOUT_COUNT" ]; then
            log "⚠️ 检测到新的晕倒事件（计数: $LAST_PASSOUT_COUNT -> $CURRENT_PASSOUT_COUNT）"

            # Wait for event to fully trigger
            sleep 3

            if command -v xdotool >/dev/null 2>&1; then
                log "尝试确认晕倒对话框..."

                # Press Escape to close any menus first
                log "  步骤 1: 关闭可能的菜单..."
                send_key_locked Escape
                sleep 0.5

                # Press Enter multiple times to confirm all dialogs/settlement screens
                log "  步骤 2: 连续确认对话框..."
                for i in 1 2 3 4 5; do
                    send_key_locked Return
                    sleep 1
                done

                log "✅ 已尝试确认晕倒对话框"

                # Verify if new day started (optional validation)
                sleep 5
                if tail -20 "$SMAPI_LOG" 2>/dev/null | grep -qiE "Saving|woke up|Day [0-9]"; then
                    log "✅ 确认：新的一天已开始"
                fi
            else
                log "❌ xdotool 未安装，无法自动处理"
            fi

            # Update last handled count
            LAST_PASSOUT_COUNT=$CURRENT_PASSOUT_COUNT
        fi

        # Handle log rotation (count decreased means log was cleared/rotated)
        # 处理日志轮转（计数减少意味着日志被清空/轮转）
        if [ "$CURRENT_PASSOUT_COUNT" -lt "$LAST_PASSOUT_COUNT" ]; then
            log "ℹ️ 日志可能已轮转，重置计数器"
            LAST_PASSOUT_COUNT=$CURRENT_PASSOUT_COUNT
        fi
    fi

    sleep $CHECK_INTERVAL
done
