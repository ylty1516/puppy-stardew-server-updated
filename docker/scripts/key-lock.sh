#!/bin/bash
# Key Press Mutex Lock - Shared Library
# 按键互斥锁 - 共享库
#
# Prevents multiple scripts from sending keyboard inputs simultaneously
# 防止多个脚本同时发送键盘输入

LOCK_FILE="/tmp/stardew-key-lock"
LOCK_TIMEOUT=10  # Wait up to 10 seconds for lock

# Send a single key with mutex lock
# 使用互斥锁发送单个按键
send_key() {
    local key="$1"
    local script_name="${2:-unknown}"

    (
        if flock -w "$LOCK_TIMEOUT" 200; then
            xdotool key "$key" 2>/dev/null
            return $?
        else
            echo "[key-lock] ⚠️ $script_name: Failed to acquire lock for key '$key'" >&2
            return 1
        fi
    ) 200>"$LOCK_FILE"
}

# Send multiple keys with mutex lock
# 使用互斥锁发送多个按键
send_keys() {
    local script_name="${1:-unknown}"
    shift
    local keys=("$@")

    (
        if flock -w "$LOCK_TIMEOUT" 200; then
            for key in "${keys[@]}"; do
                xdotool key "$key" 2>/dev/null
                sleep 0.1
            done
            return 0
        else
            echo "[key-lock] ⚠️ $script_name: Failed to acquire lock for keys" >&2
            return 1
        fi
    ) 200>"$LOCK_FILE"
}

# Export functions for use in other scripts
export -f send_key
export -f send_keys
