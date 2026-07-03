#!/bin/bash
# Set display resolution for Xorg using xrandr
# 使用 xrandr 设置 Xorg 显示分辨率
#
# Usage: set-resolution.sh [WIDTH] [HEIGHT] [REFRESH_RATE]
# 用法: set-resolution.sh [宽度] [高度] [刷新率]

TARGET_W=${1:-1280}
TARGET_H=${2:-720}
TARGET_R=${3:-60}
TARGET_MODE="${TARGET_W}x${TARGET_H}_${TARGET_R}.00"
SIMPLE_MODE="${TARGET_W}x${TARGET_H}"

echo "[Set-Resolution] 目标分辨率: ${SIMPLE_MODE} @ ${TARGET_R}Hz"

# Find the first connected output
# 找到第一个已连接的输出
OUTPUT=$(xrandr | awk '/ connected/ { print $1; exit }' 2>/dev/null || true)

if [ -n "$OUTPUT" ]; then
    echo "[Set-Resolution] 检测到输出: $OUTPUT，尝试设置分辨率为 ${SIMPLE_MODE} 或 ${TARGET_MODE}"

    # Try simple mode name first (e.g. 1280x720)
    # 优先直接尝试简单模式名
    if xrandr --output "$OUTPUT" --mode "$SIMPLE_MODE" >/dev/null 2>&1; then
        echo "[Set-Resolution] ✓ 已将 $OUTPUT 设置为 ${SIMPLE_MODE}"
    else
        # Try mode name with suffix (e.g. 1280x720_60.00)
        # 再尝试带后缀的模式名
        if xrandr --output "$OUTPUT" --mode "$TARGET_MODE" >/dev/null 2>&1; then
            echo "[Set-Resolution] ✓ 已将 $OUTPUT 设置为 ${TARGET_MODE}"
        else
            # Fallback: use cvt to create custom mode
            # 若都失败，尝试使用 cvt 新建 mode
            if command -v cvt >/dev/null 2>&1 && command -v xrandr >/dev/null 2>&1; then
                echo "[Set-Resolution] 尝试用 cvt 生成 modeline 并添加..."
                MODELINE=$(cvt ${TARGET_W} ${TARGET_H} ${TARGET_R} 2>/dev/null | sed -n '2p' | sed 's/Modeline //')
                if [ -n "$MODELINE" ]; then
                    MODE_NAME=$(echo "$MODELINE" | awk '{print $1}' | tr -d \")
                    # Create new mode and add to output
                    # 创建新模式并添加到输出
                    xrandr --newmode $MODELINE >/dev/null 2>&1 || true
                    xrandr --addmode "$OUTPUT" "$MODE_NAME" >/dev/null 2>&1 || true
                    # Apply the mode
                    # 应用模式
                    if xrandr --output "$OUTPUT" --mode "$MODE_NAME" >/dev/null 2>&1; then
                        echo "[Set-Resolution] ✓ 已通过 cvt 新建并应用模式 $MODE_NAME 到 $OUTPUT"
                    else
                        echo "[Set-Resolution] ✗ 无法应用新建模式 $MODE_NAME，保持当前分辨率"
                    fi
                else
                    echo "[Set-Resolution] ✗ cvt 未能生成 modeline"
                fi
            else
                echo "[Set-Resolution] ✗ cvt 或 xrandr 不可用，无法创建自定义模式，保持当前分辨率"
            fi
        fi
    fi
else
    echo "[Set-Resolution] ✗ 未检测到已连接输出，跳过分辨率设置"
fi
