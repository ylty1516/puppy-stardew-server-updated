# Changelog

## 2026-07-04 Web 面板增强版

### New Features
- Web 面板新增“更新日志”页面，可直接查看项目 `CHANGELOG.md` 中的版本改动记录。
- `stardew-manager` 新增 changelog 读取接口，面板通过登录鉴权后的 `/api/changelog` 展示更新内容。
- Web 面板新增一键更新入口，可备份关键配置、拉取最新代码并重建 Docker 服务。
- 仪表盘新增“大型 Mod 初始化 / 重新隐藏房主”操作，用于 Ridgeside Village、Stardew Valley Expanded 等需要房主完成前置剧情的内容 Mod。
- 诊断页新增大型内容 Mod 剧情兼容检查，会读取已安装 Mod 的 `manifest.json`、提示缺失依赖、AutoHideHost 版本状态、房主隐藏状态和当前事件/菜单阻塞原因。

### Improvements
- 更新日志页面支持中英文界面、移动端自适应和长文本自动换行。
- 更新任务状态会显示阶段、备份目录、失败原因和日志尾部，方便服主判断是否更新成功。
- 默认联机人数上限统一为 8 人，并在面板状态、配置和启动偏好中保持一致。
- Mod 上传遇到同名文件时，面板会提示是否自动备份并覆盖旧 Mod，更新 Mod 版本不再需要先手动删除。
- AutoHideHost 默认关闭“自动跳过可跳过剧情”，避免隐藏房主时误跳过大型内容 Mod 的介绍、解锁或搬入事件。
- 大型 Mod 初始化按钮会等待 SMAPI 状态桥确认命令已生效，旧版 Mod、存档未加载或状态桥未刷新时会返回明确失败原因。

### Bug Fixes
- 修正在线人数与暂停状态展示，减少玩家下线后人数残留的问题。
- 加强自动暂停状态来源展示，能区分手动暂停、空服暂停、单人背包暂停和游戏内暂停。
- 修复 Web 一键更新卡在“排队中”的问题：updater 容器现在会覆盖默认入口执行脚本，排队超时会自动标记失败并显示 updater 日志尾部。

## v1.0.77 (March 2026)

### Bug Fixes
- Fixed `status.json` player count output so the web panel status file stays valid JSON when no players are connected.

## v1.0.76 (March 2026)

### New Features
- Added first-run password bootstrap for the web panel with persistent auth data storage.
- Added save archive upload, default save selection, and direct backup download from the web panel.
- Added a manager service so runtime config changes from the panel can trigger a real container rebuild/restart.

### Improvements
- Refined one-click setup output to match the new panel-first workflow and prefer IPv4 connection hints.
- Improved dashboard, logs, mod management, backup UX, and runtime status reporting in the web panel.
- Added default headless audio/OpenAL environment fallbacks to reduce noisy startup errors in clean Docker environments.

### Bug Fixes
- Fixed categorized log routing and fallback parsing when pre-split log files are missing.
- Fixed player counting and display for the current SMAPI connection log formats.
- Fixed config persistence paths, VNC exposure handling, and custom mod write/delete behavior.

## v1.0.66 (March 2026)

### New Features
- **Crash Auto-Restart**: Game automatically restarts on crash with rate limiting (max 5 restarts per 5 minutes). Enable via `ENABLE_CRASH_RESTART=true`
- **Prometheus Metrics**: Real-time server metrics exposed on port 9090 (`/metrics` endpoint). Tracks players online, uptime, CPU/memory, game events
- **Save Selector**: Auto-load specific saves via `SAVE_NAME` environment variable
- **Custom Mods Support**: Install your own mods by placing them in `data/custom-mods/` (supports directories and .zip files)
- **Player Access Control**: Whitelist/blacklist players via `player-access.conf` config file
- **Init Container**: Separate init container handles permission fixes before main server starts
- **Docker Secrets**: Support for `/run/secrets/` as secure alternative to plaintext `.env` credentials

### Improvements
- **Optimized Docker Image**: Consolidated layers, removed unused packages (tmux, expect, x11-apps), aggressive cleanup of docs/locale/man
- **Reduced Container Privileges**: Dropped NET_RAW, SYS_ADMIN, MKNOD capabilities
- **Simplified Root Phase**: Entrypoint Phase 1 only handles GPU Xorg + user switch; permission fixes delegated to init container

### Bug Fixes
- Fixed 7 scripts missing executable permissions (auto-enable-server.sh, etc.)
- Fixed netcat `-p` flag incompatible with netcat-openbsd on Ubuntu 22.04
- Fixed entrypoint.sh step numbering mismatch (Step 4 labeled as Step 5)
- Fixed VNC_PASSWORD default inconsistency between docker-compose.yml and .env.example
- Fixed Dockerfile COPY wildcard duplicating entrypoint.sh to scripts/ directory
- Removed redundant permission-fixing code from entrypoint.sh (now handled by init container)

### Configuration Changes
- New env vars: `ENABLE_CRASH_RESTART`, `MAX_CRASH_RESTARTS`, `SAVE_NAME`, `METRICS_PORT`
- New port: `9090/tcp` (Prometheus metrics)
- New volume: `data/custom-mods` (read-only mount)
- New docker-compose service: `stardew-init` (init container)
- Unified VNC_PASSWORD default to `stardew1` across all files

---

# v1.0.21 Release Notes

## 主要改进

### 自动权限修复
- 容器以 root 启动，自动修复挂载卷权限
- 无需手动运行 init.sh 或 chown 命令
- 自动切换到 steam 用户运行游戏

### 提升可靠性
- 修复游戏存在时的容器重启循环问题
- 改进错误处理和日志输出

## 升级说明

从 v1.0.20 升级到 v1.0.21：
```bash
docker-compose down
docker-compose pull
docker-compose up -d
```

无需其他操作！
