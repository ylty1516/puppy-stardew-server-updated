#!/bin/bash
# Auto-Backup - Automatic Save File Backup
# 自动备份 - 自动存档文件备份
#
# Runs daily at the configured time, keeps configurable number of backups.
# 在配置的时间每天运行，保留可配置数量的备份。

SAVE_DIR="/home/steam/.config/StardewValley"
BACKUP_DIR="/home/steam/.local/share/puppy-stardew/backups"
MAX_BACKUPS=${MAX_BACKUPS:-7}          # Keep last 7 backups
BACKUP_HOUR=${BACKUP_HOUR:-4}          # Backup at 4 AM server time
BACKUP_COMPRESSION_LEVEL=${BACKUP_COMPRESSION_LEVEL:-1}  # gzip level 1-9
CHECK_INTERVAL=300                      # Check every 5 minutes

GREEN='\033[0;32m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[Auto-Backup]${NC} $1"
}

log "========================================"
log "  Auto-Backup Service Starting..."
log "  自动备份服务启动中..."
log "========================================"
log "  Backup directory / 备份目录: $BACKUP_DIR"
log "  Max backups / 最大备份数: $MAX_BACKUPS"
log "  Backup hour / 备份时间: ${BACKUP_HOUR}:00"
log "  Compression level / 压缩级别: $BACKUP_COMPRESSION_LEVEL"
log ""

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Track last backup date to avoid duplicate backups on same day
LAST_BACKUP_DATE=""

do_backup() {
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local backup_file="$BACKUP_DIR/saves-$timestamp.tar.gz"

    log "开始备份..."

    # Check if saves exist
    if [ ! -d "$SAVE_DIR/Saves" ] && [ ! -d "$SAVE_DIR" ]; then
        log "⚠️ 未找到存档文件，跳过备份"
        return 1
    fi

    # Count files
    local file_count
    file_count=$(find "$SAVE_DIR" -type f 2>/dev/null | wc -l)
    log "  存档文件数: $file_count"

    # Create compressed backup
    tar -I "gzip -${BACKUP_COMPRESSION_LEVEL}" -cf "$backup_file" -C "$(dirname "$SAVE_DIR")" "$(basename "$SAVE_DIR")" 2>/dev/null
    if [ $? -ne 0 ]; then
        log "❌ 备份失败"
        rm -f "$backup_file" 2>/dev/null
        return 1
    fi

    # Show backup size
    local size
    size=$(du -h "$backup_file" 2>/dev/null | cut -f1)
    log "✅ 备份完成: $backup_file ($size)"

    # Cleanup old backups (keep only MAX_BACKUPS)
    local backup_count
    backup_count=$(ls -1t "$BACKUP_DIR"/saves-*.tar.gz 2>/dev/null | wc -l)

    if [ "$backup_count" -gt "$MAX_BACKUPS" ]; then
        local to_delete=$((backup_count - MAX_BACKUPS))
        log "  清理旧备份 ($to_delete 个)..."
        ls -1t "$BACKUP_DIR"/saves-*.tar.gz | tail -n "$to_delete" | xargs rm -f
        log "  ✓ 旧备份已清理"
    fi

    log "  当前备份数: $(ls -1 "$BACKUP_DIR"/saves-*.tar.gz 2>/dev/null | wc -l) / $MAX_BACKUPS"

    LAST_BACKUP_DATE=$(date +%Y%m%d)
    return 0
}

# Wait for game to start
log "等待游戏初始化..."
sleep 60

# Do initial backup on startup
log "执行启动时备份..."
do_backup

# Main loop: check every 5 minutes if it's backup time
while true; do
    CURRENT_HOUR=$(date +%H)
    CURRENT_DATE=$(date +%Y%m%d)

    # Check if it's backup time and hasn't been backed up today
    if [ "$CURRENT_HOUR" = "$(printf '%02d' $BACKUP_HOUR)" ] && [ "$CURRENT_DATE" != "$LAST_BACKUP_DATE" ]; then
        log "⏰ 到达预定备份时间 (${BACKUP_HOUR}:00)"
        do_backup
    fi

    sleep $CHECK_INTERVAL
done
