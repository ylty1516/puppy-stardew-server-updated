#!/bin/bash
# One-line installer for ylty's Stardew Valley co-op panel.

set -e

DIRECT_REPO_URL="https://github.com/ylty1516/puppy-stardew-server-updated.git"
DIRECT_RELEASE_ARCHIVE_URL="https://github.com/ylty1516/puppy-stardew-server-updated/releases/latest/download/puppy-stardew-server-updated.tar.gz"
DIRECT_RELEASE_ZIP_URL="https://github.com/ylty1516/puppy-stardew-server-updated/releases/latest/download/puppy-stardew-server-updated.zip"
DIRECT_SOURCE_ARCHIVE_URL="https://github.com/ylty1516/puppy-stardew-server-updated/archive/refs/heads/main.tar.gz"
GITHUB_PROXY_PREFIX="${PUPPY_GITHUB_PROXY_PREFIX:-https://gh.sixyin.com/}"
if [ "${PUPPY_USE_GITHUB_PROXY:-true}" = "false" ]; then
  GITHUB_PROXY_PREFIX=""
fi

proxy_url() {
  if [ -n "$GITHUB_PROXY_PREFIX" ]; then
    printf '%s%s\n' "${GITHUB_PROXY_PREFIX%/}/" "$1"
  else
    printf '%s\n' "$1"
  fi
}

REPO_URL="${PUPPY_REPO_URL:-$(proxy_url "$DIRECT_REPO_URL")}"
ARCHIVE_URL="${PUPPY_ARCHIVE_URL:-$(proxy_url "$DIRECT_RELEASE_ARCHIVE_URL")}"
RELEASE_ZIP_URL="${PUPPY_RELEASE_ZIP_URL:-$(proxy_url "$DIRECT_RELEASE_ZIP_URL")}"
SOURCE_ARCHIVE_URL="${PUPPY_SOURCE_ARCHIVE_URL:-$(proxy_url "$DIRECT_SOURCE_ARCHIVE_URL")}"
REPO_DIR="${PUPPY_STARDEW_DIR:-puppy-stardew-server-updated}"

info() {
  printf '%s\n' "$1"
}

die() {
  printf '安装失败: %s\n' "$1" >&2
  exit 1
}

run_quick_start() {
  chmod +x quick-start-zh.sh 2>/dev/null || true
  bash quick-start-zh.sh
}

download_archive() {
  url="$1"

  TMP_ARCHIVE="$(mktemp)" || return 1
  TMP_DIR=""
  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 15 --retry 2 --retry-delay 2 "$url" -o "$TMP_ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=30 --tries=2 "$url" -O "$TMP_ARCHIVE"
  else
    rm -f "$TMP_ARCHIVE"
    return 1
  fi

  if [ $? -ne 0 ]; then
    rm -f "$TMP_ARCHIVE"
    return 1
  fi

  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR" || {
    rm -f "$TMP_ARCHIVE"
    return 1
  }

  if command -v tar >/dev/null 2>&1 && tar -xzf "$TMP_ARCHIVE" --strip-components=1 -C "$REPO_DIR" 2>/dev/null; then
    rm -f "$TMP_ARCHIVE"
    return 0
  fi

  if command -v unzip >/dev/null 2>&1; then
    TMP_DIR="$(mktemp -d)" || {
      rm -rf "$REPO_DIR"
      rm -f "$TMP_ARCHIVE"
      return 1
    }
    if unzip -q "$TMP_ARCHIVE" -d "$TMP_DIR" 2>/dev/null; then
      root_count="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
      if [ "$root_count" = "1" ] && [ -d "$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)" ]; then
        root_dir="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
        cp -a "$root_dir/." "$REPO_DIR/"
      else
        cp -a "$TMP_DIR/." "$REPO_DIR/"
      fi
      rm -rf "$TMP_DIR"
      rm -f "$TMP_ARCHIVE"
      return 0
    fi
  fi

  rm -rf "$TMP_DIR"
  rm -rf "$REPO_DIR"
  rm -f "$TMP_ARCHIVE"
  return 1
}

clone_repo() {
  url="$1"
  command -v git >/dev/null 2>&1 || return 1
  git clone --depth 1 "$url" "$REPO_DIR"
}

if [ -f "docker-compose.yml" ] && [ -f ".env.example" ] && [ -f "quick-start-zh.sh" ]; then
  info "检测到当前目录已经是项目目录，直接启动中文安装向导。"
  run_quick_start
  exit 0
fi

if [ -d "$REPO_DIR" ]; then
  info "检测到已有目录 $REPO_DIR，进入该目录继续安装。"
  cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
  run_quick_start
  exit 0
fi

info "正在下载项目压缩包（比 git clone 更快）..."
if download_archive "$ARCHIVE_URL"; then
  cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
  run_quick_start
  exit 0
fi

if [ "$ARCHIVE_URL" != "$DIRECT_RELEASE_ARCHIVE_URL" ]; then
  info "Release 代理压缩包下载失败，尝试 GitHub Release 原地址..."
  if download_archive "$DIRECT_RELEASE_ARCHIVE_URL"; then
    cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
    run_quick_start
    exit 0
  fi
fi

info "Release tar.gz 不可用，尝试 Release zip 压缩包..."
if download_archive "$RELEASE_ZIP_URL"; then
  cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
  run_quick_start
  exit 0
fi

if [ "$RELEASE_ZIP_URL" != "$DIRECT_RELEASE_ZIP_URL" ]; then
  info "Release zip 代理压缩包下载失败，尝试 GitHub Release zip 原地址..."
  if download_archive "$DIRECT_RELEASE_ZIP_URL"; then
    cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
    run_quick_start
    exit 0
  fi
fi

info "Release 压缩包不可用，尝试 main 分支源码压缩包..."
if download_archive "$SOURCE_ARCHIVE_URL"; then
  cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
  run_quick_start
  exit 0
fi

if [ "$SOURCE_ARCHIVE_URL" != "$DIRECT_SOURCE_ARCHIVE_URL" ]; then
  info "源码代理压缩包下载失败，尝试 GitHub 源码原地址..."
  if download_archive "$DIRECT_SOURCE_ARCHIVE_URL"; then
    cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
    run_quick_start
    exit 0
  fi
fi

info "压缩包下载失败，尝试浅克隆仓库..."
if clone_repo "$REPO_URL" || { [ "$REPO_URL" != "$DIRECT_REPO_URL" ] && clone_repo "$DIRECT_REPO_URL"; }; then
  cd "$REPO_DIR" || die "无法进入目录 $REPO_DIR"
  run_quick_start
  exit 0
fi

die "下载项目失败，请检查网络，或设置 PUPPY_USE_GITHUB_PROXY=false 后重试"
