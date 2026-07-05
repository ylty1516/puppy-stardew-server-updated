const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = parseInt(process.env.MANAGER_PORT || '18700', 10);
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace';
const PROJECT_PARENT_DIR = path.dirname(PROJECT_DIR);
const COMPOSE_FILE = process.env.COMPOSE_FILE || `${PROJECT_DIR}/docker-compose.yml`;
const DEFAULT_ENV_FILE = `${PROJECT_DIR}/.env`;
const RUNTIME_ENV_FILE = `${PROJECT_DIR}/data/panel/runtime.env`;
const PANEL_DATA_DIR = `${PROJECT_DIR}/data/panel`;
const UPDATE_STATUS_FILE = `${PANEL_DATA_DIR}/update-status.json`;
const UPDATE_LOG_FILE = `${PANEL_DATA_DIR}/update.log`;
const UPDATE_RUNNER_FILE = `${PANEL_DATA_DIR}/update-runner.sh`;
const FACTORY_RESET_STATUS_FILE = `${PANEL_DATA_DIR}/factory-reset-status.json`;
const FACTORY_RESET_LOG_FILE = `${PANEL_DATA_DIR}/factory-reset.log`;
const FACTORY_RESET_RUNNER_FILE = `${PANEL_DATA_DIR}/factory-reset-runner.sh`;
const UNINSTALL_STATUS_FILE = `${PANEL_DATA_DIR}/uninstall-status.json`;
const UNINSTALL_LOG_FILE = `${PANEL_DATA_DIR}/uninstall.log`;
const UNINSTALL_RUNNER_FILE = `${PANEL_DATA_DIR}/uninstall-runner.sh`;
const CHANGELOG_FILE = `${PROJECT_DIR}/CHANGELOG.md`;
const UPDATE_CONTAINER = process.env.UPDATE_CONTAINER || 'puppy-stardew-panel-updater';
const FACTORY_RESET_CONTAINER = process.env.FACTORY_RESET_CONTAINER || 'puppy-stardew-factory-reset';
const UNINSTALL_CONTAINER = process.env.UNINSTALL_CONTAINER || 'puppy-stardew-uninstaller';
const UPDATE_IMAGE = process.env.UPDATE_IMAGE || 'puppy-stardew-manager:local';
const UPDATE_BRANCH = process.env.PUPPY_UPDATE_BRANCH || 'main';
const UPDATE_QUEUED_TIMEOUT_MS = parseInt(process.env.PUPPY_UPDATE_QUEUED_TIMEOUT_MS || '90000', 10);
const DIRECT_SOURCE_ARCHIVE_URL = 'https://github.com/ylty1516/puppy-stardew-server-updated/archive/refs/heads/main.tar.gz';
const GITHUB_PROXY_PREFIX = process.env.PUPPY_GITHUB_PROXY_PREFIX || 'https://gh.sixyin.com/';
const ALLOWED_SERVICES = new Set(['stardew-server']);
const SERVICE_CONTAINERS = {
  'stardew-server': 'puppy-stardew',
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function proxyUrl(url) {
  if (process.env.PUPPY_USE_GITHUB_PROXY === 'false' || !GITHUB_PROXY_PREFIX) {
    return url;
  }

  return `${GITHUB_PROXY_PREFIX.replace(/\/+$/, '')}/${url}`;
}

function ensurePanelDataDir() {
  fs.mkdirSync(PANEL_DATA_DIR, { recursive: true });
}

function readTextTail(filePath, maxBytes = 32000) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const start = Math.max(0, stat.size - bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return '';
  }
}

function parseChangelogMarkdown(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let title = 'Changelog';
  let current = null;
  let currentSection = null;

  function pushEntry() {
    if (current) {
      entries.push(current);
    }
  }

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    if (h1 && entries.length === 0 && !current) {
      title = h1[1].trim();
      continue;
    }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      pushEntry();
      current = {
        title: h2[1].trim(),
        body: [],
        sections: [],
      };
      currentSection = null;
      continue;
    }

    if (!current) {
      continue;
    }

    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      currentSection = {
        title: h3[1].trim(),
        items: [],
      };
      current.sections.push(currentSection);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      if (!currentSection) {
        currentSection = {
          title: '',
          items: [],
        };
        current.sections.push(currentSection);
      }
      currentSection.items.push(bullet[1].trim());
      continue;
    }

    const text = line.trim();
    if (text) {
      current.body.push(text);
    }
  }

  pushEntry();

  return {
    title,
    entries: entries.slice(0, 80),
  };
}

function readChangelog() {
  if (!fs.existsSync(CHANGELOG_FILE)) {
    return {
      success: false,
      title: 'Changelog',
      entries: [],
      updatedAt: '',
      file: CHANGELOG_FILE,
      message: 'CHANGELOG.md was not found in the project directory.',
    };
  }

  const content = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  const parsed = parseChangelogMarkdown(content);
  const stat = fs.statSync(CHANGELOG_FILE);
  return {
    success: true,
    title: parsed.title,
    entries: parsed.entries,
    updatedAt: stat.mtime ? stat.mtime.toISOString() : '',
    file: 'CHANGELOG.md',
  };
}

function getUpdaterContainerState() {
  const result = spawnSync('docker', [
    'inspect',
    '--format',
    '{{.State.Running}} {{.State.ExitCode}} {{.State.Status}}',
    UPDATE_CONTAINER,
  ], {
    encoding: 'utf8',
    timeout: 3000,
  });

  if (result.status !== 0) {
    return { exists: false, running: false, status: 'missing', exitCode: null };
  }

  const [running, exitCode, status] = result.stdout.trim().split(/\s+/);
  let logTail = '';
  try {
    const logs = spawnSync('docker', ['logs', '--tail', '80', UPDATE_CONTAINER], {
      encoding: 'utf8',
      timeout: 3000,
    });
    logTail = [logs.stdout, logs.stderr].filter(Boolean).join('\n').trim();
  } catch (error) {}

  return {
    exists: true,
    running: running === 'true',
    status: status || 'unknown',
    exitCode: Number.isFinite(parseInt(exitCode, 10)) ? parseInt(exitCode, 10) : null,
    logTail,
  };
}

function getContainerState(containerName) {
  const result = spawnSync('docker', [
    'inspect',
    '--format',
    '{{.State.Running}} {{.State.ExitCode}} {{.State.Status}}',
    containerName,
  ], {
    encoding: 'utf8',
    timeout: 3000,
  });

  if (result.status !== 0) {
    return { exists: false, running: false, status: 'missing', exitCode: null, logTail: '' };
  }

  const [running, exitCode, status] = result.stdout.trim().split(/\s+/);
  let logTail = '';
  try {
    const logs = spawnSync('docker', ['logs', '--tail', '80', containerName], {
      encoding: 'utf8',
      timeout: 3000,
    });
    logTail = [logs.stdout, logs.stderr].filter(Boolean).join('\n').trim();
  } catch (error) {}

  return {
    exists: true,
    running: running === 'true',
    status: status || 'unknown',
    exitCode: Number.isFinite(parseInt(exitCode, 10)) ? parseInt(exitCode, 10) : null,
    logTail,
  };
}

function readUpdateStatus() {
  let status = {
    state: 'idle',
    phase: 'idle',
    message: 'No update has been started yet.',
    startedAt: '',
    updatedAt: '',
    completedAt: '',
    backupDir: '',
    logFile: UPDATE_LOG_FILE,
    exitCode: 0,
  };

  try {
    if (fs.existsSync(UPDATE_STATUS_FILE)) {
      status = {
        ...status,
        ...JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')),
      };
    }
  } catch (error) {
    status = {
      ...status,
      state: 'unknown',
      phase: 'status_read_failed',
      message: error.message || 'Failed to read update status.',
    };
  }

  const container = getUpdaterContainerState();
  if (status.state === 'running' && (!container.exists || !container.running)) {
    status = {
      ...status,
      state: 'failed',
      message: container.exists
        ? 'The updater container exited before reporting success.'
        : 'The updater container is missing while the update status is still running.',
      exitCode: container.exitCode || 1,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  if (status.state === 'running' && status.phase === 'queued') {
    const lastUpdateMs = Date.parse(status.updatedAt || status.startedAt || '');
    const queuedTimeoutMs = Number.isFinite(UPDATE_QUEUED_TIMEOUT_MS) && UPDATE_QUEUED_TIMEOUT_MS > 0
      ? UPDATE_QUEUED_TIMEOUT_MS
      : 90000;
    if (Number.isFinite(lastUpdateMs) && Date.now() - lastUpdateMs > queuedTimeoutMs) {
      status = {
        ...status,
        state: 'failed',
        phase: 'queued_timeout',
        message: 'Updater 容器启动后没有进入执行阶段，已判定为失败。请查看日志里的准确原因。',
        exitCode: container.exitCode || 124,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  const updateLogTail = readTextTail(UPDATE_LOG_FILE) || (status.state === 'failed' ? (container.logTail || '') : '');
  return {
    ...status,
    running: status.state === 'running',
    manager: {
      projectDir: PROJECT_DIR,
      composeFile: COMPOSE_FILE,
      updateContainer: UPDATE_CONTAINER,
      updateImage: UPDATE_IMAGE,
      container,
    },
    logTail: updateLogTail,
  };
}

function writeUpdateStatus(status) {
  ensurePanelDataDir();
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({
    logFile: UPDATE_LOG_FILE,
    ...status,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function readFactoryResetStatus() {
  let status = {
    state: 'idle',
    phase: 'idle',
    message: 'No factory reset has been started yet.',
    startedAt: '',
    updatedAt: '',
    completedAt: '',
    backupDir: '',
    logFile: FACTORY_RESET_LOG_FILE,
    exitCode: 0,
  };

  try {
    if (fs.existsSync(FACTORY_RESET_STATUS_FILE)) {
      status = {
        ...status,
        ...JSON.parse(fs.readFileSync(FACTORY_RESET_STATUS_FILE, 'utf8')),
      };
    }
  } catch (error) {
    status = {
      ...status,
      state: 'unknown',
      phase: 'status_read_failed',
      message: error.message || 'Failed to read factory reset status.',
    };
  }

  const container = getContainerState(FACTORY_RESET_CONTAINER);
  if (status.state === 'running' && (!container.exists || !container.running)) {
    status = {
      ...status,
      state: 'failed',
      message: container.exists
        ? 'The factory reset runner exited before reporting success.'
        : 'The factory reset runner is missing while the status is still running.',
      exitCode: container.exitCode || 1,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  return {
    ...status,
    running: status.state === 'running',
    manager: {
      projectDir: PROJECT_DIR,
      composeFile: COMPOSE_FILE,
      resetContainer: FACTORY_RESET_CONTAINER,
      updateImage: UPDATE_IMAGE,
      container,
    },
    logTail: readTextTail(FACTORY_RESET_LOG_FILE) || (status.state === 'failed' ? (container.logTail || '') : ''),
  };
}

function writeFactoryResetStatus(status) {
  ensurePanelDataDir();
  fs.writeFileSync(FACTORY_RESET_STATUS_FILE, JSON.stringify({
    logFile: FACTORY_RESET_LOG_FILE,
    ...status,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function readUninstallStatus() {
  let status = {
    state: 'idle',
    phase: 'idle',
    message: 'No uninstall task has been started yet.',
    startedAt: '',
    updatedAt: '',
    completedAt: '',
    logFile: UNINSTALL_LOG_FILE,
    exitCode: 0,
  };

  try {
    if (fs.existsSync(UNINSTALL_STATUS_FILE)) {
      status = {
        ...status,
        ...JSON.parse(fs.readFileSync(UNINSTALL_STATUS_FILE, 'utf8')),
      };
    }
  } catch (error) {
    status = {
      ...status,
      state: 'unknown',
      phase: 'status_read_failed',
      message: error.message || 'Failed to read uninstall status.',
    };
  }

  const container = getContainerState(UNINSTALL_CONTAINER);
  if (status.state === 'running' && (!container.exists || !container.running)) {
    status = {
      ...status,
      state: 'failed',
      message: container.exists
        ? 'The uninstall runner exited before reporting success.'
        : 'The uninstall runner is missing while the status is still running.',
      exitCode: container.exitCode || 1,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  return {
    ...status,
    running: status.state === 'running',
    manager: {
      projectDir: PROJECT_DIR,
      composeFile: COMPOSE_FILE,
      uninstallContainer: UNINSTALL_CONTAINER,
      updateImage: UPDATE_IMAGE,
      container,
    },
    logTail: readTextTail(UNINSTALL_LOG_FILE) || (status.state === 'failed' ? (container.logTail || '') : ''),
  };
}

function writeUninstallStatus(status) {
  ensurePanelDataDir();
  fs.writeFileSync(UNINSTALL_STATUS_FILE, JSON.stringify({
    logFile: UNINSTALL_LOG_FILE,
    ...status,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function buildUpdaterScript(options = {}) {
  const force = options.force === true ? 'true' : 'false';
  const skipSaveBackup = options.skipSaveBackup === true ? 'true' : 'false';
  const noBuild = options.noBuild === true ? 'true' : 'false';
  const proxiedArchiveUrl = proxyUrl(DIRECT_SOURCE_ARCHIVE_URL);

  return `#!/bin/sh
set -eu

PROJECT_DIR=${shellQuote(PROJECT_DIR)}
COMPOSE_FILE=${shellQuote(COMPOSE_FILE)}
STATUS_FILE=${shellQuote(UPDATE_STATUS_FILE)}
LOG_FILE=${shellQuote(UPDATE_LOG_FILE)}
BRANCH=${shellQuote(UPDATE_BRANCH)}
DIRECT_SOURCE_ARCHIVE_URL=${shellQuote(DIRECT_SOURCE_ARCHIVE_URL)}
PROXIED_SOURCE_ARCHIVE_URL=${shellQuote(proxiedArchiveUrl)}
FORCE_LOCAL_OVERWRITE=${shellQuote(force)}
SKIP_SAVE_BACKUP=${shellQuote(skipSaveBackup)}
NO_BUILD=${shellQuote(noBuild)}
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BACKUP_DIR="$PROJECT_DIR/data/backups/panel-update-$(date '+%Y%m%d-%H%M%S')"
LAST_PHASE="starting"

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

write_status() {
  state="$1"
  phase="$2"
  message="$3"
  exit_code="$4"
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  completed=""
  if [ "$state" != "running" ]; then
    completed="$now"
  fi
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat > "$STATUS_FILE" <<JSON
{
  "state": "$state",
  "phase": "$phase",
  "message": "$(json_escape "$message")",
  "startedAt": "$STARTED_AT",
  "updatedAt": "$now",
  "completedAt": "$completed",
  "backupDir": "$(json_escape "$BACKUP_DIR")",
  "logFile": "$(json_escape "$LOG_FILE")",
  "exitCode": $exit_code
}
JSON
}

set_phase() {
  LAST_PHASE="$1"
  write_status "running" "$1" "$2" 0
  printf '\\n[%s] %s\\n' "$(date '+%F %T')" "$2"
}

on_exit() {
  code="$?"
  if [ "$code" -ne 0 ]; then
    write_status "failed" "$LAST_PHASE" "更新失败，请查看日志里的准确原因。" "$code"
  fi
}
trap on_exit EXIT

mkdir -p "$PROJECT_DIR/data/panel" "$PROJECT_DIR/data/backups"
: > "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

cd "$PROJECT_DIR"
export PWD="$PROJECT_DIR"
set_phase "backup" "备份关键配置和存档"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
for file in .env docker-compose.yml docker/config/startup_preferences data/meta/world_fingerprint.json data/meta/mod_graph.json; do
  if [ -f "$file" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$file")"
    cp -a "$file" "$BACKUP_DIR/$file"
  fi
done
if [ "$SKIP_SAVE_BACKUP" != "true" ] && [ -d data/saves ]; then
  if tar --warning=no-file-changed \
    --exclude='data/saves/ErrorLogs' \
    --exclude='data/saves/ErrorLogs/*' \
    --exclude='data/saves/*/ErrorLogs' \
    --exclude='data/saves/*/ErrorLogs/*' \
    --exclude='data/saves/SMAPI-latest.txt' \
    --exclude='data/saves/*/SMAPI-latest.txt' \
    --exclude='data/saves/*/*/SMAPI-latest.txt' \
    -czf "$BACKUP_DIR/saves.tar.gz" data/saves; then
    printf '%s\\n' "Save backup excluded runtime logs under data/saves/ErrorLogs so a live SMAPI-latest.txt cannot block updates." > "$BACKUP_DIR/save-backup-notes.txt"
  else
    echo "Save backup failed. Update is blocked to keep the server recoverable. Set PUPPY_UPDATE_SKIP_SAVE_BACKUP=true only if you intentionally accept this risk."
    exit 24
  fi
fi

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

set_phase "download" "拉取 GitHub 最新代码"
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  git config --global --add safe.directory "$PROJECT_DIR" 2>/dev/null || true
  git fetch --depth 1 origin "$BRANCH"
  dirty="$(git status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    git diff > "$BACKUP_DIR/local-tracked-changes.patch" || true
    if [ "$FORCE_LOCAL_OVERWRITE" != "true" ]; then
      echo "检测到服务器上有手动修改过的程序文件："
      printf '%s\\n' "$dirty"
      echo "差异已备份到 $BACKUP_DIR/local-tracked-changes.patch"
      echo "为避免覆盖你的手动改动，已停止更新。"
      exit 30
    fi
  fi
  git reset --hard "origin/$BRANCH"
else
  tmp_archive="$(mktemp)"
  tmp_dir="$(mktemp -d)"
  if ! download_file "$PROXIED_SOURCE_ARCHIVE_URL" "$tmp_archive"; then
    echo "代理压缩包下载失败，尝试 GitHub 原地址。"
    download_file "$DIRECT_SOURCE_ARCHIVE_URL" "$tmp_archive"
  fi
  tar -xzf "$tmp_archive" --strip-components=1 -C "$tmp_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \\
      --exclude '/.git/' \\
      --exclude '/.env' \\
      --exclude '/data/' \\
      --exclude '/backups/' \\
      --exclude '/secrets/' \\
      "$tmp_dir"/ "$PROJECT_DIR"/
  else
    (cd "$tmp_dir" && tar -cf - \\
      --exclude='.git' \\
      --exclude='.env' \\
      --exclude='data' \\
      --exclude='backups' \\
      --exclude='secrets' \\
      .) | (cd "$PROJECT_DIR" && tar -xf -)
  fi
  rm -rf "$tmp_archive" "$tmp_dir"
fi

set_phase "prepare" "补齐运行配置"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "未检测到 .env，已从 .env.example 创建。请检查 Steam 账号密码。"
fi
if ! grep -q '^MAX_PLAYERS=' .env 2>/dev/null; then
  printf '\\n# 联机人数上限，默认 8 人\\nMAX_PLAYERS=8\\n' >> .env
fi
chmod +x ./*.sh 2>/dev/null || true
mkdir -p data/saves data/game data/steam data/logs data/backups data/custom-mods data/panel data/meta data/secrets

set_phase "rebuild" "重建并重启 Docker 服务"
if [ "$NO_BUILD" != "true" ]; then
  docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" up -d --build --remove-orphans
else
  echo "已按配置跳过 Docker 重建。"
fi

write_status "succeeded" "complete" "更新完成，面板和服务已重建。" 0
trap - EXIT
`;
}

function buildFactoryResetScript() {
  return `#!/bin/sh
set -eu

PROJECT_DIR=${shellQuote(PROJECT_DIR)}
COMPOSE_FILE=${shellQuote(COMPOSE_FILE)}
STATUS_FILE=${shellQuote(FACTORY_RESET_STATUS_FILE)}
LOG_FILE=${shellQuote(FACTORY_RESET_LOG_FILE)}
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BACKUP_DIR="$PROJECT_DIR/data/backups/factory-reset-$(date '+%Y%m%d-%H%M%S')"
LAST_PHASE="starting"

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

write_status() {
  state="$1"
  phase="$2"
  message="$3"
  exit_code="$4"
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  completed=""
  if [ "$state" != "running" ]; then
    completed="$now"
  fi
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat > "$STATUS_FILE" <<JSON
{
  "state": "$state",
  "phase": "$phase",
  "message": "$(json_escape "$message")",
  "startedAt": "$STARTED_AT",
  "updatedAt": "$now",
  "completedAt": "$completed",
  "backupDir": "$(json_escape "$BACKUP_DIR")",
  "logFile": "$(json_escape "$LOG_FILE")",
  "exitCode": $exit_code
}
JSON
}

set_phase() {
  LAST_PHASE="$1"
  write_status "running" "$1" "$2" 0
  printf '\\n[%s] %s\\n' "$(date '+%F %T')" "$2"
}

on_exit() {
  code="$?"
  if [ "$code" -ne 0 ]; then
    write_status "failed" "$LAST_PHASE" "出厂化重置失败，请查看日志里的准确原因。" "$code"
  fi
}
trap on_exit EXIT

safe_clean_dir() {
  dir="$1"
  case "$dir" in
    "$PROJECT_DIR"/data/saves|"$PROJECT_DIR"/data/game|"$PROJECT_DIR"/data/custom-mods|"$PROJECT_DIR"/data/logs|"$PROJECT_DIR"/data/meta)
      mkdir -p "$dir"
      find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      ;;
    *)
      echo "Refusing to clean unexpected path: $dir"
      exit 44
      ;;
  esac
}

backup_path() {
  rel="$1"
  name="$2"
  if [ -e "$PROJECT_DIR/$rel" ]; then
    tar -czf "$BACKUP_DIR/$name.tar.gz" -C "$PROJECT_DIR" "$rel"
  fi
}

mkdir -p "$PROJECT_DIR/data/panel" "$PROJECT_DIR/data/backups"
: > "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

cd "$PROJECT_DIR"
export PWD="$PROJECT_DIR"

set_phase "backup" "备份存档、上传 Mod 和关键配置"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
backup_path "data/saves" "saves"
backup_path "data/custom-mods" "custom-mods"
backup_path "data/meta" "meta"
if [ -d "$PROJECT_DIR/data/game/Mods" ]; then
  tar -czf "$BACKUP_DIR/game-mods.tar.gz" -C "$PROJECT_DIR/data/game" "Mods"
fi
for file in .env docker-compose.yml data/panel/runtime.env data/panel/auth.json; do
  if [ -f "$file" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$file")"
    cp -a "$file" "$BACKUP_DIR/$file"
  fi
done
cat > "$BACKUP_DIR/factory-reset.json" <<JSON
{
  "createdAt": "$STARTED_AT",
  "projectDir": "$(json_escape "$PROJECT_DIR")",
  "preserved": ["project source", ".env", "data/panel/auth.json", "data/steam", "data/backups", "data/secrets"],
  "cleared": ["data/saves", "data/game", "data/custom-mods", "data/logs", "data/meta", "data/panel/client-packs", "runtime control files"]
}
JSON

set_phase "stop" "停止游戏容器"
docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" stop stardew-server || true
docker rm -f puppy-stardew puppy-stardew-init >/dev/null 2>&1 || true

set_phase "reset" "清理游戏运行数据"
mkdir -p data/saves data/game data/custom-mods data/logs data/backups data/panel data/meta data/steam
safe_clean_dir "$PROJECT_DIR/data/saves"
safe_clean_dir "$PROJECT_DIR/data/game"
safe_clean_dir "$PROJECT_DIR/data/custom-mods"
safe_clean_dir "$PROJECT_DIR/data/logs"
safe_clean_dir "$PROJECT_DIR/data/meta"
rm -rf "$PROJECT_DIR/data/panel/client-packs"
rm -f "$PROJECT_DIR/data/panel/game-state.json" \\
      "$PROJECT_DIR/data/panel/manual-pause.json" \\
      "$PROJECT_DIR/data/panel/auto-pause.json" \\
      "$PROJECT_DIR/data/panel/host-command.json" \\
      "$PROJECT_DIR/data/panel/status.json"
mkdir -p data/saves data/game data/custom-mods data/logs data/backups data/panel data/meta data/steam
chown -R 1000:1000 data/saves data/game data/custom-mods data/logs data/panel data/meta 2>/dev/null || true

set_phase "restart" "重新创建并启动服务器"
docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" up -d --build --force-recreate stardew-server

write_status "succeeded" "complete" "出厂化重置完成，服务器正在按首次启动流程重新初始化。" 0
trap - EXIT
`;
}

function buildUninstallScript() {
  return `#!/bin/sh
set -eu

PROJECT_DIR=${shellQuote(PROJECT_DIR)}
COMPOSE_FILE=${shellQuote(COMPOSE_FILE)}
STATUS_FILE=${shellQuote(UNINSTALL_STATUS_FILE)}
LOG_FILE=${shellQuote(UNINSTALL_LOG_FILE)}
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
LAST_PHASE="starting"

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

write_status() {
  state="$1"
  phase="$2"
  message="$3"
  exit_code="$4"
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  completed=""
  if [ "$state" != "running" ]; then
    completed="$now"
  fi
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat > "$STATUS_FILE" <<JSON
{
  "state": "$state",
  "phase": "$phase",
  "message": "$(json_escape "$message")",
  "startedAt": "$STARTED_AT",
  "updatedAt": "$now",
  "completedAt": "$completed",
  "logFile": "$(json_escape "$LOG_FILE")",
  "exitCode": $exit_code
}
JSON
}

set_phase() {
  LAST_PHASE="$1"
  write_status "running" "$1" "$2" 0
  printf '\\n[%s] %s\\n' "$(date '+%F %T')" "$2"
}

on_exit() {
  code="$?"
  if [ "$code" -ne 0 ]; then
    write_status "failed" "$LAST_PHASE" "卸载失败，项目目录未删除。请查看日志里的准确原因。" "$code"
  fi
}
trap on_exit EXIT

fail_safe() {
  echo "$1"
  exit 41
}

validate_project_dir() {
  [ -n "$PROJECT_DIR" ] || fail_safe "PROJECT_DIR is empty."
  [ "$PROJECT_DIR" != "/" ] || fail_safe "Refusing to uninstall root directory."
  case "$PROJECT_DIR" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      fail_safe "Refusing to uninstall broad system directory: $PROJECT_DIR"
      ;;
  esac
  [ -d "$PROJECT_DIR" ] || fail_safe "Project directory does not exist: $PROJECT_DIR"
  [ -f "$COMPOSE_FILE" ] || fail_safe "Compose file does not exist: $COMPOSE_FILE"
  [ -f "$PROJECT_DIR/docker-compose.yml" ] || fail_safe "Missing docker-compose.yml marker in project directory."
  [ -f "$PROJECT_DIR/docker/web-panel/server.js" ] || fail_safe "Missing web panel marker in project directory."
  [ -f "$PROJECT_DIR/docker/manager/server.js" ] || fail_safe "Missing manager marker in project directory."
  if ! grep -q 'puppy-stardew' "$PROJECT_DIR/docker-compose.yml"; then
    fail_safe "docker-compose.yml does not look like the Puppy Stardew project."
  fi
}

mkdir -p "$PROJECT_DIR/data/panel"
: > "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

set_phase "validate" "校验卸载范围"
validate_project_dir
cd "$PROJECT_DIR"
export PWD="$PROJECT_DIR"

set_phase "stop" "停止并移除本项目 Docker Compose 服务"
docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" down --remove-orphans || true

set_phase "remove_containers" "移除本项目固定容器"
for name in puppy-stardew puppy-stardew-init puppy-stardew-manager puppy-stardew-panel-updater puppy-stardew-factory-reset; do
  docker rm -f "$name" >/dev/null 2>&1 || true
done

set_phase "remove_images" "移除本项目本地镜像"
docker image rm -f puppy-stardew-server:local puppy-stardew-manager:local >/dev/null 2>&1 || true

set_phase "remove_project" "删除本项目目录"
cd /
rm -rf -- "$PROJECT_DIR"
if [ -e "$PROJECT_DIR" ]; then
  fail_safe "Project directory still exists after removal attempt: $PROJECT_DIR"
fi
trap - EXIT
`;
}

function startUpdate(options = {}) {
  const current = readUpdateStatus();
  if (current.running) {
    return {
      alreadyRunning: true,
      status: current,
    };
  }
  const resetStatus = readFactoryResetStatus();
  if (resetStatus.running) {
    throw new Error('Factory reset is already running. Wait for it to finish before updating.');
  }
  const uninstallStatus = readUninstallStatus();
  if (uninstallStatus.running) {
    throw new Error('Uninstall is already running. The project is being removed.');
  }

  ensurePanelDataDir();
  fs.writeFileSync(UPDATE_RUNNER_FILE, buildUpdaterScript(options), { mode: 0o700 });
  try {
    fs.chmodSync(UPDATE_RUNNER_FILE, 0o700);
  } catch (error) {}

  writeUpdateStatus({
    state: 'running',
    phase: 'queued',
    message: '更新任务已提交，正在启动 updater 容器。',
    startedAt: new Date().toISOString(),
    completedAt: '',
    backupDir: '',
    exitCode: 0,
  });

  spawnSync('docker', ['rm', '-f', UPDATE_CONTAINER], {
    encoding: 'utf8',
    timeout: 10000,
  });

  const run = spawnSync('docker', [
    'run',
    '-d',
    '--name',
    UPDATE_CONTAINER,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${PROJECT_DIR}:${PROJECT_DIR}:rw`,
    '-w',
    PROJECT_DIR,
    '--entrypoint',
    'sh',
    UPDATE_IMAGE,
    UPDATE_RUNNER_FILE,
  ], {
    encoding: 'utf8',
    timeout: 15000,
  });

  if (run.error || run.status !== 0) {
    writeUpdateStatus({
      state: 'failed',
      phase: 'start_container',
      message: '启动 updater 容器失败。',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      backupDir: '',
      exitCode: run.status || 1,
    });
    throw new Error([run.error && run.error.message, run.stderr, run.stdout].filter(Boolean).join('\n') || 'Failed to start updater container');
  }

  return {
    alreadyRunning: false,
    containerId: run.stdout.trim(),
    status: readUpdateStatus(),
  };
}

function startFactoryReset() {
  const current = readFactoryResetStatus();
  if (current.running) {
    return {
      alreadyRunning: true,
      status: current,
    };
  }
  const updateStatus = readUpdateStatus();
  if (updateStatus.running) {
    throw new Error('Panel update is already running. Wait for it to finish before resetting the game.');
  }
  const uninstallStatus = readUninstallStatus();
  if (uninstallStatus.running) {
    throw new Error('Uninstall is already running. The project is being removed.');
  }

  ensurePanelDataDir();
  fs.writeFileSync(FACTORY_RESET_RUNNER_FILE, buildFactoryResetScript(), { mode: 0o700 });
  try {
    fs.chmodSync(FACTORY_RESET_RUNNER_FILE, 0o700);
  } catch (error) {}

  writeFactoryResetStatus({
    state: 'running',
    phase: 'queued',
    message: '出厂化重置任务已提交，正在启动执行容器。',
    startedAt: new Date().toISOString(),
    completedAt: '',
    backupDir: '',
    exitCode: 0,
  });

  spawnSync('docker', ['rm', '-f', FACTORY_RESET_CONTAINER], {
    encoding: 'utf8',
    timeout: 10000,
  });

  const run = spawnSync('docker', [
    'run',
    '-d',
    '--name',
    FACTORY_RESET_CONTAINER,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${PROJECT_DIR}:${PROJECT_DIR}:rw`,
    '-w',
    PROJECT_DIR,
    '--entrypoint',
    'sh',
    UPDATE_IMAGE,
    FACTORY_RESET_RUNNER_FILE,
  ], {
    encoding: 'utf8',
    timeout: 15000,
  });

  if (run.error || run.status !== 0) {
    writeFactoryResetStatus({
      state: 'failed',
      phase: 'start_container',
      message: '启动出厂化重置执行容器失败。',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      backupDir: '',
      exitCode: run.status || 1,
    });
    throw new Error([run.error && run.error.message, run.stderr, run.stdout].filter(Boolean).join('\n') || 'Failed to start factory reset container');
  }

  return {
    alreadyRunning: false,
    containerId: run.stdout.trim(),
    status: readFactoryResetStatus(),
  };
}

function startUninstall() {
  const current = readUninstallStatus();
  if (current.running) {
    return {
      alreadyRunning: true,
      status: current,
    };
  }
  const updateStatus = readUpdateStatus();
  if (updateStatus.running) {
    throw new Error('Panel update is already running. Wait for it to finish before uninstalling.');
  }
  const resetStatus = readFactoryResetStatus();
  if (resetStatus.running) {
    throw new Error('Factory reset is already running. Wait for it to finish before uninstalling.');
  }

  ensurePanelDataDir();
  fs.writeFileSync(UNINSTALL_RUNNER_FILE, buildUninstallScript(), { mode: 0o700 });
  try {
    fs.chmodSync(UNINSTALL_RUNNER_FILE, 0o700);
  } catch (error) {}

  writeUninstallStatus({
    state: 'running',
    phase: 'queued',
    message: '卸载任务已提交，正在启动执行容器。',
    startedAt: new Date().toISOString(),
    completedAt: '',
    exitCode: 0,
  });

  spawnSync('docker', ['rm', '-f', UNINSTALL_CONTAINER], {
    encoding: 'utf8',
    timeout: 10000,
  });

  const uninstallMountDir = PROJECT_PARENT_DIR && PROJECT_PARENT_DIR !== '/' ? PROJECT_PARENT_DIR : PROJECT_DIR;
  const run = spawnSync('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    UNINSTALL_CONTAINER,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${uninstallMountDir}:${uninstallMountDir}:rw`,
    '-w',
    PROJECT_DIR,
    '--entrypoint',
    'sh',
    UPDATE_IMAGE,
    UNINSTALL_RUNNER_FILE,
  ], {
    encoding: 'utf8',
    timeout: 15000,
  });

  if (run.error || run.status !== 0) {
    writeUninstallStatus({
      state: 'failed',
      phase: 'start_container',
      message: '启动卸载执行容器失败。',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: run.status || 1,
    });
    throw new Error([run.error && run.error.message, run.stderr, run.stdout].filter(Boolean).join('\n') || 'Failed to start uninstall container');
  }

  return {
    alreadyRunning: false,
    containerId: run.stdout.trim(),
    status: readUninstallStatus(),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function recreateService(service) {
  const env = buildComposeEnv();
  const containerName = SERVICE_CONTAINERS[service];
  const command = [
    containerName ? `docker rm -f ${containerName} >/dev/null 2>&1 || true` : '',
    `docker compose -f ${COMPOSE_FILE} --project-directory ${PROJECT_DIR} up -d --no-deps ${service}`,
  ].filter(Boolean).join(' && ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const index = trimmed.indexOf('=');
      if (index === -1) {
        continue;
      }
      env[trimmed.slice(0, index).trim()] = parseEnvValue(trimmed.slice(index + 1));
    }
    return env;
  } catch (error) {
    return {};
  }
}

function parseEnvValue(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (raw === '') return '';

  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\'/g, "'");
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  return raw.replace(/\s+#.*$/, '').trim();
}

function buildComposeEnv() {
  return {
    ...process.env,
    ...parseEnvFile(DEFAULT_ENV_FILE),
    ...parseEnvFile(RUNTIME_ENV_FILE),
    PWD: PROJECT_DIR,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/recreate') {
    try {
      const body = await readJson(req);
      const service = body && body.service ? String(body.service) : 'stardew-server';

      if (!ALLOWED_SERVICES.has(service)) {
        sendJson(res, 400, { error: 'Unsupported service' });
        return;
      }

      recreateService(service);
      sendJson(res, 202, { success: true, service, action: 'recreate' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to schedule recreate' });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/update/status') {
    sendJson(res, 200, readUpdateStatus());
    return;
  }

  if (req.method === 'GET' && req.url === '/factory-reset/status') {
    sendJson(res, 200, readFactoryResetStatus());
    return;
  }

  if (req.method === 'GET' && req.url === '/uninstall/status') {
    sendJson(res, 200, readUninstallStatus());
    return;
  }

  if (req.method === 'GET' && req.url === '/changelog') {
    const changelog = readChangelog();
    sendJson(res, changelog.success ? 200 : 404, changelog);
    return;
  }

  if (req.method === 'POST' && req.url === '/update') {
    try {
      const body = await readJson(req);
      const result = startUpdate({
        force: body && body.force === true,
        skipSaveBackup: body && body.skipSaveBackup === true,
        noBuild: body && body.noBuild === true,
      });

      sendJson(res, result.alreadyRunning ? 200 : 202, {
        success: true,
        action: 'update',
        ...result,
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || 'Failed to start update',
        status: readUpdateStatus(),
      });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/factory-reset') {
    try {
      const body = await readJson(req);
      if (!body || body.confirmation !== 'RESET') {
        sendJson(res, 400, {
          error: 'Factory reset confirmation is required',
          code: 'FACTORY_RESET_CONFIRMATION_REQUIRED',
          cause: 'The request did not include confirmation: RESET.',
          action: 'Type RESET in the panel confirmation prompt before starting factory reset.',
        });
        return;
      }

      const result = startFactoryReset();
      sendJson(res, result.alreadyRunning ? 200 : 202, {
        success: true,
        action: 'factory-reset',
        ...result,
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || 'Failed to start factory reset',
        status: readFactoryResetStatus(),
      });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/uninstall') {
    try {
      const body = await readJson(req);
      if (!body || body.confirmation !== 'UNINSTALL') {
        sendJson(res, 400, {
          error: 'Uninstall confirmation is required',
          code: 'UNINSTALL_CONFIRMATION_REQUIRED',
          cause: 'The request did not include confirmation: UNINSTALL.',
          action: 'Type UNINSTALL in the panel confirmation prompt before uninstalling the project.',
        });
        return;
      }

      const result = startUninstall();
      sendJson(res, result.alreadyRunning ? 200 : 202, {
        success: true,
        action: 'uninstall',
        ...result,
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || 'Failed to start uninstall',
        status: readUninstallStatus(),
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Manager] Listening on http://0.0.0.0:${PORT}`);
});
