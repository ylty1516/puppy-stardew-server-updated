#!/bin/bash
# Puppy Stardew Server - Log Viewer
# Usage: docker exec -it puppy-stardew /home/steam/scripts/view-logs.sh [option]

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

CATEGORIZED_DIR="/home/steam/.local/share/puppy-stardew/logs/categorized"
ARCHIVE_DIR="/home/steam/.local/share/puppy-stardew/logs/archive"
SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"

show_file_tail() {
    local title="$1"
    local color="$2"
    local file="$3"
    local empty_message="$4"

    if [ -f "$file" ]; then
        echo -e "${color}=== ${title} ===${NC}"
        tail -50 "$file"
    else
        echo -e "${YELLOW}${empty_message}${NC}"
    fi
}

show_stats() {
    echo -e "${GREEN}=== Log Statistics ===${NC}"
    echo ""
    echo "Disk Usage:"
    if [ -d "$CATEGORIZED_DIR" ]; then
        echo "  Current logs: $(du -sh "$CATEGORIZED_DIR" 2>/dev/null | cut -f1 || echo '0K')"
    fi
    if [ -d "$ARCHIVE_DIR" ]; then
        echo "  Archives: $(du -sh "$ARCHIVE_DIR" 2>/dev/null | cut -f1 || echo '0K')"
    fi
    echo ""
    [ -f "$CATEGORIZED_DIR/errors.log" ] && echo "Error count: $(wc -l < "$CATEGORIZED_DIR/errors.log" 2>/dev/null || echo '0')"
    [ -f "$CATEGORIZED_DIR/mods.log" ] && echo "Mod entries: $(wc -l < "$CATEGORIZED_DIR/mods.log" 2>/dev/null || echo '0')"
    [ -f "$CATEGORIZED_DIR/diagnostics.log" ] && echo "Diagnostics: $(wc -l < "$CATEGORIZED_DIR/diagnostics.log" 2>/dev/null || echo '0')"
}

show_archives() {
    echo -e "${BLUE}=== Archived Logs ===${NC}"
    if [ -d "$ARCHIVE_DIR" ]; then
        ls -lh "$ARCHIVE_DIR"/*.gz 2>/dev/null | tail -20 || echo "No archived logs found."
    else
        echo "No archive directory found."
    fi
}

show_menu() {
    echo -e "${GREEN}=== Puppy Stardew Server Log Viewer ===${NC}"
    echo ""
    echo "1) View all errors"
    echo "2) View mod logs"
    echo "3) View server logs"
    echo "4) View game logs"
    echo "5) View diagnostics"
    echo "6) Show log statistics"
    echo "7) View archived logs"
    echo "8) Tail live game log"
    echo "0) Exit"
    echo ""
    read -p "Select option: " option

    case "$option" in
        1) show_file_tail "Error Logs" "$RED" "$CATEGORIZED_DIR/errors.log" "No error logs found." ;;
        2) show_file_tail "Mod Logs" "$BLUE" "$CATEGORIZED_DIR/mods.log" "No mod logs found." ;;
        3) show_file_tail "Server Logs" "$GREEN" "$CATEGORIZED_DIR/server.log" "No server logs found." ;;
        4) show_file_tail "Game Logs" "$BLUE" "$CATEGORIZED_DIR/game.log" "No game logs found." ;;
        5) show_file_tail "Diagnostics" "$YELLOW" "$CATEGORIZED_DIR/diagnostics.log" "No diagnostics found." ;;
        6) show_stats ;;
        7) show_archives ;;
        8)
            echo -e "${GREEN}=== Live Game Log ===${NC}"
            echo "Press Ctrl+C to stop"
            tail -f "$SMAPI_LOG" 2>/dev/null || echo "Log file not found"
            ;;
        0)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid option!${NC}"
            ;;
    esac

    echo ""
    read -p "Press ENTER to continue..."
    show_menu
}

if [ "$(whoami)" != "steam" ]; then
    echo -e "${YELLOW}Warning: this script is intended to run as the steam user.${NC}"
    echo "Use: docker exec -it puppy-stardew /home/steam/scripts/view-logs.sh"
fi

show_menu
