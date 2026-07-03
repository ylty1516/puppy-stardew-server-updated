# ylty 的星露谷联机面板

一个面向《星露谷物语》联机房主的 Docker 服务器与 Web 管理面板。它会在容器中运行真实的 Stardew Valley + SMAPI 游戏进程，让这台容器扮演联机主机，并提供网页面板来管理状态、日志、存档、备份、模组和常见错误诊断。

这个项目适合想要长期开放同一个农场、让朋友随时进入联机世界的玩家。需要注意的是，星露谷本身没有真正的 dedicated server，所谓“服务器”仍然是一个被自动隐藏和自动化操作的主机玩家。本项目已加入节日代理触发，但遇到不可跳过剧情、Steam Guard、首次载入等特殊场景时，仍可能需要人工处理。

## 主要功能

- Docker Compose 一键部署星露谷联机主机
- Web 面板查看服务器状态、联机 IP、在线人数、CPU/内存、游戏日期
- SMAPI 状态桥输出 `game-state.json`，面板可区分“游戏运行”和“联机可加入”
- 星露谷风格主题界面，支持亮色/暗色模式
- 日志页支持错误筛选、诊断卡片和准确错误原因提示
- 手动暂停/恢复游戏内时间，适合临时等人、查在线人数或处理联机状态
- 任意在线玩家进入节日地点时，可由服务器房主自动代理触发节日
- 存档上传、默认存档选择、备份下载和手动备份
- 模组列表查看、上传自定义模组、删除自定义模组
- SMAPI 控制台入口，可输入 Steam Guard 验证码或 SMAPI 命令
- 自动备份、崩溃重启、日志分类、Prometheus 指标

## 手动暂停游戏时间

面板的仪表盘里有“暂停时间 / 恢复时间”按钮。

开启后，面板会写入：

```text
/home/steam/web-panel/data/manual-pause.json
```

内置 AutoHideHost 模组会读取这个状态文件，并在游戏内强制设置 `Game1.paused`，从而冻结游戏时间。关闭后，模组会解除由面板触发的暂停。

这个功能用于：

- 等朋友加入时先暂停游戏时间
- 在线人数刷新或排查联机状态时避免游戏继续走时间
- 临时离开电脑但不想让游戏内时间继续推进

也可以在 SMAPI 控制台中使用：

```text
autohide_pause_time on
autohide_pause_time off
autohide_pause_time toggle
autohide_pause_time status
```

## 任意玩家触发节日

节日当天在开放时间内，任意在线玩家进入当天节日地点时，AutoHideHost 会让服务器端隐藏房主自动进入同一节日地点并启动节日事件。这样不需要专门打开 VNC 去操作服务器房主，普通玩家也能发起节日流程。

这个功能默认开启，不需要其他玩家安装客户端模组。可在 `Mods/AutoHideHost/config.json` 中调整：

```json
{
  "EnableFestivalProxyTrigger": true,
  "FestivalProxyCooldownSeconds": 20
}
```

状态桥 `game-state.json` 会输出当天节日 ID、地点、开放时间和最近一次代理触发记录，方便在面板或日志里排查。

## 可加入状态

AutoHideHost 会定期写入：

```text
/home/steam/web-panel/data/game-state.json
```

Web 面板会优先读取这个 SMAPI 状态桥，而不是只靠日志推断。仪表盘里的“可加入状态”会区分：

- 游戏进程是否运行
- 存档是否已加载
- 当前客户端是否为主机服务器
- 多人联机层是否初始化
- 是否正在保存、卡菜单或卡事件

如果游戏进程还在但多人联机层没有初始化，面板会显示“不可加入”，并提示需要通过 VNC 走 Co-op 重新载入存档。

## 快速开始

一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/ylty1516/puppy-stardew-server-updated/main/install.sh | bash
```

脚本会自动拉取本仓库、生成 `.env`、初始化数据目录权限，并询问是否立即启动 Docker 服务。

如果你已经手动克隆了仓库，也可以在项目目录里运行：

```bash
bash install.sh
```

手动安装方式仍然可用。首次启动前先复制环境变量文件：

```bash
cp .env.example .env
```

然后编辑 `.env`，至少填写：

```env
STEAM_USERNAME=你的Steam账号
STEAM_PASSWORD=你的Steam密码
```

然后初始化目录权限并启动：

```bash
./init.sh
docker compose up -d --build
```

面板默认地址：

```text
http://你的服务器IP:18642
```

游戏联机端口：

```text
24642/udp
```

## 常用端口

| 端口 | 用途 |
| --- | --- |
| `18642/tcp` | Web 管理面板 |
| `24642/udp` | 星露谷联机端口 |
| `5900/tcp` | VNC 画面 |
| `9090/tcp` | Prometheus 指标 |

## 面板功能

### 仪表盘

显示游戏进程状态、在线玩家数、运行时间、游戏日期、联机地址、备份数量、已加载模组和自动化事件。这里也提供“查看日志”“重启服务器”“立即备份”“暂停时间”等快捷操作。

### 日志诊断

日志页会对常见问题给出原因和建议，例如：

- Steam Guard 等待验证码
- Steam 登录失败或账号未拥有游戏
- SteamCMD 下载失败
- 磁盘空间不足
- 目录权限错误
- 存档无法加载
- 模组异常
- VNC 启动失败
- 备份失败

### 存档管理

支持上传星露谷存档 zip、设置默认自动载入存档、创建备份、下载备份和查看备份状态。

### 模组管理

可以查看内置模组和上传的自定义模组。上传 zip 后会尝试自动安装到游戏 `Mods` 目录，重启后生效。

## 重要说明

这个项目不是官方服务器，也不是真正的 dedicated server。它运行的是完整游戏客户端，并用 SMAPI 模组和脚本让房主尽量自动化、隐藏和保持在线。

因此以下情况仍可能需要人工介入：

- Steam Guard 首次验证
- 节日和不可跳过剧情
- 首次创建或载入存档
- 模组版本冲突
- 游戏或 SMAPI 更新后接口变化
- 宿主机网络、防火墙或端口映射问题

## 目录结构

```text
docker/
  web-panel/          Web 管理面板
  scripts/            容器启动、日志、备份、状态监控脚本
  mods/               预装 SMAPI 模组
  mods-source/        自定义模组源码
tests/                测试脚本
screenshots/          截图和演示素材
```

## 参考源码与致谢

本项目基于并参考了以下项目进行二次整理和增强：

- 原始项目：[AmigaMeow/puppy-stardew-server](https://github.com/AmigaMeow/puppy-stardew-server)
- Always On Server：[funny-snek/Always-On-Server-for-Multiplayer](https://github.com/funny-snek/Always-On-Server-for-Multiplayer)
- SMAPI：[Pathoschild/SMAPI](https://github.com/Pathoschild/SMAPI)

本仓库在原项目基础上增加了中文化介绍、星露谷风格主题、结构化错误报告、日志诊断、手动暂停游戏时间、存档/模组面板增强等内容。请尊重原项目和相关模组的许可证。

## 许可证

本项目保留原项目许可证与第三方模组许可证说明。使用、修改或分发前请阅读仓库中的 `LICENSE`、内置模组说明和对应上游项目许可证。
