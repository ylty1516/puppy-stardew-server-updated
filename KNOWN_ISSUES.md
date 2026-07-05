# Known Issues / 已知问题

This document lists known limitations and issues with workarounds.

本文档列出了已知的限制和问题及其解决方法。

---

## Festivals and Non-Skippable Events Are Not Handled (Fundamental Limitation)
## 节日与不可跳过事件不被处理（根本性限制）

**Issue / 问题:**

When a festival starts, or when the game triggers a **non-skippable** event/cutscene, the headless host has no human to interact with it and can get **stuck**. While the host is stuck, connected players may be unable to act, effectively freezing the session.

当节日开始，或游戏触发一个**不可跳过的**事件/过场动画时，无头房主没有真人去与之交互，可能会**卡住**。房主卡住期间，已连接的玩家可能无法操作，整局游戏实际上被冻结。

**Why This Happens / 原因:**

Stardew Valley has no real dedicated-server mode — the host is a full game participant. The bundled `AutoHideHost` mod can only skip events that the game itself marks as *skippable* (`Game1.CurrentEvent.skippable`), and it auto-confirms sleep/shipping/ready-check menus. It does **not** implement any festival logic, and it cannot skip events the game marks as non-skippable.

星露谷没有真正的专用服务器模式——房主是一个完整的游戏参与者。捆绑的 `AutoHideHost` 模组只能跳过游戏本身标记为*可跳过*（`Game1.CurrentEvent.skippable`）的事件，并自动确认睡眠/出货/准备检查菜单。它**没有**实现任何节日处理逻辑，也无法跳过游戏标记为不可跳过的事件。

**Workaround / 解决方法:**

- Connect via VNC during a festival or a stuck event and interact with the host manually (advance/close the event).
- Avoid relying on fully unattended operation across festival days.

- 在节日或卡住的事件期间通过 VNC 连接，手动与房主交互（推进/关闭事件）。
- 不要指望在有节日的日子里完全无人值守地运行。

**Status / 状态:**

This is a fundamental limitation of running an unattended headless host, not a fixable bug. A robust solution requires a **human-hosted** game instead of an unattended host. See the "Project Status" section in the README for the recommended direction.

这是"无人值守无头房主"这一架构的根本性限制，而不是一个可修复的 bug。稳健的方案需要改为**真人当房主**，而不是无人值守的房主。推荐方向见 README 的"项目状态"一节。

---

## Container Restart - Native Co-op Autoload
## 容器重启 - 原生 Co-op 自动加载

**Status / 状态:**

Fixed in ServerAutoLoad v2.0.0.

已在 ServerAutoLoad v2.0.0 修复。

**What changed / 改动:**

Older builds loaded save data directly and then tried to force host mode. In Stardew Valley 1.6+, that can leave the multiplayer farmhand slot list incomplete. ServerAutoLoad v2 now opens Stardew Valley's native `Co-op -> Host` menu, waits for host save slots, and activates the selected save through the game's own `HostFileSlot.Activate()` path.

旧版会直接读取存档数据，然后尝试强行补成主机模式。在星露谷物语 1.6+ 中，这可能导致多人 farmhand 席位列表初始化不完整。ServerAutoLoad v2 现在会打开星露谷原生 `Co-op -> Host` 菜单，等待主持存档槽位出现，再通过游戏自己的 `HostFileSlot.Activate()` 路径载入选中的存档。

**If players still cannot join / 如果玩家仍然无法加入:**

Check the Web panel diagnostics. The report now includes `server-autoload-state.json` and the player join handshake stage, so you can distinguish:

打开 Web 面板诊断。报告现在会包含 `server-autoload-state.json` 和玩家加入握手阶段，用来区分：

- whether the native Host menu opened
- whether the selected save appeared in the Host list
- whether the host slot was activated
- whether the server sent farmhand slots to the client
- whether the client selected a farmhand and the server approved it

- 是否已打开原生 Host 菜单
- 选中的存档是否出现在 Host 列表
- 是否已激活 Host 存档槽位
- 服务端是否已把 farmhand 席位列表发给客户端
- 客户端是否已选择 farmhand，并被服务端批准

---

## Audio Warnings in Logs
## 日志中的音频警告

**Issue / 问题:**

You may see these warnings in the logs:
日志中可能会看到这些警告：

```
OpenAL device could not be initialized
Steam achievements won't work because Steam isn't loaded
```

**Why This Happens / 原因:**

The server runs in a headless environment without audio hardware or Steam client.
服务器在无音频硬件或 Steam 客户端的 headless 环境中运行。

**Impact / 影响:**

None - these are harmless warnings and do not affect server functionality.
无影响 - 这些是无害的警告，不影响服务器功能。

**Workaround / 解决方法:**

No action needed. These warnings can be safely ignored.
无需操作。可以安全地忽略这些警告。

---

## VNC Connection Required for First Setup
## 首次设置需要 VNC 连接

**Issue / 问题:**

The first time you start the server, you must use VNC to create or load a save file.
首次启动服务器时，必须使用 VNC 创建或加载存档文件。

**Why This Happens / 原因:**

Stardew Valley's multiplayer server requires an active save file. The game must be launched and a Co-op save created through the in-game interface.
星露谷物语的联机服务器需要一个活动的存档文件。必须启动游戏并通过游戏内界面创建 Co-op 存档。

**Impact / 影响:**

One-time setup only. After the initial save is created, it will auto-load on subsequent starts (though multiplayer may require manual reload after restarts - see issue above).
仅需一次设置。创建初始存档后，ServerAutoLoad v2 会在后续启动时通过原生 `Co-op -> Host` 流程自动加载目标存档。

**Workaround / 解决方法:**

Follow the setup instructions in the README:
按照 README 中的设置说明：

1. Connect via VNC (port 5900, password from .env file)
   通过 VNC 连接（端口 5900，密码来自 .env 文件）

2. Click "CO-OP" → "Start new co-op farm" or "Load" existing save
   点击 "CO-OP" → "开始新的联机农场" 或 "加载" 现有存档

3. After setup, you can disable VNC if desired to save ~50MB RAM
   设置完成后，如需节省约 50MB 内存，可禁用 VNC

---

## Reporting New Issues / 报告新问题

If you encounter an issue not listed here, please report it:
如果遇到此处未列出的问题，请报告：

- GitHub Issues: https://github.com/AmigaMeow/puppy-stardew-server/issues
- Docker Hub: https://hub.docker.com/r/truemanlive/puppy-stardew-server

Please include:
请包含：

- Container logs: `docker logs puppy-stardew`
- Game version from logs
- Steps to reproduce

---

**Last Updated:** 2025-10-29
**Version:** v1.0.23
