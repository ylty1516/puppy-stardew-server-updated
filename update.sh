#!/usr/bin/env bash
# One-click updater for ylty's Stardew Valley co-op panel.

set -Eeuo pipefail

DIRECT_REPO_URL="https://github.com/ylty1516/puppy-stardew-server-updated.git"
DIRECT_SOURCE_ARCHIVE_URL="https://github.com/ylty1516/puppy-stardew-server-updated/archive/refs/heads/main.tar.gz"
GITHUB_PROXY_PREFIX="${PUPPY_GITHUB_PROXY_PREFIX:-https://gh.sixyin.com/}"
REPO_DIR="${PUPPY_STARDEW_DIR:-puppy-stardew-server-updated}"
BRANCH="${PUPPY_UPDATE_BRANCH:-main}"
FORCE_LOCAL_OVERWRITE="${PUPPY_UPDATE_FORCE:-false}"
SKIP_SAVE_BACKUP="${PUPPY_UPDATE_SKIP_SAVE_BACKUP:-false}"
NO_BUILD="${PUPPY_UPDATE_NO_BUILD:-false}"

if [ "${PUPPY_USE_GITHUB_PROXY:-true}" = "false" ]; then
  GITHUB_PROXY_PREFIX=""
fi

if [ -z "${PUPPY_UPDATE_REEXEC:-}" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_COPY="$(mktemp)"
  cp "${BASH_SOURCE[0]}" "$SELF_COPY"
  chmod +x "$SELF_COPY"
  PUPPY_UPDATE_REEXEC=1 exec bash "$SELF_COPY" "$@"
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { printf '%b\n' "${GREEN}[更新]${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}[注意]${NC} $*"; }
error() { printf '%b\n' "${RED}[失败]${NC} $*" >&2; }
step() { printf '\n%b\n' "${BLUE}==> $*${NC}"; }
hint() { printf '%b\n' "${CYAN}$*${NC}"; }
die() { error "$*"; exit 1; }

PROJECT_DIR=""
COMPOSE_CMD=""
BACKUP_DIR=""

proxy_url() {
  if [ -n "$GITHUB_PROXY_PREFIX" ]; then
    printf '%s%s\n' "${GITHUB_PROXY_PREFIX%/}/" "$1"
  else
    printf '%s\n' "$1"
  fi
}

is_project_dir() {
  [ -d "$1" ] &&
    [ -f "$1/docker-compose.yml" ] &&
    [ -f "$1/.env.example" ] &&
    [ -d "$1/docker" ]
}

find_project_dir() {
  if [ -n "${PUPPY_PROJECT_DIR:-}" ] && is_project_dir "$PUPPY_PROJECT_DIR"; then
    PROJECT_DIR="$(cd "$PUPPY_PROJECT_DIR" && pwd)"
    return
  fi

  if is_project_dir "$PWD"; then
    PROJECT_DIR="$(pwd)"
    return
  fi

  for candidate in \
    "$PWD/$REPO_DIR" \
    "$HOME/$REPO_DIR" \
    "/opt/$REPO_DIR" \
    "/root/$REPO_DIR"; do
    if is_project_dir "$candidate"; then
      PROJECT_DIR="$(cd "$candidate" && pwd)"
      return
    fi
  done

  die "没有找到项目目录。请先 cd 到 puppy-stardew-server-updated 目录，或设置 PUPPY_PROJECT_DIR=/你的项目路径 后再运行。"
}

check_tools() {
  command -v docker >/dev/null 2>&1 || die "未安装 Docker。请先安装 Docker。"
  docker ps >/dev/null 2>&1 || die "Docker 没有运行，或当前用户没有 Docker 权限。"

  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    die "未安装 Docker Compose。Ubuntu 可执行：sudo apt-get update && sudo apt-get install -y docker-compose-plugin"
  fi

  command -v tar >/dev/null 2>&1 || die "未找到 tar，无法备份或解压更新包。"
}

download_file() {
  url="$1"
  dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 15 --retry 2 --retry-delay 2 "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=30 --tries=2 "$url" -O "$dest"
  else
    return 1
  fi
}

create_backup() {
  timestamp="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$PROJECT_DIR/data/backups/panel-update-$timestamp"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true

  for file in ".env" "docker-compose.yml" "docker/config/startup_preferences" "data/meta/world_fingerprint.json" "data/meta/mod_graph.json"; do
    if [ -f "$PROJECT_DIR/$file" ]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$file")"
      cp -a "$PROJECT_DIR/$file" "$BACKUP_DIR/$file"
    fi
  done

  if [ "$SKIP_SAVE_BACKUP" != "true" ] && [ -d "$PROJECT_DIR/data/saves" ]; then
    if tar --warning=no-file-changed \
      --exclude='data/saves/ErrorLogs' \
      --exclude='data/saves/ErrorLogs/*' \
      --exclude='data/saves/*/ErrorLogs' \
      --exclude='data/saves/*/ErrorLogs/*' \
      --exclude='data/saves/SMAPI-latest.txt' \
      --exclude='data/saves/*/SMAPI-latest.txt' \
      --exclude='data/saves/*/*/SMAPI-latest.txt' \
      -czf "$BACKUP_DIR/saves.tar.gz" -C "$PROJECT_DIR" data/saves 2>/dev/null; then
      info "已备份存档到 $BACKUP_DIR/saves.tar.gz"
      printf '%s\n' \
        "存档备份已排除运行时日志目录 data/saves/ErrorLogs，避免正在写入的 SMAPI-latest.txt 阻塞更新。" \
        > "$BACKUP_DIR/save-backup-notes.txt"
    else
      die "存档备份失败，为保证可恢复性，已停止更新。如确认跳过存档备份，设置 PUPPY_UPDATE_SKIP_SAVE_BACKUP=true"
    fi
  fi

  info "已备份关键配置到 $BACKUP_DIR"
}

update_with_git() {
  command -v git >/dev/null 2>&1 || return 1

  cd "$PROJECT_DIR"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  git remote get-url origin >/dev/null 2>&1 || return 1

  step "拉取 GitHub 最新代码"
  git fetch --depth 1 origin "$BRANCH"

  dirty_tracked="$(git status --porcelain --untracked-files=no)"
  if [ -n "$dirty_tracked" ]; then
    git diff > "$BACKUP_DIR/local-tracked-changes.patch" || true
    warn "检测到你改过程序文件，差异已备份到 $BACKUP_DIR/local-tracked-changes.patch"
    if [ "$FORCE_LOCAL_OVERWRITE" != "true" ]; then
      die "为避免覆盖你的手动改动，已停止更新。如确认要覆盖，执行：PUPPY_UPDATE_FORCE=true bash update.sh"
    fi
  fi

  git reset --hard "origin/$BRANCH"
}

update_with_archive() {
  step "下载最新版源码包"
  tmp_archive="$(mktemp)"
  tmp_dir="$(mktemp -d)"
  archive_url="$(proxy_url "$DIRECT_SOURCE_ARCHIVE_URL")"

  if ! download_file "$archive_url" "$tmp_archive"; then
    warn "代理下载失败，尝试 GitHub 原地址..."
    download_file "$DIRECT_SOURCE_ARCHIVE_URL" "$tmp_archive" || die "下载更新包失败，请检查网络。"
  fi

  tar -xzf "$tmp_archive" --strip-components=1 -C "$tmp_dir" || die "解压更新包失败。"

  step "覆盖程序文件并保留数据"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '/.git/' \
      --exclude '/.env' \
      --exclude '/data/' \
      --exclude '/backups/' \
      --exclude '/secrets/' \
      "$tmp_dir"/ "$PROJECT_DIR"/
  else
    warn "未安装 rsync，改用普通覆盖模式；旧的无用文件不会自动删除。"
    (cd "$tmp_dir" && tar -cf - \
      --exclude='.git' \
      --exclude='.env' \
      --exclude='data' \
      --exclude='backups' \
      --exclude='secrets' \
      .) | (cd "$PROJECT_DIR" && tar -xf -)
  fi

  rm -rf "$tmp_archive" "$tmp_dir"
}

ensure_runtime_files() {
  cd "$PROJECT_DIR"

  if [ ! -f ".env" ]; then
    cp .env.example .env
    warn "没有检测到 .env，已从 .env.example 创建。请确认 Steam 账号密码是否已填写。"
  fi

  if ! grep -q '^MAX_PLAYERS=' .env 2>/dev/null; then
    printf '\n# 联机人数上限，默认 8 人\nMAX_PLAYERS=8\n' >> .env
    info "已给 .env 补充 MAX_PLAYERS=8"
  fi

  chmod +x ./*.sh 2>/dev/null || true
  mkdir -p data/{saves,game,steam,logs,backups,custom-mods,panel,meta,secrets}

  game_uid="$(stat -c '%u' data/game 2>/dev/null || stat -f '%u' data/game 2>/dev/null || printf '')"
  if [ "$game_uid" != "1000" ]; then
    warn "data/game 当前所有者不是 UID 1000。若之后游戏下载报磁盘写入失败，请执行：sudo chown -R 1000:1000 data/"
  fi
}

rebuild_and_restart() {
  if [ "$NO_BUILD" = "true" ]; then
    warn "已按 PUPPY_UPDATE_NO_BUILD=true 跳过 Docker 重建。"
    return
  fi

  cd "$PROJECT_DIR"
  step "重建并启动服务"
  $COMPOSE_CMD up -d --build --remove-orphans || {
    error "Docker Compose 启动失败。"
    hint "查看日志：$COMPOSE_CMD logs --tail=120"
    exit 1
  }
}

verify_update() {
  step "检查运行状态"
  cd "$PROJECT_DIR"

  if docker ps --format '{{.Names}}' | grep -qx 'puppy-stardew'; then
    info "主服务器容器正在运行：puppy-stardew"
  else
    warn "主服务器容器暂未处于 running 状态，请查看：docker logs puppy-stardew"
  fi

  if docker ps --format '{{.Names}}' | grep -qx 'puppy-stardew-manager'; then
    info "面板管理容器正在运行：puppy-stardew-manager"
  else
    warn "面板管理容器暂未处于 running 状态，请查看：docker logs puppy-stardew-manager"
  fi

  public_ip=""
  if command -v hostname >/dev/null 2>&1; then
    public_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  printf '\n%s\n' "更新完成。"
  printf '%s\n' "面板地址：http://${public_ip:-你的服务器IP}:18642"
  printf '%s\n' "备份目录：$BACKUP_DIR"
  printf '%s\n' "实时日志：docker logs -f puppy-stardew"
}

main() {
  printf '%b\n' "${BLUE}========================================${NC}"
  printf '%b\n' "${BLUE}  ylty 星露谷联机面板 一键更新${NC}"
  printf '%b\n' "${BLUE}========================================${NC}"

  find_project_dir
  info "项目目录：$PROJECT_DIR"
  check_tools
  create_backup

  if [ -d "$PROJECT_DIR/.git" ] && update_with_git; then
    info "已通过 git 更新到 origin/$BRANCH"
  else
    update_with_archive
    info "已通过源码压缩包更新到 main 最新版"
  fi

  ensure_runtime_files
  rebuild_and_restart
  verify_update
}

main "$@"
