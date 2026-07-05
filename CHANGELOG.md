# Changelog

## 2026-07-05 安装脚本与 Docker Hub 超时诊断修复
### Bug Fixes
- 修复一键安装脚本写入 `.env` 时使用 `sed` 导致的特殊字符密码失败问题；Steam 密码里包含 `/`、`\`、`&` 等字符时不再出现 `sed: unterminated 's' command`，失败时也不会误报“配置已保存”。
- 修复 `.env` 裸写值可能被 Docker Compose 误解析的问题；安装脚本和 Web 面板现在会使用 Compose 安全的单引号格式写入 `.env`，并在读取时正确反解。
- 一键安装输入的 Steam 账号密码会优先保存到 `data/secrets/steam.json`，`.env` 只保存 `STEAM_JSON_SECRET` 引用路径，避免 `$`、`#`、空格、引号等密码字符影响 Compose 解析。
- 修复 Docker 构建失败后提示不准确的问题：当服务器访问 `registry-1.docker.io` 超时，会明确提示这是 Docker Hub 基础镜像拉取失败，并给出正确的项目目录和重试命令。

### Improvements
- `docker:27-cli` 和 `ubuntu:22.04` 基础镜像现在支持通过 `.env` 的 `MANAGER_BASE_IMAGE` / `SERVER_BASE_IMAGE` 覆盖，方便服务器主使用服务商提供的 Docker Hub 镜像源。
- 安装失败时会提醒先 `cd` 到项目目录再执行 `docker compose logs --tail=120`，避免在 `~` 目录运行后出现 `no configuration file provided` 的误导报错。

## 2026-07-05 原生 Co-op Host 自动加载修复
### Bug Fixes
- 重写并替换 `ServerAutoLoad` 为 v2.0.0：启动时不再普通读档后强行补 `multiplayerMode=2`，而是直接打开星露谷原生 `Co-op -> Host` 菜单并激活目标存档槽位，确保 `Game1.server`、可用 farmhand 列表和联机席位按游戏原流程初始化。
- 修复玩家明明有空闲小屋却提示“服务器上没有空闲位置”的核心原因：旧自动加载绕过 Co-op Host 流程，导致客户端连接后停在 `Sending available farmhands` 阶段。
### Improvements
- 新增 `server-autoload-state.json`，记录自动加载阶段、目标存档、当前菜单、是否已打开 Host 页和是否已激活存档槽位。
- 面板状态和诊断页新增加入握手/原生 Co-op 自动加载检查，能区分“可加入门禁 ready”和“客户端是否真的推进到选择 farmhand/批准加入”。
- 崩溃报告会打包 `server-autoload-state.json`，方便排查启动后联机席位初始化失败的问题。

## 2026-07-05 一键卸载项目
### New Features
- Web 面板 `配置` 页面新增 `卸载项目` 危险操作，会要求输入 `UNINSTALL` 确认后才会执行。
- 新增 `uninstall.sh`，面板不可用时也能在 SSH 中一键卸载本项目。

### Improvements
- 卸载任务会通过 `stardew-manager` 启动独立执行器，状态面板会显示阶段、失败原因、建议动作和日志尾部。
- 卸载范围增加项目标记校验，只允许删除带有本项目 `docker-compose.yml`、Web 面板和 manager 标记文件的目录。

### Safety
- 卸载只停止并移除本项目 Docker Compose 服务、固定容器、本地项目镜像和项目目录；不会卸载 Docker，不会执行 `docker system prune`，也不会处理服务器其他项目。

## 2026-07-05 面板可用性与安全修复增强
### New Features
- 诊断页新增 `一键安全修复` 按钮，会自动创建缺失目录、尝试修复可写权限、重建玩家 Mod 下载包并刷新公共 Mod 清单。
- 修复结果会在诊断页直接显示每一步状态，区分已修复、正常、跳过和失败，避免用户只看到一个无信息按钮。
- 配置页新增顶部固定保存条，改配置后顶部和底部的 `保存更改` 都会启用，减少长页面找不到保存按钮的问题。

### Improvements
- 模组页新增大量 Mod 一次性导入提示，说明多个 Mod 文件夹如何打包成一个 zip 组合包。
- 面板右上角 GitHub 图标已改为跳转到 `ylty1516/puppy-stardew-server-updated`。

## 2026-07-05 Mod 组合包导入与更新备份修复
### New Features
- Web 面板 `模组` 页面支持一键上传多个 Mod 组合包：服务器会临时解压 zip，扫描多个 `manifest.json`，并一次安装到游戏 `Mods` 目录。
- 组合包上传会返回安装数量和安装文件夹列表，玩家 Mod 下载包会在上传后自动重建。
- 配置页新增 `PANEL_MOD_EXTRACT_TIMEOUT_MS`，服务器慢或组合包较大时可调高解压等待时间。

### Improvements
- Mod 上传会先扫描压缩包再写入正式目录，遇到已存在的 Mod 文件夹会列出冲突项，确认后才备份并覆盖。
- 新上传且无冲突的 Mod 不再复制整套 Mod 目录做快照，降低 2 核 2G 服务器上传时的 CPU、磁盘和内存压力。
- 根目录直接包含 `manifest.json` 的 zip 会用压缩包文件名作为安装文件夹名，不再误用临时目录名。

### Bug Fixes
- Web 一键更新和手动备份会排除运行时 `data/saves/ErrorLogs`，避免正在写入的 `SMAPI-latest.txt` 让备份失败并导致更新卡住或中断。
- 上传组合包时会阻止覆盖内置服务端 Mod，避免误把面板自带控制 Mod 替换掉。

## 2026-07-05 服务器配置推荐
### New Features
- Web 面板 `配置` 页面新增 `服务器配置推荐` 卡片，可检测容器可用 CPU、内存、磁盘空间和已安装 Mod 压力。
- 新增 `/api/recommendations/server` 接口，按极低配置、2核2G、2核2G 大型Mod压力、4核4G、高配置等档位生成推荐。
- 推荐卡片支持一键应用到配置表单和复制 `.env` 推荐项，仍需管理员点击保存并重启容器后生效，避免自动误改服务器。

### Improvements
- 配置页新增面板性能相关变量，可直接调整状态缓存、日志读取尾部、历史记录长度、玩家 Mod 清单缓存和诊断命令超时。
- 推荐逻辑默认使用 `PANEL_WORLD_HASH_MODE=manifest`，并在检测到大型内容 Mod 或低内存服务器时主动推荐关闭 VNC、降低 FPS 和减少同时在线人数。

## 2026-07-05 可运行性与安装体验修复
### Improvements
- 安装脚本现在支持 GitHub Release 的 `.tar.gz` 和 `.zip` 两种压缩包，Release 资产缺一种时也能自动回退，减少服务器安装时卡在下载/解压的概率。
- 首次启动脚本会创建 `data/meta` 和 `data/secrets`，让架构 V2 元数据、世界指纹和 Steam JSON 凭证目录从第一次部署起就保持一致。
- `health-check.sh` 新增管理容器和架构元数据检查，能提前发现 Web 一键更新、出厂化重置、世界指纹写入不可用的问题。
- `verify-deployment.sh` 新增管理容器、`data/meta` 写入和 V2 元数据文件检查，方便服主装完后直接验收整套服务是否真正可用。
- README 快速开始补充安装包格式、目录初始化和装完验收命令，降低宝塔 SSH/小服务器部署时的排查成本。

## 2026-07-05 架构 V2 基础改造
### New Features
- 新增世界状态模型：根据当前存档、Mod 依赖图和 SMAPI 版本生成 `world_fingerprint.json`，用于判断世界组合是否发生变化。
- 新增 `mod_graph.json`，自动记录 Mod manifest、版本、依赖关系、缺失依赖、重复 UniqueID 和解析错误。
- 新增显式编排状态文件 `orchestration-state.json`，启动脚本会写出校验、下载、安装、同步、启动等阶段，面板和诊断报告可直接显示。
- 新增 `/api/world` 和 `/api/world/accept` 接口，可查看当前世界状态，并在确认备份后接受新的世界指纹基线。
- 仪表盘世界指纹卡会在检测到变化时显示“接受基线”按钮，点击后会真正写入新的 accepted fingerprint。

### Improvements
- 世界状态默认使用 manifest 级指纹，避免 2 核 2G 服务器频繁遍历大型 Mod 资产目录；需要完整目录校验时可设置 `PANEL_WORLD_HASH_MODE=full`。
- 出厂化重置会备份并清空 `data/meta`，避免重置后继续使用旧的世界指纹和编排状态。
- 初始化容器会创建并修正 `data/meta` 权限，减少首次启动时的元数据写入失败。
- 诊断页新增架构元数据目录、编排状态、Mod 依赖图和世界指纹检查，崩溃报告会打包这些元数据。
- Steam 凭证支持 `data/secrets/steam.json`，减少把明文密码写进 `.env` 的需求。

### Bug Fixes
- 启动阶段遇到 Steam 凭证缺失、游戏下载失败或 SMAPI 安装失败时，会写入明确的 `STOPPED` 阶段和失败原因。

## 2026-07-05 大型 Mod 事件代理
### New Features
- AutoHideHost v1.4.0 新增“玩家事件代理”：真实玩家进入地点时，隐藏房主会临时进入同地点检查房主侧剧情事件，减少 Ridgeside Village、Stardew Valley Expanded、East Scarp 等大型内容 Mod 需要人工远程干预的问题。
- `game-state.json` 新增 `eventProxy` 状态，记录代理是否启用、当前阶段、触发玩家、地点、事件 ID、超时配置和上次成功/失败原因。
- Web 仪表盘新增“玩家事件代理”状态卡，能实时看到代理是否正在进图、检查事件、处理事件或失败。

### Improvements
- 大型内容 Mod 诊断改为优先检查玩家事件代理，不再把“房主已隐藏”直接当成需要人工处理的问题。
- README 重写大型内容 Mod 剧情说明，解释“地图已加载但事件不触发”的真实原因，并给出无人工远程干预的排查流程。

### Bug Fixes
- 修正事件代理流程，先在玩家进入坐标触发/检查事件，再把房主移回隐藏位置，避免过早隐藏导致入口格事件检测失败。

## 2026-07-04 Web 面板增强版

### New Features
- Web 面板新增“更新日志”页面，可直接查看项目 `CHANGELOG.md` 中的版本改动记录。
- `stardew-manager` 新增 changelog 读取接口，面板通过登录鉴权后的 `/api/changelog` 展示更新内容。
- Web 面板新增一键更新入口，可备份关键配置、拉取最新代码并重建 Docker 服务。
- Web 面板新增“清空上传 Mod”按钮，可一次删除所有上传/自定义 Mod，并自动重建玩家 Mod 下载包。
- Web 面板新增“出厂化重置游戏”危险操作，会先备份存档和上传 Mod，再重置游戏运行数据并重新创建服务器。
- 仪表盘新增“大型 Mod 初始化 / 重新隐藏房主”操作，用于 Ridgeside Village、Stardew Valley Expanded 等需要房主完成前置剧情的内容 Mod。
- 诊断页新增大型内容 Mod 剧情兼容检查，会读取已安装 Mod 的 `manifest.json`、提示缺失依赖、AutoHideHost 版本状态、房主隐藏状态和当前事件/菜单阻塞原因。
- AutoHideHost v1.3.1 新增 `host-command.json` 文件控制通道，面板控制房主不再依赖 `/proc/<pid>/fd/0`，并在状态桥里写出实际加载版本。

### Improvements
- 更新日志页面支持中英文界面、移动端自适应和长文本自动换行。
- 更新任务状态会显示阶段、备份目录、失败原因和日志尾部，方便服主判断是否更新成功。
- 默认联机人数上限统一为 8 人，并在面板状态、配置和启动偏好中保持一致。
- Mod 上传遇到同名文件时，面板会提示是否自动备份并覆盖旧 Mod，更新 Mod 版本不再需要先手动删除。
- 容器启动时会按 manifest 版本同步内置服务端 Mod；旧版 AutoHideHost 会先备份再升级，避免已部署服务器继续加载旧 DLL。
- AutoHideHost 默认关闭“自动跳过可跳过剧情”，避免隐藏房主时误跳过大型内容 Mod 的介绍、解锁或搬入事件。
- 大型 Mod 初始化按钮会等待 SMAPI 状态桥确认命令已生效，旧版 Mod、存档未加载或状态桥未刷新时会返回明确失败原因。
- 更新状态页会把 `status_read_failed`、管理容器不可达和 `HTTP 502` 转成中文原因与检查命令，并在管理容器不可用时禁用更新按钮。
- 出厂化重置任务会显示阶段、备份目录、失败原因和日志尾部，不再是点完后无反馈的危险操作。

### Bug Fixes
- 修正在线人数与暂停状态展示，减少玩家下线后人数残留的问题。
- 加强自动暂停状态来源展示，能区分手动暂停、空服暂停、单人背包暂停和游戏内暂停。
- 修复 Web 一键更新卡在“排队中”的问题：updater 容器现在会覆盖默认入口执行脚本，排队超时会自动标记失败并显示 updater 日志尾部。
- 修复“大型Mod初始化/重新隐藏房主”在部分服务器上因 `EACCES: permission denied, open '/proc/.../fd/0'` 无法发送 SMAPI 命令的问题。

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
