namespace AutoHideHost
{
    public class ModConfig
    {
        public bool Enabled { get; set; } = true;
        public bool AutoHideOnLoad { get; set; } = true;
        public bool AutoHideDaily { get; set; } = true;
        public bool PauseWhenEmpty { get; set; } = true;
        public string AutoPauseControlFile { get; set; } = "/home/steam/web-panel/data/auto-pause.json";
        public int EmptyPauseDelaySeconds { get; set; } = 30;
        public int AutoPauseStartupGraceSeconds { get; set; } = 45;
        public bool AutoResumeOnPlayerJoin { get; set; } = true;
        public int AutoPausePollTicks { get; set; } = 60;
        public bool PauseWhenSingleFarmhandOpensMenu { get; set; } = true;
        public int SingleFarmhandMenuPauseTimeoutSeconds { get; set; } = 10;
        public bool InstantSleepWhenReady { get; set; } = true;
        public string HideMethod { get; set; } = "warp";
        public string WarpLocation { get; set; } = "Desert";
        public int WarpX { get; set; } = 0;
        public int WarpY { get; set; } = 0;
        public bool DebugMode { get; set; } = true;

        // v1.1.8: 守护窗口机制 - 防止玩家连接后房主被传送到Farm
        public bool PreventHostFarmWarp { get; set; } = true;  // 启用防传送机制
        public int PeerConnectGuardSeconds { get; set; } = 30;  // 守护窗口时长（秒）
        public int RehideDelayTicks { get; set; } = 1;  // 重新隐藏延迟（游戏帧数）
        public bool DebugTraceMenus { get; set; } = false;  // 启用菜单堆栈追踪
        public string ManualPauseFile { get; set; } = "/home/steam/web-panel/data/manual-pause.json";
        public int ManualPausePollTicks { get; set; } = 60;
        public string GameStateFile { get; set; } = "/home/steam/web-panel/data/game-state.json";
        public int GameStateWriteTicks { get; set; } = 60;
        public string HostCommandFile { get; set; } = "/home/steam/web-panel/data/host-command.json";
        public int HostCommandPollTicks { get; set; } = 30;
        public bool EnableFestivalProxyTrigger { get; set; } = true;
        public int FestivalProxyCooldownSeconds { get; set; } = 20;
        public bool EnableEventProxyTrigger { get; set; } = true;
        public int EventProxyCooldownSeconds { get; set; } = 25;
        public int EventProxyNoEventWaitSeconds { get; set; } = 3;
        public int EventProxySkipEventDelaySeconds { get; set; } = 4;
        public int EventProxyEventTimeoutSeconds { get; set; } = 90;
        public bool EventProxyUseOffMapPosition { get; set; } = true;
        public string EventProxyIgnoredLocations { get; set; } = "";
        public bool AutoSkipSkippableEvents { get; set; } = false;
    }
}
