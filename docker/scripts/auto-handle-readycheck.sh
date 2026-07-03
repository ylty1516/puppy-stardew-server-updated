#!/bin/bash
# Auto-Handle ReadyCheckDialog - Background Script
# 自动处理ReadyCheckDialog（地震等特殊事件的确认对话框）
#
# 注意：ShippingMenu、LevelUpMenu等由AutoHideHost模组自动处理，
#       这个脚本只处理ReadyCheckDialog（AutoHideHost无法处理的特殊事件）

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
CHECK_INTERVAL=3  # 每 3 秒检查一次
LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10

log() {
    echo -e "\033[0;35m[Auto-Handle-ReadyCheck]\033[0m $1"
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

log "启动 ReadyCheckDialog 自动处理服务..."
log "只监控 ReadyCheckDialog（特殊事件确认，如地震）"
log "其他菜单（ShippingMenu、LevelUpMenu等）由AutoHideHost模组处理"

# 设置 DISPLAY 环境变量
export DISPLAY=:99

# 上次处理的时间戳，避免重复处理
LAST_HANDLE_TIME=0

while true; do
    if [ -f "$SMAPI_LOG" ]; then
        CURRENT_TIME=$(date +%s)

        # 距离上次处理必须超过10秒，避免重复
        if [ $((CURRENT_TIME - LAST_HANDLE_TIME)) -lt 10 ]; then
            sleep $CHECK_INTERVAL
            continue
        fi

        # 获取最近的日志内容（只看最近30行，避免误检测旧消息）
        RECENT_LOG=$(tail -30 "$SMAPI_LOG" 2>/dev/null)

        # 只检测ReadyCheckDialog
        if echo "$RECENT_LOG" | grep -q "ReadyCheckDialog"; then
            log "⚠️ 检测到 ReadyCheckDialog（特殊事件确认对话框）"

            # 等待对话框完全显示
            sleep 2

            # 使用 xdotool 模拟按 Enter 键确认
            if command -v xdotool >/dev/null 2>&1; then
                log "模拟按 Enter 键自动确认..."

                # 连续按 3 次 Enter 确保确认成功
                send_key_locked Return
                sleep 0.5
                send_key_locked Return
                sleep 0.5
                send_key_locked Return

                log "✅ 已发送确认按键"

                # 记录处理时间
                LAST_HANDLE_TIME=$(date +%s)

                # 等待较长时间再检查，避免重复处理同一个对话框
                sleep 10
            else
                log "❌ xdotool 未安装，无法自动确认"
            fi
        fi
    fi

    sleep $CHECK_INTERVAL
done
