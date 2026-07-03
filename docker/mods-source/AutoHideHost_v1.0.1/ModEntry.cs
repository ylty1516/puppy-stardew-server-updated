using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace AutoHideHost
{
    /// <summary>AutoHideHost 模组主入口 - v1.2.2: 完全禁用LevelUpMenu自动处理</summary>
    public class ModEntry : Mod
    {
        private const string ClientPauseReporterModId = "ylty.SinglePlayerPauseReporter";
        private const string BackpackStateMessageType = "BackpackState";

        private ModConfig Config;
        private bool isHostHidden = false;
        private bool hasTriggeredSleep = false;
        private bool needToSleep = false;
        private int sleepDelayTicks = 0;
        private bool isSleepInProgress = false;
        private bool handledReadyCheck = false;  // v1.4.0: 防止重复处理同一个ReadyCheck

        // v1.4.1: Always On Server 自动启用相关
        private bool alwaysOnServerChecked = false;
        private int alwaysOnServerCheckTicks = 0;
        private bool needToCheckAlwaysOnServer = false;

        // v1.1.8: 守护窗口机制 - 防止玩家连接后房主被传送到Farm
        private DateTime? guardWindowEnd = null;  // 守护窗口结束时间
        private DateTime? lastRehideTime = null;  // 上次重新隐藏时间（防抖）
        private bool needRehide = false;  // 是否需要重新隐藏
        private int rehideTicks = 0;  // 重新隐藏倒计时

        // v1.2.0: 防止事件跳过无限循环
        private string lastSkippedEventId = null;  // 上次跳过的事件ID
        private DateTime? lastSkipTime = null;  // 上次跳过时间
        private int skipCooldownSeconds = 5;  // 跳过冷却时间（秒）
        private bool manualPauseApplied = false;
        private bool manualPauseLastRequested = false;
        private bool autoPauseApplied = false;
        private DateTime? autoPauseEmptySince = null;
        private DateTime? autoPauseWorldReadySince = null;
        private string autoPauseState = "not_ready";
        private string autoPauseReason = "world_not_ready";
        private int autoPauseLastOnlinePlayers = 0;
        private string autoPauseControlError = "";
        private readonly Dictionary<long, ClientBackpackState> clientBackpackStates = new Dictionary<long, ClientBackpackState>();
        private bool singleFarmhandMenuPauseApplied = false;
        private string singleFarmhandMenuPauseState = "not_ready";
        private string singleFarmhandMenuPauseReason = "world_not_ready";
        private long singleFarmhandMenuPausePlayerId = 0;
        private string singleFarmhandMenuPausePlayerName = "";
        private string singleFarmhandMenuPauseMenuType = "";
        private string lastAutomationType = "";
        private bool lastAutomationSuccess = false;
        private string lastAutomationMessage = "";
        private DateTime? lastAutomationAt = null;
        private string lastFestivalProxyKey = "";
        private string lastFestivalProxyBy = "";
        private string lastFestivalProxyFestivalId = "";
        private DateTime? lastFestivalProxyAt = null;

        public override void Entry(IModHelper helper)
        {
            this.Config = helper.ReadConfig<ModConfig>();
            this.Monitor.Log($"AutoHideHost v{this.ModManifest.Version} 已加载", LogLevel.Info);
            this.Monitor.Log($"配置: 隐藏={Config.HideMethod}, 暂停={Config.PauseWhenEmpty}, 即时睡眠={Config.InstantSleepWhenReady}", LogLevel.Info);

            helper.Events.GameLoop.SaveLoaded += OnSaveLoaded;
            helper.Events.GameLoop.DayStarted += OnDayStarted;
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.Saving += OnSaving;
            helper.Events.Display.MenuChanged += OnMenuChanged;  // v1.4.0: 处理菜单变化

            // v1.1.8: 守护窗口机制
            helper.Events.Multiplayer.PeerConnected += OnPeerConnected;  // 玩家连接时启动守护窗口
            helper.Events.Multiplayer.PeerDisconnected += OnPeerDisconnected;
            helper.Events.Multiplayer.ModMessageReceived += OnModMessageReceived;
            helper.Events.Player.Warped += OnWarped;  // 监控房主传送

            RegisterCommands();
        }

        private void OnSaveLoaded(object sender, SaveLoadedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            // v1.4.1: 启动 Always On Server 检查（延迟3秒，等待ServerAutoLoad设置多人模式）
            needToCheckAlwaysOnServer = true;
            alwaysOnServerCheckTicks = 0;
            alwaysOnServerChecked = false;
            bool autoPauseEnabled = IsAutoPauseEnabled();
            autoPauseWorldReadySince = DateTime.UtcNow;
            autoPauseEmptySince = null;
            autoPauseApplied = false;
            autoPauseState = autoPauseEnabled ? "startup_grace" : "disabled";
            autoPauseReason = autoPauseEnabled ? "waiting_for_multiplayer_ready" : "disabled";
            clientBackpackStates.Clear();
            singleFarmhandMenuPauseApplied = false;
            singleFarmhandMenuPauseState = Config.PauseWhenSingleFarmhandOpensMenu ? "waiting" : "disabled";
            singleFarmhandMenuPauseReason = Config.PauseWhenSingleFarmhandOpensMenu ? "waiting_for_client_reporter" : "disabled";
            singleFarmhandMenuPausePlayerId = 0;
            singleFarmhandMenuPausePlayerName = "";
            singleFarmhandMenuPauseMenuType = "";
            this.Monitor.Log("存档已加载，3秒后检查 Always On Server 状态", LogLevel.Info);

            if (Config.AutoHideOnLoad)
            {
                HideHost();
                this.Monitor.Log("房主自动隐藏", LogLevel.Info);
            }
        }

        private void OnDayStarted(object sender, DayStartedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled || !Config.AutoHideDaily)
                return;
            HideHost();
            hasTriggeredSleep = false;
            isSleepInProgress = false;
            handledReadyCheck = false;  // v1.4.0: 重置ReadyCheck标志
            clientBackpackStates.Clear();
            ResetSingleFarmhandMenuPauseState("waiting", "new_day");

            // v1.2.0: 重置事件跳过标志
            lastSkippedEventId = null;
            lastSkipTime = null;

            // v1.1.9: 每天开始时启动守护窗口（防止玩家一直在线导致窗口过期）
            if (Config.PreventHostFarmWarp)
            {
                guardWindowEnd = DateTime.Now.AddSeconds(Config.PeerConnectGuardSeconds);
                this.Monitor.Log($"[守护窗口] 新的一天开始，启动{Config.PeerConnectGuardSeconds}秒守护窗口", LogLevel.Info);
                LogDebug($"[守护窗口] 窗口结束时间: {guardWindowEnd:HH:mm:ss}");
            }

            LogDebug("新的一天，房主重新隐藏");
        }

        /// <summary>
        /// v1.4.0: 处理菜单变化 - 自动处理ShippingMenu和LevelUpMenu
        /// </summary>
        private void OnMenuChanged(object sender, MenuChangedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            // 重置ReadyCheck标志（新菜单出现时）
            if (e.OldMenu != null && e.OldMenu.GetType().Name == "ReadyCheckDialog")
            {
                handledReadyCheck = false;
            }

            if (e.NewMenu == null)
                return;

            string menuType = e.NewMenu.GetType().Name;
            this.Monitor.Log($"菜单变化: {e.OldMenu?.GetType().Name ?? "null"} → {menuType}", LogLevel.Debug);

            // 1. ShippingMenu（结算菜单）
            if (e.NewMenu is StardewValley.Menus.ShippingMenu shippingMenu)
            {
                this.Monitor.Log("检测到ShippingMenu，自动点击OK", LogLevel.Info);
                try
                {
                    // 使用反射调用okClicked方法
                    this.Helper.Reflection.GetMethod(shippingMenu, "okClicked").Invoke();
                    this.Monitor.Log("✓ ShippingMenu已自动关闭", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"关闭ShippingMenu失败: {ex.Message}", LogLevel.Error);
                }
                return;
            }

            // 2. LevelUpMenu（升级菜单）
            // v1.2.2: CRITICAL - 完全不处理LevelUpMenu！
            // 原因：任何自动点击都会触发技能升级选择，导致房主技能自动升到10级
            // LevelUpMenu不会阻塞游戏流程，可以安全地让它保持显示
            // 房主是隐藏的，玩家看不到这个菜单，游戏会正常继续
            if (e.NewMenu is StardewValley.Menus.LevelUpMenu levelUpMenu)
            {
                this.Monitor.Log("检测到LevelUpMenu，保持显示（不自动处理以避免技能自动升级）", LogLevel.Info);
                return;  // 不做任何处理，让菜单自然存在
            }

            // 3. DialogueBox（对话框）- 处理任务通知等阻塞性对话
            if (e.NewMenu is StardewValley.Menus.DialogueBox dialogueBox)
            {
                if (IsNightTransitionOrPassoutWindow())
                {
                    this.Monitor.Log("检测到过夜/晕倒/保存流程中的DialogueBox，交给游戏原生流程处理", LogLevel.Info);
                    return;
                }

                try
                {
                    // 获取当前对话内容
                    var dialogue = this.Helper.Reflection.GetField<StardewValley.Dialogue>(
                        dialogueBox, "characterDialogue", required: false)?.GetValue();

                    string dialogueText = dialogue?.getCurrentDialogue() ?? "";

                    // 记录所有 DialogueBox 内容以便调试
                    this.Monitor.Log($"DialogueBox 内容: {dialogueText.Substring(0, Math.Min(100, dialogueText.Length))}", LogLevel.Debug);

                    // 检测是否是任务通知（包含特定关键词）
                    if (dialogueText.Contains("Accept Quest") ||
                        dialogueText.Contains("accept") ||
                        dialogueText.Contains("lost") ||
                        dialogueText.Contains("find") ||
                        dialogueText.Contains("250g") ||
                        dialogueText.Contains("MISSING"))
                    {
                        this.Monitor.Log($"检测到任务通知对话框，自动拒绝", LogLevel.Info);

                        // 按ESC键关闭对话框（拒绝任务）
                        dialogueBox.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);

                        this.Monitor.Log("✓ 任务通知已自动关闭（拒绝）", LogLevel.Info);
                        return;
                    }

                    this.Monitor.Log("检测到非任务通知的DialogueBox，保留给游戏原生流程处理", LogLevel.Debug);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"处理DialogueBox失败: {ex.Message}", LogLevel.Debug);
                }
            }

            // 4. LetterViewerMenu（信件查看菜单）- 自动关闭以避免阻塞睡眠
            if (e.NewMenu is StardewValley.Menus.LetterViewerMenu letterMenu)
            {
                this.Monitor.Log("检测到LetterViewerMenu（信件菜单），自动关闭", LogLevel.Info);
                try
                {
                    // 按ESC键关闭信件菜单
                    letterMenu.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    this.Monitor.Log("✓ LetterViewerMenu已自动关闭", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"关闭LetterViewerMenu失败: {ex.Message}", LogLevel.Error);
                }
                return;
            }
        }

        /// <summary>
        /// v1.3.4: OnSaving - 确保房主位置正确，处理菜单
        /// </summary>
        private void OnSaving(object sender, SavingEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            this.Monitor.Log($"OnSaving事件触发 - 当前位置: {Game1.player.currentLocation?.Name}", LogLevel.Info);
            this.Monitor.Log($"lastSleepLocation: {Game1.player.lastSleepLocation.Value}, lastSleepPoint: {Game1.player.lastSleepPoint.Value}", LogLevel.Info);

            // v1.3.4: CRITICAL - 如果房主不在FarmHouse，强制设置睡眠位置
            if (Game1.player.currentLocation?.Name != "FarmHouse")
            {
                this.Monitor.Log($"警告：房主在{Game1.player.currentLocation?.Name}，强制设置睡眠唤醒位置", LogLevel.Warn);

                int bedX = 9, bedY = 9;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                if (houseUpgradeLevel == 1)
                {
                    bedX = 21; bedY = 4;
                }
                else if (houseUpgradeLevel >= 2)
                {
                    bedX = 27; bedY = 13;
                }

                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);
                this.Monitor.Log($"✓ 强制设置睡眠唤醒: FarmHouse ({bedX}, {bedY})", LogLevel.Info);
            }

            // 自动点击ShippingMenu的OK按钮
            if (Game1.activeClickableMenu is StardewValley.Menus.ShippingMenu)
            {
                this.Monitor.Log("检测到ShippingMenu（结算菜单），自动点击OK", LogLevel.Info);
                try
                {
                    this.Helper.Reflection.GetMethod(Game1.activeClickableMenu, "okClicked").Invoke();
                    this.Monitor.Log("✓ ShippingMenu已自动关闭", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"关闭ShippingMenu失败: {ex.Message}", LogLevel.Error);
                }
            }

            // ShippingMenu关闭后可能出现DialogueBox
            if (Game1.activeClickableMenu is StardewValley.Menus.DialogueBox)
            {
                this.Monitor.Log("OnSaving期间检测到DialogueBox，跳过自动点击以避免打断过夜/晕倒流程", LogLevel.Info);
            }
        }

        private bool IsNightTransitionOrPassoutWindow()
        {
            if (!Context.IsWorldReady)
                return false;

            if (Game1.saveOnNewDay || isSleepInProgress || hasTriggeredSleep || needToSleep)
                return true;

            if (Game1.game1 != null && Game1.game1.IsSaving)
                return true;

            return Game1.timeOfDay >= 2600;
        }

        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            if (!Config.Enabled || !Context.IsMainPlayer)
                return;

            if (e.Ticks % Math.Max(15, Config.ManualPausePollTicks) == 0)
            {
                ApplyManualPauseFlag();
            }

            if (e.Ticks % Math.Max(30, Config.GameStateWriteTicks) == 0)
            {
                WriteGameStateBridge();
            }

            // v1.1.8: 处理延迟重新隐藏
            if (needRehide && rehideTicks > 0)
            {
                rehideTicks--;
                if (rehideTicks == 0)
                {
                    this.Monitor.Log($"[守护窗口] 执行重新隐藏", LogLevel.Info);
                    HideHost();
                    lastRehideTime = DateTime.Now;
                    needRehide = false;
                    this.Monitor.Log($"[守护窗口] ✓ 房主已重新隐藏", LogLevel.Info);
                }
            }

            // v1.4.1: 检查并自动启用 Always On Server
            if (needToCheckAlwaysOnServer && !alwaysOnServerChecked)
            {
                alwaysOnServerCheckTicks++;

                // 延迟180 ticks (3秒)，给 ServerAutoLoad 时间设置多人模式
                if (alwaysOnServerCheckTicks >= 180)
                {
                    alwaysOnServerChecked = true;
                    needToCheckAlwaysOnServer = false;
                    CheckAndEnableAlwaysOnServer();
                }
            }

            // v1.4.0: 全局菜单和Ready状态处理
            if (e.Ticks % 30 == 0)  // 每0.5秒执行一次
            {
                // v1.4.0: 使用Team Ready API - 更可靠的方案
                try
                {
                    // 检查是否有活跃的"sleep"准备检查
                    if (Game1.player?.team != null)
                    {
                        // 尝试通过反射获取ready check状态
                        var readyCheckName = GetActiveReadyCheckName();

                        if (!string.IsNullOrEmpty(readyCheckName) && !handledReadyCheck)
                        {
                            this.Monitor.Log($"检测到活跃的ReadyCheck: '{readyCheckName}'", LogLevel.Info);

                            // 直接设置房主为准备状态
                            try
                            {
                                var setReadyMethod = this.Helper.Reflection.GetMethod(
                                    Game1.player.team, "SetLocalReady", required: false);

                                if (setReadyMethod != null)
                                {
                                    setReadyMethod.Invoke(readyCheckName, true);
                                    this.Monitor.Log($"✓ 房主已设置为准备状态（SetLocalReady）", LogLevel.Info);
                                    SetLastAutomation("readyCheck", true, $"SetLocalReady:{readyCheckName}");
                                    handledReadyCheck = true;
                                }
                                else
                                {
                                    this.Monitor.Log("未找到SetLocalReady方法，尝试UI点击", LogLevel.Debug);
                                    // 回退到UI点击
                                    TryClickReadyCheckDialog();
                                }
                            }
                            catch (Exception ex)
                            {
                                this.Monitor.Log($"SetLocalReady失败: {ex.Message}，尝试UI点击", LogLevel.Debug);
                                TryClickReadyCheckDialog();
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"ReadyCheck处理出错: {ex.Message}", LogLevel.Trace);
                }

                // 3. 自动跳过可跳过的事件
                // v1.2.0: 添加事件ID去重和冷却时间，防止无限循环
                if (Game1.CurrentEvent != null && Game1.CurrentEvent.skippable)
                {
                    string currentEventId = Game1.CurrentEvent.id;

                    // 检查是否是同一个事件
                    bool isSameEvent = (currentEventId == lastSkippedEventId);

                    // 检查冷却时间
                    bool inCooldown = false;
                    if (lastSkipTime.HasValue)
                    {
                        var timeSinceLastSkip = (DateTime.Now - lastSkipTime.Value).TotalSeconds;
                        inCooldown = timeSinceLastSkip < skipCooldownSeconds;

                        if (inCooldown && isSameEvent)
                        {
                            // 同一个事件且在冷却期内，跳过（防止无限循环）
                            LogDebug($"[事件跳过冷却] 事件 {currentEventId} 在 {timeSinceLastSkip:F1}秒内已处理，跳过");
                            return;
                        }
                    }

                    // 可以跳过这个事件
                    this.Monitor.Log($"跳过可跳过的事件: {currentEventId}", LogLevel.Info);
                    Game1.CurrentEvent.skipEvent();
                    SetLastAutomation("skipEvent", true, currentEventId);

                    // 记录已处理的事件
                    lastSkippedEventId = currentEventId;
                    lastSkipTime = DateTime.Now;
                }
            }

            // v1.3.5: 睡眠期间维持房主睡眠状态 + 强制睡眠位置
            if (isSleepInProgress)
            {
                if (!Game1.player.isInBed.Value || Game1.player.timeWentToBed.Value == 0)
                {
                    Game1.player.isInBed.Value = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                    LogDebug("持续维持房主睡眠状态");
                }

                // v1.3.5: CRITICAL FIX - 每个tick强制设置睡眠位置
                // 防止被其他代码覆盖
                if (Game1.player.lastSleepLocation.Value != "FarmHouse")
                {
                    int bedX = 9, bedY = 9;
                    int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                    if (houseUpgradeLevel == 1)
                    {
                        bedX = 21; bedY = 4;
                    }
                    else if (houseUpgradeLevel >= 2)
                    {
                        bedX = 27; bedY = 13;
                    }

                    Game1.player.lastSleepLocation.Value = "FarmHouse";
                    Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);
                    this.Monitor.Log($"睡眠期间强制修正lastSleepLocation: FarmHouse ({bedX}, {bedY})", LogLevel.Warn);
                }

                return;  // 睡眠期间跳过其他检查
            }

            // 处理延迟睡眠逻辑
            if (needToSleep)
            {
                sleepDelayTicks++;
                if (sleepDelayTicks >= 1)
                {
                    ExecuteSleep();
                    needToSleep = false;
                    sleepDelayTicks = 0;
                }
                return;
            }

            if (e.Ticks % 15 == 0 && Config.InstantSleepWhenReady)
            {
                CheckAndAutoSleep();
            }

            if (e.Ticks % Math.Max(15, Config.AutoPausePollTicks) == 0)
            {
                CheckAndAutoPause();
                CheckAndSingleFarmhandMenuPause();
            }
        }

        private void HideHost()
        {
            if (!Context.IsMainPlayer)
                return;

            switch (Config.HideMethod.ToLower())
            {
                case "warp":
                    Game1.warpFarmer(Config.WarpLocation, Config.WarpX, Config.WarpY, false);
                    LogDebug($"房主已传送至 {Config.WarpLocation} ({Config.WarpX}, {Config.WarpY})");
                    break;
                case "invisible":
                    this.Monitor.Log("隐形方式在1.6版本中不可用，使用warp方式", LogLevel.Warn);
                    Game1.warpFarmer("Desert", 0, 0, false);
                    break;
                case "offmap":
                    Game1.player.Position = new Vector2(-999999, -999999);
                    LogDebug("房主已移动到地图外");
                    break;
                default:
                    Game1.warpFarmer("Desert", 0, 0, false);
                    break;
            }
            isHostHidden = true;
        }

        private void CheckAndAutoPause()
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
            {
                ResetAutoPauseState("not_ready", "main_player_not_ready");
                return;
            }

            if (!Context.IsWorldReady)
            {
                autoPauseWorldReadySince = null;
                ResetAutoPauseState("not_ready", "world_not_ready");
                return;
            }

            if (!autoPauseWorldReadySince.HasValue)
                autoPauseWorldReadySince = DateTime.UtcNow;

            bool autoPauseEnabled = IsAutoPauseEnabled();
            int onlineFarmhands = CountOnlineFarmhands();
            autoPauseLastOnlinePlayers = onlineFarmhands;

            if (onlineFarmhands > 0)
            {
                autoPauseEmptySince = null;
                ResumeAutoPause($"player_online:{onlineFarmhands}");
                autoPauseState = "online";
                autoPauseReason = $"players_online:{onlineFarmhands}";
                return;
            }

            if (!autoPauseEnabled)
            {
                autoPauseEmptySince = null;
                ResumeAutoPause("auto_pause_disabled", force: true);
                autoPauseState = "disabled";
                autoPauseReason = "disabled";
                return;
            }

            bool manualRequested = ReadManualPauseFlag();
            if (manualRequested)
            {
                autoPauseState = "manual_pause";
                autoPauseReason = "manual_pause_has_priority";
                return;
            }

            if (!IsAutoPauseSafe(out string unsafeReason))
            {
                autoPauseState = "blocked";
                autoPauseReason = unsafeReason;
                return;
            }

            DateTime now = DateTime.UtcNow;
            if (!autoPauseEmptySince.HasValue)
            {
                autoPauseEmptySince = now;
                autoPauseState = "waiting";
                autoPauseReason = "empty_delay_started";
                LogDebug($"[自动暂停] 服务器无人在线，开始等待 {Config.EmptyPauseDelaySeconds} 秒后暂停");
                return;
            }

            double emptySeconds = (now - autoPauseEmptySince.Value).TotalSeconds;
            int delaySeconds = Math.Max(0, Config.EmptyPauseDelaySeconds);
            if (emptySeconds < delaySeconds)
            {
                autoPauseState = "waiting";
                autoPauseReason = $"empty_for_{Math.Floor(emptySeconds)}_of_{delaySeconds}_seconds";
                return;
            }

            autoPauseState = "paused";
            autoPauseReason = "empty_server";
            if (!Game1.paused)
            {
                Game1.paused = true;
                SetLastAutomation("autoPause", true, $"paused_after_empty:{Math.Floor(emptySeconds)}s");
                this.Monitor.Log($"[自动暂停] 已连续 {Math.Floor(emptySeconds)} 秒无玩家在线，游戏时间已冻结", LogLevel.Info);
            }
            else if (!autoPauseApplied)
            {
                SetLastAutomation("autoPause", true, "claimed_existing_pause");
                this.Monitor.Log("[自动暂停] 无玩家在线，游戏已经处于暂停状态，接管为自动暂停", LogLevel.Info);
            }

            autoPauseApplied = true;
        }

        private int CountOnlineFarmhands()
        {
            return GetOnlineFarmhands().Count;
        }

        private List<Farmer> GetOnlineFarmhands()
        {
            if (!Context.IsWorldReady || Game1.player == null)
                return new List<Farmer>();

            return Game1.getOnlineFarmers()
                .Where(f => f != null && f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .ToList();
        }

        private void CheckAndSingleFarmhandMenuPause()
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
            {
                ResetSingleFarmhandMenuPauseState("not_ready", "main_player_not_ready");
                return;
            }

            if (!Context.IsWorldReady)
            {
                ResetSingleFarmhandMenuPauseState("not_ready", "world_not_ready");
                return;
            }

            if (!Config.PauseWhenSingleFarmhandOpensMenu)
            {
                ResumeSingleFarmhandMenuPause("feature_disabled");
                singleFarmhandMenuPauseState = "disabled";
                singleFarmhandMenuPauseReason = "disabled";
                return;
            }

            var onlineFarmhands = GetOnlineFarmhands();
            if (onlineFarmhands.Count != 1)
            {
                ResumeSingleFarmhandMenuPause($"online_farmhands:{onlineFarmhands.Count}");
                singleFarmhandMenuPauseState = onlineFarmhands.Count == 0 ? "waiting" : "multiple_players";
                singleFarmhandMenuPauseReason = onlineFarmhands.Count == 0 ? "no_farmhand_online" : $"online_farmhands:{onlineFarmhands.Count}";
                singleFarmhandMenuPausePlayerId = 0;
                singleFarmhandMenuPausePlayerName = "";
                singleFarmhandMenuPauseMenuType = "";
                return;
            }

            Farmer farmhand = onlineFarmhands[0];
            long playerId = farmhand.UniqueMultiplayerID;
            if (!clientBackpackStates.TryGetValue(playerId, out ClientBackpackState state))
            {
                ResumeSingleFarmhandMenuPause($"no_client_report:{playerId}");
                singleFarmhandMenuPauseState = "waiting_for_client";
                singleFarmhandMenuPauseReason = "client_reporter_required";
                singleFarmhandMenuPausePlayerId = playerId;
                singleFarmhandMenuPausePlayerName = farmhand.Name ?? "";
                singleFarmhandMenuPauseMenuType = "";
                return;
            }

            double ageSeconds = (DateTime.UtcNow - state.UpdatedAt).TotalSeconds;
            if (ageSeconds > Math.Max(3, Config.SingleFarmhandMenuPauseTimeoutSeconds))
            {
                ResumeSingleFarmhandMenuPause($"stale_client_report:{Math.Floor(ageSeconds)}s");
                singleFarmhandMenuPauseState = "stale_client";
                singleFarmhandMenuPauseReason = $"client_report_stale:{Math.Floor(ageSeconds)}s";
                singleFarmhandMenuPausePlayerId = playerId;
                singleFarmhandMenuPausePlayerName = farmhand.Name ?? state.PlayerName ?? "";
                singleFarmhandMenuPauseMenuType = state.MenuType ?? "";
                return;
            }

            singleFarmhandMenuPausePlayerId = playerId;
            singleFarmhandMenuPausePlayerName = farmhand.Name ?? state.PlayerName ?? "";
            singleFarmhandMenuPauseMenuType = state.MenuType ?? "";

            if (!state.BackpackOpen)
            {
                ResumeSingleFarmhandMenuPause("backpack_closed");
                singleFarmhandMenuPauseState = "closed";
                singleFarmhandMenuPauseReason = "backpack_closed";
                return;
            }

            if (ReadManualPauseFlag())
            {
                singleFarmhandMenuPauseState = "manual_pause";
                singleFarmhandMenuPauseReason = "manual_pause_has_priority";
                return;
            }

            if (!IsSingleFarmhandMenuPauseSafe(out string unsafeReason))
            {
                singleFarmhandMenuPauseState = "blocked";
                singleFarmhandMenuPauseReason = unsafeReason;
                return;
            }

            singleFarmhandMenuPauseState = "paused";
            singleFarmhandMenuPauseReason = "single_farmhand_backpack_open";
            if (!Game1.paused)
            {
                Game1.paused = true;
                singleFarmhandMenuPauseApplied = true;
                SetLastAutomation("singleFarmhandMenuPause", true, $"{singleFarmhandMenuPausePlayerName}:{singleFarmhandMenuPauseMenuType}");
                this.Monitor.Log($"[单人背包暂停] 真实在线玩家只有 {singleFarmhandMenuPausePlayerName}，检测到背包打开，游戏时间已冻结", LogLevel.Info);
            }
            else if (singleFarmhandMenuPauseApplied)
            {
                singleFarmhandMenuPauseReason = "single_farmhand_backpack_still_open";
            }
        }

        private bool IsSingleFarmhandMenuPauseSafe(out string reason)
        {
            reason = "";

            if (!Game1.IsServer || Game1.server == null)
            {
                reason = "multiplayer_not_ready";
                return false;
            }

            if (Game1.game1 != null && Game1.game1.IsSaving)
            {
                reason = "saving";
                return false;
            }

            if (isSleepInProgress || needToSleep || Game1.saveOnNewDay)
            {
                reason = "sleep_or_day_transition";
                return false;
            }

            if (Game1.CurrentEvent != null)
            {
                reason = "event_active";
                return false;
            }

            return true;
        }

        private void ResetSingleFarmhandMenuPauseState(string state, string reason)
        {
            if (singleFarmhandMenuPauseApplied)
                ResumeSingleFarmhandMenuPause(reason);

            singleFarmhandMenuPauseState = state;
            singleFarmhandMenuPauseReason = reason;
            singleFarmhandMenuPausePlayerId = 0;
            singleFarmhandMenuPausePlayerName = "";
            singleFarmhandMenuPauseMenuType = "";
        }

        private void ResumeSingleFarmhandMenuPause(string reason)
        {
            if (!singleFarmhandMenuPauseApplied)
                return;

            singleFarmhandMenuPauseApplied = false;

            if (Game1.paused && !ReadManualPauseFlag() && !autoPauseApplied)
            {
                Game1.paused = false;
                SetLastAutomation("singleFarmhandMenuPause", true, $"resumed:{reason}");
                this.Monitor.Log($"[单人背包暂停] {reason}，游戏时间已恢复", LogLevel.Info);
            }
        }

        private bool IsAutoPauseEnabled()
        {
            if (TryReadAutoPauseControlFlag(out bool controlledEnabled))
                return controlledEnabled;

            return Config.PauseWhenEmpty;
        }

        private bool TryReadAutoPauseControlFlag(out bool enabled)
        {
            enabled = Config.PauseWhenEmpty;
            autoPauseControlError = "";

            try
            {
                if (string.IsNullOrWhiteSpace(Config.AutoPauseControlFile) || !File.Exists(Config.AutoPauseControlFile))
                    return false;

                string raw = File.ReadAllText(Config.AutoPauseControlFile).Trim();
                if (raw.Equals("true", StringComparison.OrdinalIgnoreCase))
                {
                    enabled = true;
                    return true;
                }

                if (raw.Equals("false", StringComparison.OrdinalIgnoreCase))
                {
                    enabled = false;
                    return true;
                }

                if (Regex.IsMatch(raw, "\"enabled\"\\s*:\\s*true", RegexOptions.IgnoreCase))
                {
                    enabled = true;
                    return true;
                }

                if (Regex.IsMatch(raw, "\"enabled\"\\s*:\\s*false", RegexOptions.IgnoreCase))
                {
                    enabled = false;
                    return true;
                }

                autoPauseControlError = "missing_enabled_boolean";
                return false;
            }
            catch (Exception ex)
            {
                autoPauseControlError = ex.Message;
                return false;
            }
        }

        private void WriteAutoPauseControlFlag(bool enabled, string reason)
        {
            if (string.IsNullOrWhiteSpace(Config.AutoPauseControlFile))
                return;

            string dir = Path.GetDirectoryName(Config.AutoPauseControlFile);
            if (!string.IsNullOrWhiteSpace(dir))
                Directory.CreateDirectory(dir);

            string json = "{\n" +
                $"  \"enabled\": {(enabled ? "true" : "false")},\n" +
                $"  \"updatedAt\": \"{DateTime.UtcNow:O}\",\n" +
                "  \"updatedBy\": \"smapi-console\",\n" +
                $"  \"reason\": \"{JsonEscape(reason)}\"\n" +
                "}\n";
            File.WriteAllText(Config.AutoPauseControlFile, json);
        }

        private bool IsAutoPauseSafe(out string reason)
        {
            reason = "";

            if (!Game1.IsServer || Game1.server == null)
            {
                reason = "multiplayer_not_ready";
                return false;
            }

            int startupGraceSeconds = Math.Max(0, Config.AutoPauseStartupGraceSeconds);
            if (autoPauseWorldReadySince.HasValue
                && (DateTime.UtcNow - autoPauseWorldReadySince.Value).TotalSeconds < startupGraceSeconds)
            {
                reason = "startup_grace";
                return false;
            }

            if (Game1.game1 != null && Game1.game1.IsSaving)
            {
                reason = "saving";
                return false;
            }

            if (isSleepInProgress || needToSleep || Game1.saveOnNewDay)
            {
                reason = "sleep_or_day_transition";
                return false;
            }

            if (Game1.CurrentEvent != null)
            {
                reason = Game1.CurrentEvent.skippable ? "event_cleanup" : "blocking_event";
                return false;
            }

            if (Game1.activeClickableMenu != null)
            {
                reason = $"menu_open:{Game1.activeClickableMenu.GetType().Name}";
                return false;
            }

            reason = "safe";
            return true;
        }

        private void ResetAutoPauseState(string state, string reason)
        {
            if (autoPauseApplied && Context.IsWorldReady)
            {
                ResumeAutoPause(reason, force: true);
            }
            else
            {
                autoPauseApplied = false;
                autoPauseEmptySince = null;
            }

            autoPauseState = state;
            autoPauseReason = reason;
            autoPauseLastOnlinePlayers = 0;
        }

        private void ResumeAutoPause(string reason, bool force = false)
        {
            if (!autoPauseApplied)
                return;

            autoPauseApplied = false;
            autoPauseEmptySince = null;

            if ((force || Config.AutoResumeOnPlayerJoin) && Game1.paused && !ReadManualPauseFlag() && !singleFarmhandMenuPauseApplied)
            {
                Game1.paused = false;
                hasTriggeredSleep = false;
                SetLastAutomation("autoPause", true, $"resumed:{reason}");
                this.Monitor.Log($"[自动暂停] {reason}，游戏时间已自动恢复", LogLevel.Info);
            }
        }

        private bool ReadManualPauseFlag()
        {
            try
            {
                if (string.IsNullOrWhiteSpace(Config.ManualPauseFile) || !File.Exists(Config.ManualPauseFile))
                    return false;

                string raw = File.ReadAllText(Config.ManualPauseFile).Trim();
                if (raw.Equals("true", StringComparison.OrdinalIgnoreCase))
                    return true;

                return Regex.IsMatch(raw, "\"enabled\"\\s*:\\s*true", RegexOptions.IgnoreCase);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"读取手动暂停状态失败: {ex.Message}", LogLevel.Warn);
                return false;
            }
        }

        private void WriteManualPauseFlag(bool enabled, string reason)
        {
            if (string.IsNullOrWhiteSpace(Config.ManualPauseFile))
                return;

            string dir = Path.GetDirectoryName(Config.ManualPauseFile);
            if (!string.IsNullOrWhiteSpace(dir))
                Directory.CreateDirectory(dir);

            string json = "{\n" +
                $"  \"enabled\": {(enabled ? "true" : "false")},\n" +
                $"  \"updatedAt\": \"{DateTime.UtcNow:O}\",\n" +
                "  \"updatedBy\": \"smapi-console\",\n" +
                $"  \"reason\": \"{reason.Replace("\"", "'")}\"\n" +
                "}\n";
            File.WriteAllText(Config.ManualPauseFile, json);
        }

        private void ApplyManualPauseFlag()
        {
            if (!Context.IsWorldReady)
                return;

            bool requested = ReadManualPauseFlag();
            if (requested)
            {
                if (!Game1.paused)
                {
                    Game1.paused = true;
                    SetLastAutomation("manualPause", true, "enabled");
                    this.Monitor.Log("面板手动暂停已开启：游戏内时间已冻结", LogLevel.Info);
                }
                else if (!manualPauseLastRequested)
                {
                    this.Monitor.Log("面板手动暂停已开启：游戏已经处于暂停状态", LogLevel.Info);
                }
                manualPauseApplied = true;
            }
            else
            {
                if (manualPauseApplied && Game1.paused && !autoPauseApplied && !singleFarmhandMenuPauseApplied)
                {
                    Game1.paused = false;
                    SetLastAutomation("manualPause", true, "disabled");
                    this.Monitor.Log("面板手动暂停已关闭：游戏内时间继续流动", LogLevel.Info);
                }
                else if (manualPauseApplied && (autoPauseApplied || singleFarmhandMenuPauseApplied))
                {
                    SetLastAutomation("manualPause", true, "disabled_other_pause_still_active");
                    this.Monitor.Log("面板手动暂停已关闭，但其他自动暂停仍在保持游戏时间冻结", LogLevel.Info);
                }
                manualPauseApplied = false;
            }

            manualPauseLastRequested = requested;
        }

        private void SetLastAutomation(string type, bool success, string message)
        {
            lastAutomationType = type ?? "";
            lastAutomationSuccess = success;
            lastAutomationMessage = message ?? "";
            lastAutomationAt = DateTime.UtcNow;
        }

        private string JsonEscape(string value)
        {
            if (string.IsNullOrEmpty(value))
                return "";

            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }

        private string JsonString(string value)
        {
            return $"\"{JsonEscape(value)}\"";
        }

        private string JsonBool(bool value)
        {
            return value ? "true" : "false";
        }

        private void WriteGameStateBridge()
        {
            if (string.IsNullOrWhiteSpace(Config.GameStateFile))
                return;

            try
            {
                string dir = Path.GetDirectoryName(Config.GameStateFile);
                if (!string.IsNullOrWhiteSpace(dir))
                    Directory.CreateDirectory(dir);

                bool worldReady = Context.IsWorldReady;
                bool isServer = worldReady && Game1.IsServer;
                bool multiplayerReady = worldReady && isServer && Game1.server != null;
                bool saving = worldReady && Game1.game1 != null && Game1.game1.IsSaving;
                bool blockedByMenu = worldReady && Game1.activeClickableMenu != null;
                bool blockedByEvent = worldReady && Game1.CurrentEvent != null && !Game1.CurrentEvent.skippable;
                bool joinable = worldReady && isServer && multiplayerReady && !saving && !blockedByEvent && !blockedByMenu;
                string joinableReason = "ready";

                if (!worldReady)
                    joinableReason = "world_not_ready";
                else if (!isServer)
                    joinableReason = "not_main_server";
                else if (!multiplayerReady)
                    joinableReason = "multiplayer_not_initialized";
                else if (saving)
                    joinableReason = "saving";
                else if (blockedByEvent)
                    joinableReason = "blocking_event";
                else if (blockedByMenu)
                    joinableReason = "menu_open";

                var players = worldReady
                    ? Game1.getOnlineFarmers().ToList()
                    : new System.Collections.Generic.List<Farmer>();

                string playersJson = string.Join(",", players.Select(f =>
                {
                    string location = f.currentLocation?.Name ?? "";
                    bool isHost = worldReady && f.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID;
                    return "{" +
                        $"\"name\":{JsonString(f.Name)}," +
                        $"\"id\":{JsonString(f.UniqueMultiplayerID.ToString())}," +
                        $"\"isHost\":{JsonBool(isHost)}," +
                        $"\"location\":{JsonString(location)}," +
                        $"\"inBed\":{JsonBool(f.isInBed.Value)}" +
                        "}";
                }));

                string activeMenu = worldReady ? (Game1.activeClickableMenu?.GetType().Name ?? "") : "";
                string currentEventId = worldReady && Game1.CurrentEvent != null ? (Game1.CurrentEvent.id ?? "") : "";
                bool currentEventSkippable = worldReady && Game1.CurrentEvent != null && Game1.CurrentEvent.skippable;
                bool saveOnNewDay = worldReady && Game1.saveOnNewDay;
                bool passoutWindow = worldReady && Game1.timeOfDay >= 2600;
                string festivalId = "";
                string festivalLocation = "";
                int festivalStartTime = 0;
                int festivalEndTime = 0;
                bool hasFestival = worldReady && TryGetTodaysFestivalInfo(out festivalId, out festivalLocation, out festivalStartTime, out festivalEndTime);
                bool festivalOpen = hasFestival && Game1.timeOfDay >= festivalStartTime && Game1.timeOfDay <= festivalEndTime;
                string festivalJson = hasFestival
                    ? "{" +
                        $"\"id\":{JsonString(festivalId)}," +
                        $"\"location\":{JsonString(festivalLocation)}," +
                        $"\"startTime\":{festivalStartTime}," +
                        $"\"endTime\":{festivalEndTime}," +
                        $"\"open\":{JsonBool(festivalOpen)}," +
                        $"\"proxyEnabled\":{JsonBool(Config.EnableFestivalProxyTrigger)}," +
                        $"\"lastProxyFestivalId\":{JsonString(lastFestivalProxyFestivalId)}," +
                        $"\"lastProxyBy\":{JsonString(lastFestivalProxyBy)}," +
                        $"\"lastProxyAt\":{(lastFestivalProxyAt.HasValue ? JsonString(lastFestivalProxyAt.Value.ToString("O")) : "null")}" +
                        "}"
                    : "null";
                string lastAutomationJson = lastAutomationAt.HasValue
                    ? "{" +
                        $"\"type\":{JsonString(lastAutomationType)}," +
                        $"\"success\":{JsonBool(lastAutomationSuccess)}," +
                        $"\"message\":{JsonString(lastAutomationMessage)}," +
                        $"\"at\":{JsonString(lastAutomationAt.Value.ToString("O"))}" +
                        "}"
                    : "null";
                double autoPauseEmptySeconds = autoPauseEmptySince.HasValue
                    ? Math.Max(0, (DateTime.UtcNow - autoPauseEmptySince.Value).TotalSeconds)
                    : 0;
                bool autoPauseEnabled = IsAutoPauseEnabled();
                string autoPauseJson = "{" +
                    $"\"enabled\":{JsonBool(autoPauseEnabled)}," +
                    $"\"configuredEnabled\":{JsonBool(Config.PauseWhenEmpty)}," +
                    $"\"applied\":{JsonBool(autoPauseApplied)}," +
                    $"\"state\":{JsonString(autoPauseState)}," +
                    $"\"reason\":{JsonString(autoPauseReason)}," +
                    $"\"onlinePlayers\":{autoPauseLastOnlinePlayers}," +
                    $"\"emptySeconds\":{Math.Floor(autoPauseEmptySeconds)}," +
                    $"\"delaySeconds\":{Math.Max(0, Config.EmptyPauseDelaySeconds)}," +
                    $"\"startupGraceSeconds\":{Math.Max(0, Config.AutoPauseStartupGraceSeconds)}," +
                    $"\"autoResumeOnPlayerJoin\":{JsonBool(Config.AutoResumeOnPlayerJoin)}," +
                    $"\"controlFile\":{JsonString(Config.AutoPauseControlFile ?? "")}," +
                    $"\"controlError\":{JsonString(autoPauseControlError)}," +
                    $"\"emptySince\":{(autoPauseEmptySince.HasValue ? JsonString(autoPauseEmptySince.Value.ToString("O")) : "null")}" +
                    "}";
                bool singleMenuClientFresh = false;
                if (singleFarmhandMenuPausePlayerId != 0
                    && clientBackpackStates.TryGetValue(singleFarmhandMenuPausePlayerId, out ClientBackpackState menuState))
                {
                    singleMenuClientFresh = (DateTime.UtcNow - menuState.UpdatedAt).TotalSeconds
                        <= Math.Max(3, Config.SingleFarmhandMenuPauseTimeoutSeconds);
                }
                string singleFarmhandMenuPauseJson = "{" +
                    $"\"enabled\":{JsonBool(Config.PauseWhenSingleFarmhandOpensMenu)}," +
                    $"\"applied\":{JsonBool(singleFarmhandMenuPauseApplied)}," +
                    $"\"state\":{JsonString(singleFarmhandMenuPauseState)}," +
                    $"\"reason\":{JsonString(singleFarmhandMenuPauseReason)}," +
                    $"\"onlineFarmhands\":{CountOnlineFarmhands()}," +
                    $"\"playerId\":{JsonString(singleFarmhandMenuPausePlayerId == 0 ? "" : singleFarmhandMenuPausePlayerId.ToString())}," +
                    $"\"playerName\":{JsonString(singleFarmhandMenuPausePlayerName)}," +
                    $"\"menuType\":{JsonString(singleFarmhandMenuPauseMenuType)}," +
                    $"\"clientFresh\":{JsonBool(singleMenuClientFresh)}," +
                    $"\"timeoutSeconds\":{Math.Max(3, Config.SingleFarmhandMenuPauseTimeoutSeconds)}," +
                    $"\"clientModId\":{JsonString(ClientPauseReporterModId)}" +
                    "}";

                var json = new StringBuilder();
                json.Append("{\n");
                json.Append($"  \"updatedAt\": {JsonString(DateTime.UtcNow.ToString("O"))},\n");
                json.Append($"  \"worldReady\": {JsonBool(worldReady)},\n");
                json.Append($"  \"isMainPlayer\": {JsonBool(Context.IsMainPlayer)},\n");
                json.Append($"  \"isServer\": {JsonBool(isServer)},\n");
                json.Append($"  \"isMultiplayer\": {JsonBool(worldReady && Game1.IsMultiplayer)},\n");
                json.Append($"  \"multiplayerReady\": {JsonBool(multiplayerReady)},\n");
                json.Append($"  \"joinable\": {JsonBool(joinable)},\n");
                json.Append($"  \"joinableReason\": {JsonString(joinableReason)},\n");
                json.Append($"  \"saveName\": {JsonString(worldReady ? (Game1.player?.farmName.Value ?? "") : "")},\n");
                json.Append($"  \"season\": {JsonString(worldReady ? Game1.currentSeason : "")},\n");
                json.Append($"  \"day\": {(worldReady ? Game1.dayOfMonth : 0)},\n");
                json.Append($"  \"year\": {(worldReady ? Game1.year : 0)},\n");
                json.Append($"  \"timeOfDay\": {(worldReady ? Game1.timeOfDay : 0)},\n");
                json.Append($"  \"paused\": {JsonBool(worldReady && Game1.paused)},\n");
                json.Append($"  \"saving\": {JsonBool(saving)},\n");
                json.Append($"  \"saveOnNewDay\": {JsonBool(saveOnNewDay)},\n");
                json.Append($"  \"passoutWindow\": {JsonBool(passoutWindow)},\n");
                json.Append($"  \"activeMenu\": {JsonString(activeMenu)},\n");
                json.Append($"  \"currentEvent\": {(string.IsNullOrWhiteSpace(currentEventId) ? "null" : "{" + $"\"id\":{JsonString(currentEventId)},\"skippable\":{JsonBool(currentEventSkippable)}" + "}")},\n");
                json.Append($"  \"festival\": {festivalJson},\n");
                json.Append($"  \"hostHidden\": {JsonBool(isHostHidden)},\n");
                json.Append($"  \"sleepInProgress\": {JsonBool(isSleepInProgress)},\n");
                json.Append($"  \"autoPause\": {autoPauseJson},\n");
                json.Append($"  \"singleFarmhandMenuPause\": {singleFarmhandMenuPauseJson},\n");
                json.Append($"  \"onlinePlayers\": [{playersJson}],\n");
                json.Append($"  \"lastAutomation\": {lastAutomationJson}\n");
                json.Append("}\n");

                string tmpPath = $"{Config.GameStateFile}.tmp-{Environment.ProcessId}";
                File.WriteAllText(tmpPath, json.ToString());
                File.Move(tmpPath, Config.GameStateFile, true);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"写入游戏状态桥失败: {ex.Message}", LogLevel.Debug);
            }
        }

        /// <summary>
        /// v1.2.2: 借鉴Always On Server的实现 - 使用startSleep()方法
        /// 关键发现：startSleep是Location对象的方法，不是Farmer的方法！
        /// </summary>
        private void CheckAndAutoSleep()
        {
            if (!Context.IsMainPlayer || !Config.InstantSleepWhenReady)
                return;

            if (!Context.IsWorldReady || hasTriggeredSleep || needToSleep)
                return;

            // 跳过菜单检查
            if (Game1.activeClickableMenu != null)
            {
                LogDebug($"[睡眠检查] 跳过 - 有活动菜单: {Game1.activeClickableMenu.GetType().Name}");
                return;
            }

            var onlineFarmhands = Game1.getOnlineFarmers()
                .Where(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .ToList();

            if (onlineFarmhands.Count == 0)
                return;

            try
            {
                // 检查所有玩家是否真正上床睡觉
                bool allFarmhandsInBed = onlineFarmhands.All(farmer =>
                    farmer.isInBed.Value && farmer.timeWentToBed.Value > 0);

                if (!allFarmhandsInBed)
                    return;

                // 所有玩家都在床上了，触发睡眠
                this.Monitor.Log($"检测到所有 {onlineFarmhands.Count} 名玩家已上床，准备让主机睡觉", LogLevel.Info);

                // v1.2.2: 使用Always On Server的方法
                GoToBed();

                hasTriggeredSleep = true;
                this.Monitor.Log("✓ 主机已进入睡眠流程", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"触发睡眠时出错: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"堆栈: {ex.StackTrace}", LogLevel.Debug);
            }
        }

        /// <summary>
        /// v1.3.2: 修复Desert唤醒问题 - 确保房主在FarmHouse醒来
        /// 关键：设置lastSleepLocation和lastSleepPoint确保正确唤醒
        /// </summary>
        private void GoToBed()
        {
            try
            {
                // 获取床的坐标
                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9;
                    bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21;
                    bedY = 4;
                }
                else
                {
                    bedX = 27;
                    bedY = 13;
                }

                this.Monitor.Log($"传送主机到FarmHouse床上 ({bedX}, {bedY})", LogLevel.Info);

                // 预先标记事件
                PreventSleepEvents();

                // 设置睡眠进行标志
                isSleepInProgress = true;

                // 传送到FarmHouse
                Game1.warpFarmer("FarmHouse", bedX, bedY, false);

                // 调用startSleep
                var startSleepMethod = this.Helper.Reflection.GetMethod(Game1.currentLocation, "startSleep");
                startSleepMethod.Invoke();

                // v1.3.3: CRITICAL FIX - 在startSleep()之后设置睡眠位置
                // startSleep()内部可能会设置lastSleepLocation，所以必须在它之后覆盖
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);

                this.Monitor.Log($"✓ startSleep()已调用", LogLevel.Info);
                this.Monitor.Log($"✓ 设置睡眠唤醒位置: FarmHouse ({bedX}, {bedY})", LogLevel.Info);
                SetLastAutomation("autoSleep", true, "startSleep invoked");

                Game1.displayHUD = true;
            }
            catch (Exception ex)
            {
                SetLastAutomation("autoSleep", false, ex.Message);
                this.Monitor.Log($"GoToBed出错: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"堆栈: {ex.StackTrace}", LogLevel.Error);
            }
        }

        /// <summary>
        /// 预先标记常见的睡眠特殊事件为"已看过"，防止它们打断睡眠流程
        /// </summary>
        private void PreventSleepEvents()
        {
            try
            {
                // 地震事件 (Spring 3) - 这是最常见导致问题的事件
                if (!Game1.player.eventsSeen.Contains("60367"))
                {
                    Game1.player.eventsSeen.Add("60367");
                    this.Monitor.Log("已预防地震事件 (60367)", LogLevel.Info);
                }

                // 其他常见睡眠事件ID列表
                var commonSleepEvents = new[]
                {
                    "558291",  // Marnie的信件事件
                    "831125",  // 升级提示
                    "502261",  // 梦境事件
                    "26",      // Shane 1心事件
                    "27",      // Shane 2心事件
                    "733330",  // 其他睡眠事件
                };

                foreach (var eventId in commonSleepEvents)
                {
                    if (!Game1.player.eventsSeen.Contains(eventId))
                    {
                        Game1.player.eventsSeen.Add(eventId);
                        this.Monitor.Log($"已预防睡眠事件 ({eventId})", LogLevel.Debug);
                    }
                }

                this.Monitor.Log("✓ 特殊事件预防完成", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"PreventSleepEvents出错: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>
        /// 准备睡眠：设置床的位置信息（不传送房主，避免黑屏延迟）
        /// </summary>
        private void PrepareToBed()
        {
            try
            {
                // 获取房主的homeLocation
                string homeLocationName = Game1.player.homeLocation.Value;
                this.Monitor.Log($"房主的homeLocation: {homeLocationName}", LogLevel.Info);

                // 获取床的坐标（根据房屋升级等级）
                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                this.Monitor.Log($"房屋升级等级: {houseUpgradeLevel}", LogLevel.Info);

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9;
                    bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21;
                    bedY = 4;
                }
                else
                {
                    bedX = 27;
                    bedY = 13;
                }

                // 不传送房主，只设置床的位置信息
                // 这样可以避免传送导致的黑屏延迟
                this.Monitor.Log($"设置床位置: {homeLocationName} ({bedX}, {bedY})", LogLevel.Info);
                Game1.player.mostRecentBed = new Microsoft.Xna.Framework.Vector2(bedX * 64, bedY * 64);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"PrepareToBed出错: {ex.Message}", LogLevel.Error);
            }
        }

        /// <summary>
        /// 执行睡眠：v1.1.5 新方案 - 传送到床上并模拟点击床的行为
        /// v1.1.4失败原因：只是传送和设置状态，但没有触发床的互动逻辑
        /// 新方案：传送 → 查找床对象 → 触发床的checkAction
        /// </summary>
        private void ExecuteSleep()
        {
            try
            {
                this.Monitor.Log("=== v1.1.5: 开始新的睡眠方案 ===", LogLevel.Info);

                // 获取房主的homeLocation和床坐标
                string homeLocationName = Game1.player.homeLocation.Value;
                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9;
                    bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21;
                    bedY = 4;
                }
                else
                {
                    bedX = 27;
                    bedY = 13;
                }

                this.Monitor.Log($"房屋等级 {houseUpgradeLevel}, 床坐标: ({bedX}, {bedY})", LogLevel.Info);

                // CRITICAL FIX: 预先标记所有常见特殊事件为"已看过"，避免地震等事件干扰
                PreventSleepEvents();

                // 关闭所有活动菜单
                if (Game1.activeClickableMenu != null)
                {
                    this.Monitor.Log($"关闭菜单: {Game1.activeClickableMenu.GetType().Name}", LogLevel.Debug);
                    Game1.activeClickableMenu = null;
                }

                // 第一步：将房主传送到FarmHouse的床旁边（不是床上，而是床前）
                this.Monitor.Log($"传送房主从 {Game1.currentLocation.Name} 到 {homeLocationName}", LogLevel.Info);
                Game1.warpFarmer(homeLocationName, bedX, bedY, false);

                // 传送后立即在下一个tick尝试查找床对象并模拟点击
                // 使用Helper的事件来延迟执行
                void HandleAfterWarp(object s, EventArgs ev)
                {
                    try
                    {
                        this.Monitor.Log("传送完成，开始查找床对象...", LogLevel.Debug);

                        var farmHouse = Game1.currentLocation as StardewValley.Locations.FarmHouse;
                        if (farmHouse != null)
                        {
                            // 查找床对象（BedFurniture）
                            var bed = farmHouse.furniture.FirstOrDefault(f =>
                                f is StardewValley.Objects.BedFurniture &&
                                f.TileLocation.X == bedX &&
                                f.TileLocation.Y == bedY);

                            if (bed != null)
                            {
                                this.Monitor.Log($"找到床对象: {bed.GetType().Name} at ({bedX}, {bedY})", LogLevel.Info);

                                // 模拟点击床
                                var bedFurniture = bed as StardewValley.Objects.BedFurniture;
                                if (bedFurniture != null)
                                {
                                    // 调用床的checkForAction方法，模拟玩家点击床
                                    bool clicked = bedFurniture.checkForAction(Game1.player, false);
                                    this.Monitor.Log($"模拟点击床: {clicked}", LogLevel.Info);
                                }
                            }
                            else
                            {
                                this.Monitor.Log($"× 未找到床对象 at ({bedX}, {bedY})", LogLevel.Warn);
                                this.Monitor.Log($"FarmHouse家具数量: {farmHouse.furniture.Count}", LogLevel.Debug);

                                // 备用方案：直接设置睡眠状态
                                Game1.player.isInBed.Value = true;
                                Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                                Game1.player.lastSleepLocation.Value = homeLocationName;
                                Game1.player.lastSleepPoint.Value = new Microsoft.Xna.Framework.Point(bedX, bedY);
                                this.Monitor.Log("使用备用方案：直接设置睡眠状态", LogLevel.Warn);
                            }
                        }
                        else
                        {
                            this.Monitor.Log("× 当前位置不是FarmHouse", LogLevel.Error);
                        }

                        // 设置睡眠进行标志
                        isSleepInProgress = true;

                        // 取消订阅事件
                        this.Helper.Events.GameLoop.UpdateTicked -= HandleAfterWarp;
                    }
                    catch (Exception ex)
                    {
                        this.Monitor.Log($"HandleAfterWarp出错: {ex.Message}", LogLevel.Error);
                        this.Monitor.Log($"堆栈: {ex.StackTrace}", LogLevel.Error);
                        this.Helper.Events.GameLoop.UpdateTicked -= HandleAfterWarp;
                    }
                }

                // 订阅一次性事件，在下一个tick执行
                this.Helper.Events.GameLoop.UpdateTicked += HandleAfterWarp;

                this.Monitor.Log("✓ 传送已触发，等待下一个tick执行点击床逻辑...", LogLevel.Info);
                SetLastAutomation("autoSleep", true, "warp to bed scheduled");
            }
            catch (Exception ex)
            {
                SetLastAutomation("autoSleep", false, ex.Message);
                this.Monitor.Log($"ExecuteSleep出错: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"堆栈: {ex.StackTrace}", LogLevel.Error);
            }
        }

        private void ShowHost()
        {
            if (!Context.IsMainPlayer)
                return;
            Game1.warpFarmer("Farm", 64, 15, false);
            Game1.player.temporarilyInvincible = false;
            isHostHidden = false;
            this.Monitor.Log("房主已显示在农场", LogLevel.Debug);
        }

        private void RegisterCommands()
        {
            this.Helper.ConsoleCommands.Add("hidehost", "立即隐藏房主", OnCommand_HideHost);
            this.Helper.ConsoleCommands.Add("showhost", "显示房主", OnCommand_ShowHost);
            this.Helper.ConsoleCommands.Add("togglehost", "切换房主可见性", OnCommand_ToggleHost);
            this.Helper.ConsoleCommands.Add("autohide_status", "显示模组状态", OnCommand_Status);
            this.Helper.ConsoleCommands.Add("autohide_reload", "重新加载配置", OnCommand_Reload);
            this.Helper.ConsoleCommands.Add("autohide_pause_time", "手动暂停/恢复游戏时间: autohide_pause_time on|off|toggle|status", OnCommand_PauseTime);
            this.Helper.ConsoleCommands.Add("autohide_auto_pause", "自动空服暂停: autohide_auto_pause on|off|status", OnCommand_AutoPause);
        }

        private void OnCommand_HideHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("只有房主可以执行此命令", LogLevel.Error);
                return;
            }
            HideHost();
            this.Monitor.Log("房主已隐藏", LogLevel.Info);
        }

        private void OnCommand_ShowHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("只有房主可以执行此命令", LogLevel.Error);
                return;
            }
            ShowHost();
            this.Monitor.Log("房主已显示", LogLevel.Info);
        }

        private void OnCommand_ToggleHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("只有房主可以执行此命令", LogLevel.Error);
                return;
            }
            if (isHostHidden)
                ShowHost();
            else
                HideHost();
        }

        private void OnCommand_Status(string command, string[] args)
        {
            this.Monitor.Log("=== AutoHideHost 模组状态 ===", LogLevel.Info);
            this.Monitor.Log($"模组版本: {this.ModManifest.Version}", LogLevel.Info);
            this.Monitor.Log($"启用状态: {Config.Enabled}", LogLevel.Info);
            this.Monitor.Log($"房主隐藏: {isHostHidden}", LogLevel.Info);
            if (Context.IsWorldReady)
            {
                // 修复：显示真实在线玩家数
                int onlinePlayers = Game1.getOnlineFarmers()
                    .Count(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID);
                int totalCabins = Game1.otherFarmers.Count();
                this.Monitor.Log($"在线玩家数: {onlinePlayers} (总小屋: {totalCabins})", LogLevel.Info);
                this.Monitor.Log($"游戏暂停: {Game1.paused}", LogLevel.Info);
            }
            this.Monitor.Log($"隐藏方式: {Config.HideMethod}", LogLevel.Info);
            this.Monitor.Log($"自动暂停: {IsAutoPauseEnabled()} (配置默认={Config.PauseWhenEmpty}, 状态={autoPauseState}, 原因={autoPauseReason}, 延迟={Config.EmptyPauseDelaySeconds}s, 启动保护={Config.AutoPauseStartupGraceSeconds}s, 自动恢复={Config.AutoResumeOnPlayerJoin})", LogLevel.Info);
            if (autoPauseEmptySince.HasValue)
            {
                this.Monitor.Log($"空服等待: {Math.Floor((DateTime.UtcNow - autoPauseEmptySince.Value).TotalSeconds)} 秒", LogLevel.Info);
            }
            this.Monitor.Log($"单人背包暂停: {Config.PauseWhenSingleFarmhandOpensMenu} (状态={singleFarmhandMenuPauseState}, 原因={singleFarmhandMenuPauseReason}, 玩家={singleFarmhandMenuPausePlayerName}, 菜单={singleFarmhandMenuPauseMenuType})", LogLevel.Info);
            this.Monitor.Log($"面板手动暂停: {ReadManualPauseFlag()} ({Config.ManualPauseFile})", LogLevel.Info);
            this.Monitor.Log($"即时睡眠: {Config.InstantSleepWhenReady}", LogLevel.Info);
        }

        private void OnCommand_AutoPause(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("只有房主可以执行此命令", LogLevel.Error);
                return;
            }

            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "status";
            if (mode == "status")
            {
                this.Monitor.Log($"自动暂停: {IsAutoPauseEnabled()} (配置默认={Config.PauseWhenEmpty}); 已接管暂停: {autoPauseApplied}; 状态: {autoPauseState}; 原因: {autoPauseReason}", LogLevel.Info);
                this.Monitor.Log($"在线玩家: {CountOnlineFarmhands()}; 延迟: {Config.EmptyPauseDelaySeconds}s; 启动保护: {Config.AutoPauseStartupGraceSeconds}s; 玩家加入恢复: {Config.AutoResumeOnPlayerJoin}", LogLevel.Info);
                if (!string.IsNullOrWhiteSpace(autoPauseControlError))
                    this.Monitor.Log($"自动暂停控制文件读取异常: {autoPauseControlError}", LogLevel.Warn);
                return;
            }

            if (mode == "on" || mode == "true" || mode == "enable")
            {
                Config.PauseWhenEmpty = true;
                this.Helper.WriteConfig(Config);
                WriteAutoPauseControlFlag(true, "console_enabled");
                CheckAndAutoPause();
                this.Monitor.Log("自动空服暂停已开启", LogLevel.Info);
                return;
            }

            if (mode == "off" || mode == "false" || mode == "disable")
            {
                Config.PauseWhenEmpty = false;
                this.Helper.WriteConfig(Config);
                WriteAutoPauseControlFlag(false, "console_disabled");
                ResumeAutoPause("console_disabled", force: true);
                autoPauseState = "disabled";
                autoPauseReason = "disabled_by_console";
                this.Monitor.Log("自动空服暂停已关闭", LogLevel.Info);
                return;
            }

            this.Monitor.Log("用法: autohide_auto_pause on|off|status", LogLevel.Info);
        }

        private void OnCommand_PauseTime(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("只有房主可以执行此命令", LogLevel.Error);
                return;
            }

            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "status";
            bool current = ReadManualPauseFlag();

            if (mode == "status")
            {
                this.Monitor.Log($"面板手动暂停: {current}; 游戏暂停: {Game1.paused}", LogLevel.Info);
                return;
            }

            bool next;
            if (mode == "on" || mode == "true" || mode == "pause")
                next = true;
            else if (mode == "off" || mode == "false" || mode == "resume")
                next = false;
            else if (mode == "toggle")
                next = !current;
            else
            {
                this.Monitor.Log("用法: autohide_pause_time on|off|toggle|status", LogLevel.Info);
                return;
            }

            WriteManualPauseFlag(next, $"console:{mode}");
            ApplyManualPauseFlag();
            this.Monitor.Log(next ? "已开启手动暂停游戏时间" : "已关闭手动暂停游戏时间", LogLevel.Info);
        }

        private void OnCommand_Reload(string command, string[] args)
        {
            this.Config = this.Helper.ReadConfig<ModConfig>();
            this.Monitor.Log("配置文件已重新加载", LogLevel.Info);
            OnCommand_Status(command, args);
        }

        /// <summary>
        /// v1.4.0: 获取当前活跃的ReadyCheck名称（如"sleep"）
        /// </summary>
        private string GetActiveReadyCheckName()
        {
            try
            {
                // 检查是否有ReadyCheckDialog打开
                if (Game1.activeClickableMenu != null &&
                    Game1.activeClickableMenu.GetType().Name == "ReadyCheckDialog")
                {
                    // 尝试通过反射获取readyCheckId字段
                    var idField = this.Helper.Reflection.GetField<string>(
                        Game1.activeClickableMenu, "checkId", required: false);

                    if (idField != null)
                    {
                        return idField.GetValue();
                    }

                    // 回退：尝试其他可能的字段名
                    var altField = this.Helper.Reflection.GetField<string>(
                        Game1.activeClickableMenu, "readyCheckId", required: false);

                    if (altField != null)
                    {
                        return altField.GetValue();
                    }

                    // 默认返回"sleep"（最常见情况）
                    return "sleep";
                }

                return null;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"获取ReadyCheck名称失败: {ex.Message}", LogLevel.Trace);
                return null;
            }
        }

        /// <summary>
        /// v1.4.0: 回退方案 - 通过UI点击ReadyCheckDialog
        /// </summary>
        private void TryClickReadyCheckDialog()
        {
            try
            {
                if (Game1.activeClickableMenu == null ||
                    Game1.activeClickableMenu.GetType().Name != "ReadyCheckDialog")
                {
                    return;
                }

                // 尝试通过反射获取OK按钮
                var okButton = this.Helper.Reflection.GetField<object>(
                    Game1.activeClickableMenu, "okButton", required: false)?.GetValue();

                if (okButton is StardewValley.Menus.ClickableTextureComponent button)
                {
                    // 点击按钮中心
                    Game1.activeClickableMenu.receiveLeftClick(
                        button.bounds.Center.X,
                        button.bounds.Center.Y,
                        true);
                    this.Monitor.Log("✓ ReadyCheckDialog已通过反射点击", LogLevel.Info);
                    handledReadyCheck = true;
                    return;
                }

                // 最后的回退：使用估算的坐标
                Game1.activeClickableMenu.receiveLeftClick(640, 460, true);
                this.Monitor.Log("✓ ReadyCheckDialog已通过坐标点击（回退方案）", LogLevel.Info);
                handledReadyCheck = true;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"点击ReadyCheckDialog失败: {ex.Message}", LogLevel.Error);
            }
        }

        /// <summary>
        /// v1.4.1: 检查并自动启用 Always On Server
        /// </summary>
        private void CheckAndEnableAlwaysOnServer()
        {
            try
            {
                // 检查是否是服务器模式
                if (!Game1.IsServer)
                {
                    this.Monitor.Log("当前不是服务器模式，跳过 Always On Server 检查", LogLevel.Debug);
                    return;
                }

                // 检查 Always On Server 模组是否加载
                var alwaysOnServerMod = this.Helper.ModRegistry.Get("mikko.Always_On_Server");
                if (alwaysOnServerMod == null)
                {
                    this.Monitor.Log("未检测到 Always On Server 模组", LogLevel.Warn);
                    return;
                }

                this.Monitor.Log("检测到 Always On Server 模组已加载", LogLevel.Info);
                this.Monitor.Log("尝试自动启用 Always On Server 的 Server Mode...", LogLevel.Info);

                // 方法1: 尝试通过反射直接设置 IsEnabled 字段
                bool enabledViaReflection = false;
                try
                {
                    // 使用 SMAPI 的 ModRegistry 获取已加载的所有模组
                    var loadedMods = this.Helper.Reflection.GetField<System.Collections.Generic.IDictionary<string, object>>(
                        this.Helper.ModRegistry,
                        "Mods",
                        required: false);

                    if (loadedMods != null)
                    {
                        var modsDict = loadedMods.GetValue();
                        if (modsDict != null && modsDict.ContainsKey("mikko.Always_On_Server"))
                        {
                            var modMetadata = modsDict["mikko.Always_On_Server"];
                            var modField = this.Helper.Reflection.GetProperty<object>(modMetadata, "Mod", required: false);

                            if (modField != null)
                            {
                                var modInstance = modField.GetValue();
                                if (modInstance != null)
                                {
                                    // 直接设置 IsEnabled 字段
                                    var isEnabledField = this.Helper.Reflection.GetField<bool>(modInstance, "IsEnabled", required: false);
                                    if (isEnabledField != null)
                                    {
                                        isEnabledField.SetValue(true);
                                        this.Monitor.Log("✓ 已通过反射启用 Always On Server", LogLevel.Info);

                                        // 添加聊天消息
                                        if (Game1.chatBox != null)
                                        {
                                            Game1.chatBox.addInfoMessage("The Host is in Server Mode!");
                                        }

                                        enabledViaReflection = true;
                                    }
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"反射方法失败: {ex.Message}", LogLevel.Debug);
                }

                // 方法2: 如果反射失败，尝试模拟按键 F9
                if (!enabledViaReflection)
                {
                    this.Monitor.Log("反射方法不可用，尝试模拟按键启用...", LogLevel.Info);
                    try
                    {
                        // 模拟 F9 按键
                        var keyboardState = Microsoft.Xna.Framework.Input.Keyboard.GetState();
                        this.Helper.Reflection.GetMethod(Game1.game1, "checkForEscapeKeys").Invoke();

                        // 给予一些延迟让按键处理完成
                        System.Threading.Thread.Sleep(100);

                        this.Monitor.Log("已尝试模拟按键启用 Always On Server", LogLevel.Info);
                        enabledViaReflection = true;
                    }
                    catch (Exception ex)
                    {
                        this.Monitor.Log($"模拟按键失败: {ex.Message}", LogLevel.Debug);
                    }
                }

                // 如果所有方法都失败，显示手动启用说明
                if (!enabledViaReflection)
                {
                    ShowManualEnableInstructions();
                }
                else
                {
                    this.Monitor.Log("✓ 自动暂停功能已启用（没有玩家时暂停，有玩家时继续）", LogLevel.Info);
                }
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"启用 Always On Server 时出错: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"堆栈: {ex.StackTrace}", LogLevel.Debug);
            }
        }

        /// <summary>
        /// v1.1.2: 显示手动启用 Always On Server 的说明
        /// </summary>
        private void ShowManualEnableInstructions()
        {
            this.Monitor.Log("", LogLevel.Info);
            this.Monitor.Log("==========================================", LogLevel.Info);
            this.Monitor.Log("⚠ MANUAL ACTION REQUIRED / 需要手动操作", LogLevel.Info);
            this.Monitor.Log("==========================================", LogLevel.Info);
            this.Monitor.Log("", LogLevel.Info);
            this.Monitor.Log("请手动启用 Always On Server 以使用自动暂停功能：", LogLevel.Info);
            this.Monitor.Log("Please manually enable Always On Server for auto-pause:", LogLevel.Info);
            this.Monitor.Log("", LogLevel.Info);
            this.Monitor.Log("方法1 / Method 1: 通过 VNC 连接，按 F9 键", LogLevel.Info);
            this.Monitor.Log("                  Connect via VNC, press F9 key", LogLevel.Info);
            this.Monitor.Log("方法2 / Method 2: 在游戏内控制台输入: server", LogLevel.Info);
            this.Monitor.Log("                  In-game console, type: server", LogLevel.Info);
            this.Monitor.Log("", LogLevel.Info);
            this.Monitor.Log("启用后游戏将在没有玩家时自动暂停", LogLevel.Info);
            this.Monitor.Log("Game will auto-pause when no players are online", LogLevel.Info);
            this.Monitor.Log("==========================================", LogLevel.Info);
            this.Monitor.Log("", LogLevel.Info);
        }

        private bool TryGetTodaysFestivalInfo(out string festivalId, out string locationName, out int startTime, out int endTime)
        {
            festivalId = "";
            locationName = "";
            startTime = 0;
            endTime = 0;

            if (!Context.IsWorldReady || !Utility.isFestivalDay())
                return false;

            festivalId = $"{Game1.currentSeason}{Game1.dayOfMonth}";

            try
            {
                var method = typeof(StardewValley.Event)
                    .GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
                    .FirstOrDefault(m => m.Name == "tryToLoadFestivalData" && m.GetParameters().Length == 6);

                if (method == null)
                    return false;

                object[] args = { festivalId, null, null, null, 0, 0 };
                bool loaded = method.Invoke(null, args) is bool result && result;
                if (!loaded)
                    return false;

                locationName = args[3] as string ?? "";
                startTime = args[4] is int start ? start : 0;
                endTime = args[5] is int end ? end : 0;

                return !string.IsNullOrWhiteSpace(locationName);
            }
            catch (Exception ex)
            {
                LogDebug($"[FestivalProxy] Failed to read festival info: {ex.Message}");
                return false;
            }
        }

        private bool TryLoadFestivalEvent(string festivalId, out StardewValley.Event festivalEvent)
        {
            festivalEvent = null;

            try
            {
                var method = typeof(StardewValley.Event)
                    .GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
                    .FirstOrDefault(m => m.Name == "tryToLoadFestival" && m.GetParameters().Length == 2);

                if (method == null)
                    return false;

                object[] args = { festivalId, null };
                bool loaded = method.Invoke(null, args) is bool result && result;
                festivalEvent = args[1] as StardewValley.Event;
                return loaded && festivalEvent != null;
            }
            catch (Exception ex)
            {
                LogDebug($"[FestivalProxy] Failed to load festival event {festivalId}: {ex.Message}");
                return false;
            }
        }

        private bool IsFestivalLocationMatch(GameLocation location, string festivalLocation, string festivalId)
        {
            string locationName = location?.Name ?? "";
            if (string.IsNullOrWhiteSpace(locationName) || string.IsNullOrWhiteSpace(festivalLocation))
                return false;

            if (locationName.Equals(festivalLocation, StringComparison.OrdinalIgnoreCase))
                return true;

            if (locationName.StartsWith($"{festivalLocation}-", StringComparison.OrdinalIgnoreCase))
                return true;

            return location != null
                && location.IsTemporary
                && (locationName.IndexOf(festivalId, StringComparison.OrdinalIgnoreCase) >= 0
                    || locationName.IndexOf(festivalLocation, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private void TryTriggerFestivalProxy(WarpedEventArgs e)
        {
            if (!Config.EnableFestivalProxyTrigger || !Context.IsWorldReady || e == null || e.Player == null || e.IsLocalPlayer)
                return;

            if (Game1.player == null || e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
                return;

            if (Game1.CurrentEvent != null || isSleepInProgress || hasTriggeredSleep || needToSleep)
                return;

            if (!TryGetTodaysFestivalInfo(out string festivalId, out string festivalLocation, out int startTime, out int endTime))
                return;

            if (Game1.timeOfDay < startTime || Game1.timeOfDay > endTime)
                return;

            if (!IsFestivalLocationMatch(e.NewLocation, festivalLocation, festivalId))
                return;

            string proxyKey = $"{festivalId}:{Game1.year}:{Game1.dayOfMonth}:{festivalLocation}";
            int cooldownSeconds = Math.Max(5, Config.FestivalProxyCooldownSeconds);
            if (lastFestivalProxyAt.HasValue
                && lastFestivalProxyKey == proxyKey
                && (DateTime.UtcNow - lastFestivalProxyAt.Value).TotalSeconds < cooldownSeconds)
            {
                LogDebug($"[FestivalProxy] Cooldown active for {proxyKey}");
                return;
            }

            Point tile = e.Player.TilePoint;
            int x = tile.X;
            int y = tile.Y;
            if (x <= 0 && y <= 0)
            {
                Utility.getDefaultWarpLocation(festivalLocation, ref x, ref y);
            }

            x = Math.Max(0, x);
            y = Math.Max(0, y);

            lastFestivalProxyKey = proxyKey;
            lastFestivalProxyBy = e.Player.Name ?? e.Player.UniqueMultiplayerID.ToString();
            lastFestivalProxyFestivalId = festivalId;
            lastFestivalProxyAt = DateTime.UtcNow;

            this.Monitor.Log($"[FestivalProxy] Player {lastFestivalProxyBy} entered {e.NewLocation?.Name}; host will trigger festival {festivalId} at {festivalLocation} ({x}, {y}).", LogLevel.Info);
            SetLastAutomation("festivalProxy", true, $"scheduled:{festivalId}:{lastFestivalProxyBy}");

            if (Game1.activeClickableMenu != null)
                Game1.activeClickableMenu = null;

            Game1.warpFarmer(festivalLocation, x, y, false);

            void StartFestivalAfterWarp(object s, EventArgs ev)
            {
                this.Helper.Events.GameLoop.UpdateTicked -= StartFestivalAfterWarp;

                try
                {
                    if (Game1.activeClickableMenu != null)
                        Game1.activeClickableMenu = null;

                    if (!TryLoadFestivalEvent(festivalId, out StardewValley.Event festivalEvent))
                    {
                        SetLastAutomation("festivalProxy", false, $"load failed:{festivalId}");
                        this.Monitor.Log($"[FestivalProxy] Failed to load festival event {festivalId}.", LogLevel.Warn);
                        return;
                    }

                    var startEventMethod = this.Helper.Reflection.GetMethod(Game1.currentLocation, "startEvent", required: false);
                    if (startEventMethod == null)
                    {
                        SetLastAutomation("festivalProxy", false, "startEvent method missing");
                        this.Monitor.Log("[FestivalProxy] Could not find GameLocation.startEvent.", LogLevel.Warn);
                        return;
                    }

                    startEventMethod.Invoke(festivalEvent);
                    SetLastAutomation("festivalProxy", true, $"started:{festivalId}:{lastFestivalProxyBy}");
                    this.Monitor.Log($"[FestivalProxy] Festival {festivalId} started by proxy for player {lastFestivalProxyBy}.", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    SetLastAutomation("festivalProxy", false, ex.Message);
                    this.Monitor.Log($"[FestivalProxy] Failed to start festival {festivalId}: {ex.Message}", LogLevel.Error);
                }
            }

            this.Helper.Events.GameLoop.UpdateTicked += StartFestivalAfterWarp;
        }

        /// <summary>
        /// v1.1.8: 玩家连接时启动守护窗口
        /// </summary>
        private void OnPeerConnected(object sender, PeerConnectedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            long peerId = e?.Peer?.PlayerID ?? 0;
            autoPauseEmptySince = null;
            ResumeAutoPause($"peer_connected:{peerId}");

            if (!Config.PreventHostFarmWarp)
                return;

            // 启动/刷新守护窗口
            guardWindowEnd = DateTime.Now.AddSeconds(Config.PeerConnectGuardSeconds);
            this.Monitor.Log($"[守护窗口] 玩家 {peerId} 连接，启动{Config.PeerConnectGuardSeconds}秒守护窗口", LogLevel.Info);
            LogDebug($"[守护窗口] 窗口结束时间: {guardWindowEnd:HH:mm:ss}");
        }

        private void OnPeerDisconnected(object sender, PeerDisconnectedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            long peerId = e?.Peer?.PlayerID ?? 0;
            if (peerId != 0)
                clientBackpackStates.Remove(peerId);

            ResumeSingleFarmhandMenuPause($"peer_disconnected:{peerId}");
        }

        private void OnModMessageReceived(object sender, ModMessageReceivedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled || !Context.IsWorldReady)
                return;

            if (e.FromModID != ClientPauseReporterModId || e.Type != BackpackStateMessageType)
                return;

            try
            {
                var message = e.ReadAs<ClientBackpackStateMessage>();
                long playerId = e.FromPlayerID;
                Farmer farmhand = GetOnlineFarmhands()
                    .FirstOrDefault(f => f.UniqueMultiplayerID == playerId);

                clientBackpackStates[playerId] = new ClientBackpackState
                {
                    BackpackOpen = message?.BackpackOpen == true,
                    MenuType = message?.MenuType ?? "",
                    PlayerName = farmhand?.Name ?? message?.PlayerName ?? "",
                    UpdatedAt = DateTime.UtcNow,
                };

                CheckAndSingleFarmhandMenuPause();
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"[单人背包暂停] 读取客户端背包状态失败: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>
        /// v1.1.8: 监控房主传送，检测并阻止意外传送到Farm/FarmHouse
        /// </summary>
        private void OnWarped(object sender, WarpedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            TryTriggerFestivalProxy(e);

            if (!Config.PreventHostFarmWarp || e == null || !e.IsLocalPlayer)
                return;

            // 记录所有传送（调试用）
            LogDebug($"[传送监控] {e.OldLocation?.Name ?? "null"} → {e.NewLocation?.Name ?? "null"}");

            // 检查是否在守护窗口内
            bool inGuardWindow = guardWindowEnd.HasValue && DateTime.Now < guardWindowEnd.Value;

            // 检查是否在睡眠/保存流程中（移除saveOnNewDay检查，因为它在传送时已经是true）
            bool inSleepSaveFlow = isSleepInProgress || hasTriggeredSleep;

            // 检查是否是意外传送到Farm或FarmHouse（不依赖isHostHidden标志）
            bool isUnexpectedWarp = (e.NewLocation?.Name == "Farm" || e.NewLocation?.Name == "FarmHouse")
                && !inSleepSaveFlow;

            // 详细诊断日志
            if (e.NewLocation?.Name == "Farm" || e.NewLocation?.Name == "FarmHouse")
            {
                this.Monitor.Log($"[守护窗口-诊断] 传送到{e.NewLocation?.Name}", LogLevel.Debug);
                this.Monitor.Log($"[守护窗口-诊断] inGuardWindow={inGuardWindow}, guardWindowEnd={guardWindowEnd?.ToString("HH:mm:ss")}", LogLevel.Debug);
                this.Monitor.Log($"[守护窗口-诊断] inSleepSaveFlow={inSleepSaveFlow} (isSleepInProgress={isSleepInProgress}, saveOnNewDay={Game1.saveOnNewDay}, hasTriggeredSleep={hasTriggeredSleep})", LogLevel.Debug);
                this.Monitor.Log($"[守护窗口-诊断] isUnexpectedWarp={isUnexpectedWarp}", LogLevel.Debug);
            }

            if (inGuardWindow && isUnexpectedWarp)
            {
                this.Monitor.Log($"[守护窗口] ⚠️ 检测到意外传送到{e.NewLocation?.Name}！准备重新隐藏", LogLevel.Warn);
                this.Monitor.Log($"[守护窗口] 原位置: {e.OldLocation?.Name}, 当前位置: {e.NewLocation?.Name}", LogLevel.Warn);

                // 检查防抖：避免在短时间内重复隐藏
                if (lastRehideTime.HasValue && (DateTime.Now - lastRehideTime.Value).TotalSeconds < 2)
                {
                    this.Monitor.Log($"[守护窗口] 防抖：距离上次隐藏不足2秒，跳过", LogLevel.Debug);
                    return;
                }

                // 调度重新隐藏（延迟指定帧数）
                needRehide = true;
                rehideTicks = Config.RehideDelayTicks;
                this.Monitor.Log($"[守护窗口] 已调度重新隐藏（延迟{rehideTicks}帧）", LogLevel.Info);
            }
            else if (isUnexpectedWarp && !inGuardWindow)
            {
                // 不在守护窗口内，但仍然检测到意外传送（记录警告）
                this.Monitor.Log($"[传送监控] ⚠️ 检测到{e.NewLocation?.Name}传送（守护窗口外）: {e.OldLocation?.Name} → {e.NewLocation?.Name}", LogLevel.Warn);
            }
        }

        private class ClientBackpackStateMessage
        {
            public bool BackpackOpen { get; set; }
            public string MenuType { get; set; } = "";
            public string PlayerName { get; set; } = "";
        }

        private class ClientBackpackState
        {
            public bool BackpackOpen { get; set; }
            public string MenuType { get; set; } = "";
            public string PlayerName { get; set; } = "";
            public DateTime UpdatedAt { get; set; } = DateTime.MinValue;
        }

        private void LogDebug(string message)
        {
            if (Config.DebugMode)
            {
                this.Monitor.Log(message, LogLevel.Debug);
            }
        }
    }
}
