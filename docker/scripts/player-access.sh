#!/bin/bash
# Player Access Control - Whitelist/Blacklist management
# 玩家访问控制 - 白名单/黑名单管理
#
# Monitors SMAPI logs for player connections and kicks players
# based on whitelist or blacklist configuration.
#
# Config file location: /home/steam/.config/StardewValley/player-access.conf
#
# Modes:
#   whitelist - Only listed players can join
#   blacklist - Listed players are blocked (default: allow all)
#   disabled  - No access control (default)
#
# Config format:
#   MODE=whitelist|blacklist|disabled
#   # One player name per line after MODE
#   PlayerName1
#   PlayerName2

CONFIG_FILE="/home/steam/.config/StardewValley/player-access.conf"
SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
CHECK_INTERVAL=5

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()      { echo -e "${GREEN}[Access-Control]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[Access-Control]${NC} $1"; }
log_err()  { echo -e "${RED}[Access-Control]${NC} $1"; }

# Create default config if not exists
create_default_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        cat > "$CONFIG_FILE" << 'EOCONF'
# Player Access Control Configuration
# 玩家访问控制配置
#
# MODE options:
#   disabled  - No access control (allow all players)
#   whitelist - Only listed players can join
#   blacklist - Listed players are blocked
#
# Add one player name per line below the MODE setting.
# 在 MODE 设置下方每行添加一个玩家名称。
#
# Example (whitelist mode):
#   MODE=whitelist
#   Alice
#   Bob
#
# Example (blacklist mode):
#   MODE=blacklist
#   Griefer123
#   BadPlayer

MODE=disabled
EOCONF
        log "Created default config: $CONFIG_FILE"
    fi
}

# Read config and return mode + player list
load_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "disabled"
        return
    fi

    local mode=$(grep -m1 "^MODE=" "$CONFIG_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
    echo "${mode:-disabled}"
}

get_player_list() {
    if [ ! -f "$CONFIG_FILE" ]; then
        return
    fi

    # Return all non-empty, non-comment, non-MODE lines
    grep -v "^#" "$CONFIG_FILE" | grep -v "^MODE=" | grep -v "^$" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | while read -r line; do
        [ -n "$line" ] && echo "$line"
    done
}

# Check if player is in list
player_in_list() {
    local player_name="$1"
    local found=1

    while read -r listed_player; do
        if [ "$listed_player" = "$player_name" ]; then
            found=0
            break
        fi
    done < <(get_player_list)

    return $found
}

# Check if a player should be allowed
should_allow_player() {
    local player_name="$1"
    local mode=$(load_config)

    case "$mode" in
        disabled)
            return 0  # Allow all
            ;;
        whitelist)
            if player_in_list "$player_name"; then
                return 0  # Player is whitelisted
            else
                return 1  # Player not in whitelist
            fi
            ;;
        blacklist)
            if player_in_list "$player_name"; then
                return 1  # Player is blacklisted
            else
                return 0  # Player not in blacklist
            fi
            ;;
        *)
            return 0  # Unknown mode, allow
            ;;
    esac
}

# Monitor for new connections
monitor_connections() {
    local last_line_count=0

    while true; do
        if [ ! -f "$SMAPI_LOG" ]; then
            sleep $CHECK_INTERVAL
            continue
        fi

        local current_line_count=$(wc -l < "$SMAPI_LOG" 2>/dev/null || echo "0")

        if [ "$current_line_count" -gt "$last_line_count" ]; then
            # Check new lines for player connections
            local new_lines=$(tail -n +$((last_line_count + 1)) "$SMAPI_LOG" 2>/dev/null)

            # Look for player join patterns in SMAPI log
            echo "$new_lines" | grep -iE "farmhand connected|player connected|joined the game" | while read -r line; do
                # Try to extract player name from log line
                local player_name=$(echo "$line" | grep -oP "(?:farmhand|player)\s+(\S+)\s+connected" | awk '{print $2}')

                if [ -z "$player_name" ]; then
                    # Alternative pattern
                    player_name=$(echo "$line" | grep -oP "'([^']+)'\s+(?:connected|joined)" | sed "s/'//g" | awk '{print $1}')
                fi

                if [ -n "$player_name" ]; then
                    local mode=$(load_config)

                    if ! should_allow_player "$player_name"; then
                        log_err "BLOCKED player: $player_name (mode: $mode)"
                        log_err "被阻止的玩家: $player_name (模式: $mode)"
                        # Note: Stardew Valley doesn't have a native kick command
                        # The server admin would need to use SMAPI console commands
                        # or a kick mod. This log serves as an alert.
                        log_warn "Use SMAPI console to kick this player"
                        log_warn "使用 SMAPI 控制台踢出此玩家"
                    else
                        log "Player allowed: $player_name (mode: $mode)"
                    fi
                fi
            done

            last_line_count=$current_line_count
        fi

        sleep $CHECK_INTERVAL
    done
}

# Main
create_default_config

MODE=$(load_config)
log "Access control mode: $MODE"
log "访问控制模式: $MODE"

if [ "$MODE" = "disabled" ]; then
    log "Access control disabled, monitoring skipped"
    log "访问控制已禁用，跳过监控"
    exit 0
fi

PLAYER_COUNT=$(get_player_list | wc -l)
log "Player list: $PLAYER_COUNT entries"

log "Starting connection monitor..."
monitor_connections
