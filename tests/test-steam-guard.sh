#!/bin/bash
# Steam Guard 流程测试脚本
# Test script for Steam Guard authentication flow

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Steam Guard Flow Test${NC}"
echo -e "${BLUE}  Steam Guard 流程测试${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查环境变量
if [ -z "$STEAM_USERNAME" ] || [ -z "$STEAM_PASSWORD" ]; then
    echo -e "${RED}ERROR: STEAM_USERNAME or STEAM_PASSWORD not set${NC}"
    echo "Please set environment variables:"
    echo "  export STEAM_USERNAME=your_username"
    echo "  export STEAM_PASSWORD=your_password"
    exit 1
fi

echo -e "${GREEN}✓ Steam credentials found${NC}"
echo -e "  Username: $STEAM_USERNAME"
echo ""

# 清理旧的测试容器
echo -e "${YELLOW}[1/5] Cleaning up old test containers...${NC}"
docker stop test-steam-guard 2>/dev/null || true
docker rm test-steam-guard 2>/dev/null || true
echo -e "${GREEN}✓ Cleanup complete${NC}"
echo ""

# 创建测试数据目录
echo -e "${YELLOW}[2/5] Setting up test directories...${NC}"
TEST_DIR="/tmp/steam-guard-test-$(date +%s)"
mkdir -p "$TEST_DIR"/{saves,game,steam}
echo -e "${GREEN}✓ Test directory: $TEST_DIR${NC}"
echo ""

# 启动测试容器
echo -e "${YELLOW}[3/5] Starting test container...${NC}"
docker run -d \
  --name test-steam-guard \
  -it \
  -e STEAM_USERNAME="$STEAM_USERNAME" \
  -e STEAM_PASSWORD="$STEAM_PASSWORD" \
  -e ENABLE_VNC=false \
  -v "$TEST_DIR/saves:/home/steam/.config/StardewValley:rw" \
  -v "$TEST_DIR/game:/home/steam/stardewvalley:rw" \
  -v "$TEST_DIR/steam:/home/steam/Steam:rw" \
  truemanlive/puppy-stardew-server:latest

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Failed to start container${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Container started${NC}"
echo ""

# 等待初始化
echo -e "${YELLOW}[4/5] Waiting for Steam Guard prompt (30s)...${NC}"
sleep 30
echo ""

# 检查日志
echo -e "${YELLOW}[5/5] Checking logs for Steam Guard prompt...${NC}"
LOG=$(docker logs test-steam-guard 2>&1)

if echo "$LOG" | grep -q "STEAM GUARD CODE REQUIRED"; then
    echo -e "${GREEN}✓ Steam Guard prompt detected${NC}"
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  ACTION REQUIRED${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
    echo -e "Steam Guard authentication is required."
    echo -e ""
    echo -e "To continue:"
    echo -e "  1. Run: ${GREEN}docker attach test-steam-guard${NC}"
    echo -e "  2. Enter your Steam Guard code when prompted"
    echo -e "  3. Press ENTER"
    echo -e "  4. Detach: ${GREEN}Ctrl+P, Ctrl+Q${NC}"
    echo -e ""
    echo -e "Monitor logs: ${GREEN}docker logs -f test-steam-guard${NC}"
    echo ""

    # 等待用户输入
    read -p "Press ENTER after you've entered the Steam Guard code..."

    # 再次检查日志
    sleep 10
    LOG=$(docker logs test-steam-guard 2>&1)

    if echo "$LOG" | grep -q "Game downloaded successfully"; then
        echo -e "${GREEN}✓✓✓ TEST PASSED ✓✓✓${NC}"
        echo -e "${GREEN}Steam Guard flow works correctly!${NC}"
        echo ""
        echo "Cleaning up test container..."
        docker stop test-steam-guard
        docker rm test-steam-guard
        echo -e "${GREEN}✓ Test complete${NC}"
        exit 0
    else
        echo -e "${YELLOW}⚠ Game download status unclear${NC}"
        echo "Showing last 20 lines of log:"
        echo "$LOG" | tail -20
        echo ""
        echo "Test container left running for inspection"
        echo "Remove with: docker stop test-steam-guard && docker rm test-steam-guard"
        exit 1
    fi

elif echo "$LOG" | grep -q "Game downloaded successfully"; then
    echo -e "${GREEN}✓ Game downloaded without Steam Guard${NC}"
    echo -e "${GREEN}✓✓✓ TEST PASSED ✓✓✓${NC}"
    echo ""
    echo "Cleaning up..."
    docker stop test-steam-guard
    docker rm test-steam-guard
    exit 0

else
    echo -e "${RED}✗ Unexpected state${NC}"
    echo "Last 30 lines of log:"
    echo "$LOG" | tail -30
    echo ""
    echo "Test container left running for inspection"
    echo "Remove with: docker stop test-steam-guard && docker rm test-steam-guard"
    exit 1
fi
