#!/bin/bash
# VNC诊断脚本
# VNC Diagnostic Script

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================"
echo "  VNC Diagnostic Tool"
echo "  VNC诊断工具"
echo "========================================"
echo ""

# 1. 检查容器是否运行
echo "[1/8] Checking container status..."
if ! docker ps | grep -q puppy-stardew; then
    echo -e "${RED}ERROR: Container not running${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Container is running${NC}"
echo ""

# 2. 检查VNC环境变量
echo "[2/8] Checking VNC environment variable..."
VNC_ENABLED=$(docker exec puppy-stardew env | grep ENABLE_VNC)
echo "ENABLE_VNC setting: $VNC_ENABLED"
if echo "$VNC_ENABLED" | grep -q "true"; then
    echo -e "${GREEN}✓ VNC is enabled${NC}"
else
    echo -e "${YELLOW}WARNING: VNC may not be enabled${NC}"
fi
echo ""

# 3. 检查Xvfb进程
echo "[3/8] Checking Xvfb (virtual display)..."
docker exec puppy-stardew ps aux | grep -i xvfb | grep -v grep
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Xvfb is running${NC}"
else
    echo -e "${RED}✗ Xvfb is NOT running${NC}"
fi
echo ""

# 4. 检查x11vnc进程
echo "[4/8] Checking x11vnc process..."
docker exec puppy-stardew ps aux | grep -i x11vnc | grep -v grep
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ x11vnc is running${NC}"
else
    echo -e "${RED}✗ x11vnc is NOT running${NC}"
    echo ""
    echo "Possible reasons:"
    echo "  1. VNC not enabled (set ENABLE_VNC=true in .env)"
    echo "  2. x11vnc failed to start"
    echo "  3. Xvfb not ready when x11vnc started"
fi
echo ""

# 5. 检查端口监听
echo "[5/8] Checking if port 5900 is listening in container..."
docker exec puppy-stardew netstat -tuln 2>/dev/null | grep 5900
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Port 5900 is listening${NC}"
else
    echo -e "${RED}✗ Port 5900 is NOT listening${NC}"
fi
echo ""

# 6. 检查主机端口映射
echo "[6/8] Checking host port mapping..."
docker port puppy-stardew 5900 2>/dev/null
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Port 5900 is mapped${NC}"
else
    echo -e "${RED}✗ Port 5900 is NOT mapped${NC}"
    echo "Run container with: -p 5900:5900/tcp"
fi
echo ""

# 7. 检查防火墙
echo "[7/8] Checking host firewall..."
if command -v ufw >/dev/null 2>&1; then
    ufw status | grep 5900
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Firewall rule exists${NC}"
    else
        echo -e "${YELLOW}WARNING: No firewall rule for port 5900${NC}"
        echo "Add with: sudo ufw allow 5900/tcp"
    fi
else
    echo "ufw not found, skipping firewall check"
fi
echo ""

# 8. 查看容器日志中的VNC相关信息
echo "[8/8] Checking container logs for VNC..."
docker logs puppy-stardew 2>&1 | grep -i vnc | tail -5
echo ""

echo "========================================"
echo "  Diagnostic Summary"
echo "========================================"
echo ""
echo "To manually start VNC in the container:"
echo "  docker exec puppy-stardew x11vnc -display :99 -forever -shared -rfbport 5900"
echo ""
echo "To test VNC connection from host:"
echo "  nc -zv localhost 5900"
echo ""
echo "To view full container logs:"
echo "  docker logs puppy-stardew"
