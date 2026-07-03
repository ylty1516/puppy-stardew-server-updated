#!/bin/bash
# Save Selector - Select which save to load
# 存档选择器 - 选择要加载的存档

SAVE_DIR="/home/steam/.config/StardewValley/Saves"
SAVE_NAME="${SAVE_NAME:-}"

log() {
    echo -e "\033[0;32m[Save-Selector]\033[0m $1"
}

# If SAVE_NAME is set, create a marker file for ServerAutoLoad
if [ -n "$SAVE_NAME" ]; then
    log "存档名称已指定: $SAVE_NAME"

    # Check if save exists
    if [ -d "$SAVE_DIR/$SAVE_NAME" ]; then
        log "✓ 找到存档: $SAVE_NAME"

        # Create marker for ServerAutoLoad mod
        mkdir -p "$SAVE_DIR"
        echo "$SAVE_NAME" > "$SAVE_DIR/.selected_save"

        log "✓ 已设置自动加载: $SAVE_NAME"
    else
        log "⚠️ 存档不存在: $SAVE_NAME"
        log "   可用存档:"
        if [ -d "$SAVE_DIR" ]; then
            ls -1 "$SAVE_DIR" 2>/dev/null | grep -v "^\." | while read save; do
                log "     - $save"
            done
        fi
        log "   将使用默认存档加载逻辑"
    fi
else
    log "未指定存档名称，将使用默认存档加载逻辑"
fi
