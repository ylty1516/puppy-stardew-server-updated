#!/bin/bash
# Puppy Stardew Server Log Monitor
# Watches SMAPI logs, writes categorized logs, and extracts likely root causes.

set -e

SMAPI_LOG="${SMAPI_LOG:-/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt}"
OUTPUT_DIR="${LOG_MONITOR_OUTPUT_DIR:-/home/steam/.local/share/puppy-stardew/logs/categorized}"
ERROR_LOG="$OUTPUT_DIR/errors.log"
MOD_LOG="$OUTPUT_DIR/mods.log"
SERVER_LOG="$OUTPUT_DIR/server.log"
GAME_LOG="$OUTPUT_DIR/game.log"
DIAGNOSTIC_LOG="$OUTPUT_DIR/diagnostics.log"
STATE_FILE="$OUTPUT_DIR/.last_line"

CHECK_INTERVAL="${LOG_MONITOR_INTERVAL:-5}"
BATCH_SIZE="${LOG_MONITOR_BATCH_SIZE:-500}"

mkdir -p "$OUTPUT_DIR"
touch "$ERROR_LOG" "$MOD_LOG" "$SERVER_LOG" "$GAME_LOG" "$DIAGNOSTIC_LOG"

LAST_LINE=0
if [ -f "$STATE_FILE" ]; then
    LAST_LINE=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
fi

case "$LAST_LINE" in
    ''|*[!0-9]*) LAST_LINE=0 ;;
esac

classify_issue() {
    local line="$1"

    if echo "$line" | grep -qiE "Steam Guard|two[- ]factor|set_steam_guard_code|AccountLogonDenied|steam guard code"; then
        echo "STEAM_GUARD_REQUIRED"; return 0
    fi
    if echo "$line" | grep -qiE "Login Failure|Invalid Password|incorrect password|No subscription|license|must own|not own"; then
        echo "STEAM_LOGIN_FAILED"; return 0
    fi
    if echo "$line" | grep -qiE "Game download failed|app_update.*fail|content servers unavailable|Update state.*failed"; then
        echo "STEAM_DOWNLOAD_FAILED"; return 0
    fi
    if echo "$line" | grep -qiE "No space left|ENOSPC|Disk write failure|insufficient disk|not enough space"; then
        echo "DISK_SPACE"; return 0
    fi
    if echo "$line" | grep -qiE "Permission denied|EACCES|EPERM|wrong-owner|wrong owner|chown|access denied"; then
        echo "PERMISSION_DENIED"; return 0
    fi
    if echo "$line" | grep -qiE "Save directory not found|No valid Stardew Valley save|SaveGameInfo|SAVE_NAME.*not found|save.*not found|failed.*load.*save"; then
        echo "SAVE_LOAD_FAILED"; return 0
    fi
    if echo "$line" | grep -qiE "Mod crashed|failed loading mod|failed to load.*mod|Harmony|manifest.json|Exception.*(mod|SMAPI|Harmony)"; then
        echo "MOD_EXCEPTION"; return 0
    fi
    if echo "$line" | grep -qiE "Unhandled exception|Fatal error|Segmentation fault|Aborted|core dumped|process exited unexpectedly|crash"; then
        echo "GAME_CRASH"; return 0
    fi
    if echo "$line" | grep -qiE "ServerOfflineMode|Auto mode off|server offline"; then
        echo "SERVER_OFFLINE_MODE"; return 0
    fi
    if echo "$line" | grep -qiE "xdotool.*(not installed|failed)|unable to get key lock|cannot get key lock|F9.*not|ReadyCheckDialog|key lock"; then
        echo "AUTOMATION_INPUT_FAILED"; return 0
    fi
    if echo "$line" | grep -qiE "x11vnc|VNC_PASSWORD is empty|Port .*5900.*not listening|Failed to start x11vnc"; then
        echo "VNC_FAILED"; return 0
    fi
    if echo "$line" | grep -qiE "Backup failed|tar.*failed|gzip.*failed|Cannot stat|file changed as we read it"; then
        echo "BACKUP_FAILED"; return 0
    fi

    return 1
}

process_log_line() {
    local line="$1"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    [ -n "$line" ] || return 0

    if echo "$line" | grep -qE "ERROR|FATAL|Exception"; then
        printf '[%s] %s\n' "$timestamp" "$line" >> "$ERROR_LOG"
    fi

    if echo "$line" | grep -qE "\[[0-9]{2}:[0-9]{2}:[0-9]{2}[[:space:]]+(TRACE|DEBUG|INFO|WARN|ERROR)[[:space:]]+(Server Auto Load|Skill Level Guard|AutoHideHost|Always On Server|Save Backup)\]"; then
        printf '[%s] %s\n' "$timestamp" "$line" >> "$MOD_LOG"
    fi

    if echo "$line" | grep -qEi "Starting LAN server|Starting server\. Protocol|ServerOfflineMode|Multiplayer|Connection|joined the game|left the game|farmhand|player connected|player disconnected|peer .* joined|peer .* left|client .* connected|client .* disconnected"; then
        printf '[%s] %s\n' "$timestamp" "$line" >> "$SERVER_LOG"
    fi

    if echo "$line" | grep -qE "\[[0-9]{2}:[0-9]{2}:[0-9]{2}[[:space:]]+(TRACE|DEBUG|INFO|WARN|ERROR)[[:space:]]+game\]"; then
        printf '[%s] %s\n' "$timestamp" "$line" >> "$GAME_LOG"
    fi

    local issue_code
    issue_code=$(classify_issue "$line" || true)
    if [ -n "$issue_code" ]; then
        printf '[%s] [%s] %s\n' "$timestamp" "$issue_code" "$line" >> "$DIAGNOSTIC_LOG"
    fi
}

monitor_logs() {
    while true; do
        if [ -f "$SMAPI_LOG" ]; then
            local total_lines
            total_lines=$(wc -l < "$SMAPI_LOG" 2>/dev/null | tr -d ' ' || echo "0")
            case "$total_lines" in
                ''|*[!0-9]*) total_lines=0 ;;
            esac

            if [ "$total_lines" -lt "$LAST_LINE" ]; then
                echo "[Log-Monitor] Log was truncated or rotated; resetting cursor"
                LAST_LINE=0
            fi

            local remaining=$((total_lines - LAST_LINE))
            while [ "$remaining" -gt 0 ]; do
                local batch="$remaining"
                if [ "$batch" -gt "$BATCH_SIZE" ]; then
                    batch="$BATCH_SIZE"
                fi

                tail -n +"$((LAST_LINE + 1))" "$SMAPI_LOG" | head -n "$batch" | while IFS= read -r line; do
                    process_log_line "$line"
                done

                LAST_LINE=$((LAST_LINE + batch))
                echo "$LAST_LINE" > "$STATE_FILE"
                remaining=$((total_lines - LAST_LINE))
            done
        fi

        sleep "$CHECK_INTERVAL"
    done
}

trap 'echo "[Log-Monitor] Stopped"; exit 0' SIGTERM SIGINT

echo "[Log-Monitor] Starting log monitoring..."
echo "[Log-Monitor] Source: $SMAPI_LOG"
echo "[Log-Monitor] Output directory: $OUTPUT_DIR"
echo "[Log-Monitor] Interval: ${CHECK_INTERVAL}s, batch size: $BATCH_SIZE"

monitor_logs
