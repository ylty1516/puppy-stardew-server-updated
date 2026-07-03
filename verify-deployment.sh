#!/bin/bash
# 部署验证脚本 - 检查所有功能是否正常
# Deployment verification script

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

check_pass() {
    echo -e "${GREEN}✓ PASS${NC} - $1"
    PASS=$((PASS + 1))
}

check_fail() {
    echo -e "${RED}✗ FAIL${NC} - $1"
    FAIL=$((FAIL + 1))
}

check_warn() {
    echo -e "${YELLOW}⚠ WARN${NC} - $1"
    WARN=$((WARN + 1))
}

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Puppy Stardew Server Verification${NC}"
echo -e "${BLUE}  部署验证检查${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 获取日志
LOG=$(docker logs puppy-stardew 2>&1)

echo -e "${CYAN}[1/10] Container Status${NC}"
if docker ps | grep -q puppy-stardew; then
    check_pass "Container is running"
else
    check_fail "Container is not running"
    exit 1
fi
echo ""

echo -e "${CYAN}[2/10] Game Download${NC}"
if echo "$LOG" | grep -q "Game downloaded successfully"; then
    check_pass "Game downloaded successfully"
elif echo "$LOG" | grep -q "Game files found"; then
    check_pass "Game files already present"
elif echo "$LOG" | grep -q "downloading"; then
    check_warn "Game is currently downloading (check logs)"
else
    check_fail "Game download status unclear"
fi
echo ""

echo -e "${CYAN}[3/10] SMAPI Installation${NC}"
if echo "$LOG" | grep -q "SMAPI installed successfully"; then
    check_pass "SMAPI installed"
elif echo "$LOG" | grep -q "SMAPI already installed"; then
    check_pass "SMAPI already installed"
else
    check_warn "SMAPI installation status unclear"
fi
echo ""

echo -e "${CYAN}[4/10] Mods Installation${NC}"
if echo "$LOG" | grep -q "Mods installed successfully"; then
    check_pass "Mods installed"
elif echo "$LOG" | grep -q "Mods already installed"; then
    check_pass "Mods already installed"
else
    check_warn "Mods installation status unclear"
fi
echo ""

echo -e "${CYAN}[5/10] Mod: Always On Server${NC}"
if echo "$LOG" | grep -q "AlwaysOnServer" || echo "$LOG" | grep -q "Always On Server"; then
    check_pass "Always On Server mod loaded"
else
    check_warn "Always On Server mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[6/10] Mod: AutoHideHost${NC}"
if echo "$LOG" | grep -q "AutoHideHost"; then
    check_pass "AutoHideHost mod loaded"
else
    check_warn "AutoHideHost mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[7/10] Mod: ServerAutoLoad${NC}"
if echo "$LOG" | grep -q "ServerAutoLoad"; then
    check_pass "ServerAutoLoad mod loaded"
else
    check_warn "ServerAutoLoad mod not mentioned in logs"
fi
echo ""

echo -e "${CYAN}[8/10] Virtual Display${NC}"
if echo "$LOG" | grep -q "Virtual display started"; then
    check_pass "Xvfb virtual display running"
else
    check_fail "Virtual display not started"
fi
echo ""

echo -e "${CYAN}[9/10] VNC Server${NC}"
if echo "$LOG" | grep -q "VNC server started"; then
    check_pass "VNC server running on port 5900"
elif echo "$LOG" | grep -q "VNC disabled"; then
    check_warn "VNC is disabled (ENABLE_VNC=false)"
else
    check_warn "VNC status unclear"
fi
echo ""

echo -e "${CYAN}[10/10] Game Server${NC}"
if echo "$LOG" | grep -q "Server is starting" || echo "$LOG" | grep -q "StardewModdingAPI"; then
    check_pass "Game server is starting/running"
else
    check_warn "Game server status unclear (may still be initializing)"
fi
echo ""

# 检查错误
echo -e "${CYAN}[Error Check] Searching for errors...${NC}"
if echo "$LOG" | grep -iq "error" | grep -v "ERROR (Rate Limit)" | head -5; then
    ERROR_LINES=$(echo "$LOG" | grep -i "error" | grep -v "Rate Limit" | tail -3)
    if [ -n "$ERROR_LINES" ]; then
        check_warn "Found error messages in logs (review recommended)"
        echo -e "${YELLOW}Recent errors:${NC}"
        echo "$ERROR_LINES"
    else
        check_pass "No critical errors found"
    fi
else
    check_pass "No errors found in logs"
fi
echo ""

# 端口检查
echo -e "${CYAN}[Port Check] Checking open ports...${NC}"
if netstat -tuln 2>/dev/null | grep -q ":24642"; then
    check_pass "Game port 24642/udp is listening"
else
    check_warn "Port 24642 not detected (netstat may not be available)"
fi

if netstat -tuln 2>/dev/null | grep -q ":5900"; then
    check_pass "VNC port 5900/tcp is listening"
else
    check_warn "Port 5900 not detected (VNC may be disabled)"
fi
echo ""

# 总结
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Summary / 总结${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ Deployment looks good!${NC}"
    echo -e "${GREEN}✓ 部署看起来正常！${NC}"
    echo ""
    echo -e "Next steps:"
    echo -e "  1. Connect via VNC: localhost:5900 or server-ip:5900"
    echo -e "  2. Click CO-OP → Start new co-op farm"
    echo -e "  3. Players can connect via invite code"
    exit 0
else
    echo -e "${RED}✗ Deployment has issues${NC}"
    echo -e "${RED}✗ 部署存在问题${NC}"
    echo ""
    echo -e "Review full logs with: docker logs puppy-stardew"
    exit 1
fi
