#!/bin/bash
# 清理测试环境
# Cleanup test environment

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Cleaning up test containers and data...${NC}"

# 停止并删除测试容器
docker stop test-steam-guard 2>/dev/null || true
docker rm test-steam-guard 2>/dev/null || true

# 清理测试数据目录
rm -rf /tmp/steam-guard-test-* 2>/dev/null || true

# 清理dangling镜像
docker image prune -f >/dev/null 2>&1

echo -e "${GREEN}✓ Cleanup complete${NC}"
