#!/bin/bash
# Auto-Enable Always On Server - Background Script
# 自动启用 Always On Server 的后台脚本
# 使用 xdotool 模拟 F9 键盘按键

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
MAX_WAIT=120  # 最多等待 120 秒
CHECK_INTERVAL=2  # 每 2 秒检查一次
LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10

log() {
    echo -e "\033[0;36m[Auto-Enable-Server]\033[0m $1"
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

log "启动 Always On Server 自动启用服务..."

# 等待游戏窗口启动
log "等待游戏初始化..."
sleep 10

log "等待存档加载完成..."

elapsed=0
while [ $elapsed -lt $MAX_WAIT ]; do
    # 检查 SMAPI 日志文件是否存在
    if [ -f "$SMAPI_LOG" ]; then
        # 检查存档是否加载成功
        if grep -q "SAVE LOADED SUCCESSFULLY\|Context: loaded save" "$SMAPI_LOG" 2>/dev/null; then
            log "✓ 检测到存档已加载"

            # 额外等待 5 秒，确保所有模组初始化完成
            log "等待模组初始化..."
            sleep 5

            # ===== 关键修复：先检测状态，再决定是否按键 =====
            # 检查 Always On Server 是否已经启用
            log "检查 Always On Server 当前状态..."

            # 统计 "Auto Mode On" 和 "Auto mode off" 的出现次数
            ON_COUNT=$(grep -o "Auto [Mm]ode [Oo]n" "$SMAPI_LOG" 2>/dev/null | wc -l)
            OFF_COUNT=$(grep -o "Auto mode off" "$SMAPI_LOG" 2>/dev/null | wc -l)

            log "  检测到 'Auto Mode On' 次数: $ON_COUNT"
            log "  检测到 'Auto mode off' 次数: $OFF_COUNT"

            # 如果 ON 次数大于 OFF 次数，说明当前是启用状态
            if [ "$ON_COUNT" -gt "$OFF_COUNT" ]; then
                log "✅ Always On Server 已经处于启用状态（ON=$ON_COUNT, OFF=$OFF_COUNT）"
                log "✅ 自动暂停功能已激活（无玩家时暂停，有玩家时继续）"
                log "   无需按 F9 键"
                exit 0
            elif [ "$ON_COUNT" -eq "$OFF_COUNT" ] && [ "$ON_COUNT" -gt 0 ]; then
                log "⚠️ Always On Server 可能被关闭（ON=$ON_COUNT, OFF=$OFF_COUNT）"
                log "   尝试按 F9 重新启用..."
            else
                log "ℹ️ Always On Server 状态未知（ON=$ON_COUNT, OFF=$OFF_COUNT）"
                log "   尝试按 F9 启用..."
            fi

            # 设置 DISPLAY 环境变量
            export DISPLAY=:99

            # 使用 xdotool 模拟按键（改进：先关闭菜单，再按F9，增加重试）
            if command -v xdotool >/dev/null 2>&1; then
                log "准备启用 Always On Server..."

                # 重试最多3次
                for attempt in 1 2 3; do
                    log "  尝试 #$attempt: 关闭可能的菜单并按 F9..."

                    # 先按多次ESC关闭所有菜单
                    for i in 1 2 3; do
                        send_key_locked Escape
                        sleep 0.3
                    done

                    # 等待菜单关闭
                    sleep 1

                    # 按F9启用Always On Server
                    send_key_locked F9
                    log "  ✓ F9 按键已发送（尝试 #$attempt）"

                    # 等待游戏响应
                    sleep 5

                    # 检查状态
                    ON_COUNT_AFTER=$(grep -o "Auto [Mm]ode [Oo]n" "$SMAPI_LOG" 2>/dev/null | wc -l)
                    OFF_COUNT_AFTER=$(grep -o "Auto mode off" "$SMAPI_LOG" 2>/dev/null | wc -l)

                    log "  状态检查: ON=$ON_COUNT_AFTER, OFF=$OFF_COUNT_AFTER"

                    if [ "$ON_COUNT_AFTER" -gt "$OFF_COUNT_AFTER" ]; then
                        log "✅ Always On Server 已成功启用！"
                        log "✅ 自动暂停功能已激活（无玩家时暂停，有玩家时继续）"
                        exit 0
                    fi

                    # 如果不是最后一次尝试，等待后重试
                    if [ "$attempt" -lt 3 ]; then
                        log "  未检测到启用，10秒后重试..."
                        sleep 10
                    fi
                done

                log "⚠️ 3次尝试后仍未检测到 Auto Mode On 消息"
                log "   可能原因："
                log "   1. Always On Server 已通过其他方式启用"
                log "   2. 游戏菜单仍在阻止按键响应"
                log "   3. xdotool 在虚拟显示环境下无法正常工作"
                log "   建议通过 VNC 手动按 F9 键启用"
                exit 0  # 不返回错误，避免容器重启
            else
                log "❌ xdotool 未安装"
                exit 1
            fi
        fi
    fi

    sleep $CHECK_INTERVAL
    elapsed=$((elapsed + CHECK_INTERVAL))
done

log "⚠ 等待超时（${MAX_WAIT}秒），存档未加载"
log "Always On Server 可能未自动启用"
exit 1
