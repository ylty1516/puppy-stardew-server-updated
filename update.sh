#!/bin/bash
# Puppy Stardew Server - One-Click Update Script
# 小狗星谷服务器 - 一键更新脚本
#
# Usage: ./update.sh [version]
# 用法：./update.sh [版本号]
#
# Examples:
#   ./update.sh          # Update to latest
#   ./update.sh v1.0.65  # Update to specific version

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

IMAGE="truemanlive/puppy-stardew-server"
CONTAINER="puppy-stardew"
VERSION="${1:-latest}"

log_info() { echo -e "${GREEN}[Update]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[Update]${NC} $1"; }
log_error() { echo -e "${RED}[Update]${NC} $1"; }
log_step() { echo -e "${BLUE}$1${NC}"; }

log_step "========================================"
log_step "  Puppy Stardew Server Updater"
log_step "  小狗星谷服务器更新工具"
log_step "========================================"
echo ""

# Step 1: Check current version
log_info "Step 1: Checking current version..."
log_info "步骤 1: 检查当前版本..."

CURRENT_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER" 2>/dev/null)
if [ -n "$CURRENT_IMAGE" ]; then
    log_info "  Current / 当前: $CURRENT_IMAGE"
else
    log_warn "  Container not found / 未找到容器"
fi
log_info "  Target / 目标: $IMAGE:$VERSION"
echo ""

# Step 2: Backup saves
log_info "Step 2: Backing up saves..."
log_info "步骤 2: 备份存档..."

BACKUP_DIR="backups"
mkdir -p "$BACKUP_DIR"

if [ -d "data/saves" ]; then
    BACKUP_FILE="$BACKUP_DIR/saves-pre-update-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$BACKUP_FILE" data/saves/ 2>/dev/null
    if [ $? -eq 0 ]; then
        log_info "  ✓ Backup saved to / 备份已保存到: $BACKUP_FILE"
    else
        log_warn "  ⚠ Backup failed, continuing anyway / 备份失败，继续更新"
    fi
else
    log_warn "  No saves directory found / 未找到存档目录"
fi
echo ""

# Step 3: Stop server
log_info "Step 3: Stopping server..."
log_info "步骤 3: 停止服务器..."

if docker ps -q -f name="$CONTAINER" | grep -q .; then
    docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop "$CONTAINER" 2>/dev/null
    log_info "  ✓ Server stopped / 服务器已停止"
else
    log_info "  ✓ Server not running / 服务器未运行"
fi
echo ""

# Step 4: Pull new image
log_info "Step 4: Pulling new image ($VERSION)..."
log_info "步骤 4: 拉取新镜像 ($VERSION)..."

docker pull "$IMAGE:$VERSION"
if [ $? -ne 0 ]; then
    log_error "  ✗ Failed to pull image / 拉取镜像失败"
    log_error "  Check your network connection / 请检查网络连接"
    exit 1
fi
log_info "  ✓ Image pulled successfully / 镜像拉取成功"
echo ""

# Step 5: Update docker-compose.yml if specific version
if [ "$VERSION" != "latest" ]; then
    log_info "Step 5: Updating docker-compose.yml..."
    log_info "步骤 5: 更新 docker-compose.yml..."

    if [ -f "docker-compose.yml" ]; then
        sed -i "s|image: ${IMAGE}:.*|image: ${IMAGE}:${VERSION}|" docker-compose.yml
        log_info "  ✓ Updated image tag to $VERSION"
    fi
else
    log_info "Step 5: Using latest tag, no compose file changes needed"
fi
echo ""

# Step 6: Start server
log_info "Step 6: Starting server..."
log_info "步骤 6: 启动服务器..."

docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null
if [ $? -ne 0 ]; then
    log_error "  ✗ Failed to start server / 启动服务器失败"
    exit 1
fi
log_info "  ✓ Server started / 服务器已启动"

# Verify init container completed
sleep 2
INIT_EXIT=$(docker inspect --format='{{.State.ExitCode}}' puppy-stardew-init 2>/dev/null)
if [ "$INIT_EXIT" != "0" ] && [ -n "$INIT_EXIT" ]; then
    log_warn "  ⚠ Init container exit code: $INIT_EXIT"
    log_warn "  Check: docker logs puppy-stardew-init"
fi
echo ""

# Step 7: Show new version
log_info "Step 7: Verifying update..."
log_info "步骤 7: 验证更新..."

sleep 3
NEW_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER" 2>/dev/null)
log_info "  Running / 运行中: $NEW_IMAGE"
INIT_STATUS=$(docker inspect --format='{{.State.Status}}' puppy-stardew-init 2>/dev/null)
log_info "  Init container / 初始化容器: $INIT_STATUS"
echo ""

# Cleanup old images
log_info "Cleaning up old images..."
log_info "清理旧镜像..."
docker image prune -f --filter "label=maintainer=truemanlive" 2>/dev/null
echo ""

log_step "========================================"
log_step "  ✅ Update complete! / 更新完成！"
log_step "========================================"
log_info ""
log_info "Check logs / 查看日志: docker logs -f $CONTAINER"
log_info "Backup location / 备份位置: $BACKUP_FILE"
log_info ""
