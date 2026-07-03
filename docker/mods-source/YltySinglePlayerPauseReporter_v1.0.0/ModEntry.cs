using System;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace YltySinglePlayerPauseReporter
{
    public class ModEntry : Mod
    {
        private const string ServerModId = "AIdev.AutoHideHost";
        private const string MessageType = "BackpackState";

        private bool lastBackpackOpen = false;
        private string lastMenuType = "";
        private int heartbeatTicks = 0;

        public override void Entry(IModHelper helper)
        {
            helper.Events.Display.MenuChanged += OnMenuChanged;
            helper.Events.GameLoop.SaveLoaded += OnSaveLoaded;
            helper.Events.GameLoop.ReturnedToTitle += OnReturnedToTitle;
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
        }

        private void OnSaveLoaded(object sender, SaveLoadedEventArgs e)
        {
            lastBackpackOpen = false;
            lastMenuType = "";
            heartbeatTicks = 0;
            SendBackpackState(false, "");
        }

        private void OnReturnedToTitle(object sender, ReturnedToTitleEventArgs e)
        {
            SendBackpackState(false, "");
            lastBackpackOpen = false;
            lastMenuType = "";
            heartbeatTicks = 0;
        }

        private void OnMenuChanged(object sender, MenuChangedEventArgs e)
        {
            bool backpackOpen = IsBackpackMenu(e.NewMenu);
            string menuType = e.NewMenu?.GetType().Name ?? "";

            if (backpackOpen == lastBackpackOpen && menuType == lastMenuType)
                return;

            lastBackpackOpen = backpackOpen;
            lastMenuType = menuType;
            heartbeatTicks = 0;
            SendBackpackState(backpackOpen, menuType);
        }

        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            if (!lastBackpackOpen)
                return;

            heartbeatTicks++;
            if (heartbeatTicks < 180)
                return;

            heartbeatTicks = 0;
            SendBackpackState(true, lastMenuType);
        }

        private bool IsBackpackMenu(IClickableMenu menu)
        {
            if (menu == null)
                return false;

            string menuType = menu.GetType().Name;
            return menuType == "GameMenu" || menuType == "InventoryPage";
        }

        private void SendBackpackState(bool backpackOpen, string menuType)
        {
            if (!Context.IsWorldReady || Context.IsMainPlayer || !Context.IsMultiplayer)
                return;

            try
            {
                this.Helper.Multiplayer.SendMessage(
                    new BackpackStateMessage
                    {
                        BackpackOpen = backpackOpen,
                        MenuType = menuType ?? "",
                        PlayerName = Game1.player?.Name ?? "",
                    },
                    MessageType,
                    modIDs: new[] { ServerModId }
                );
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"Failed to send backpack state: {ex.Message}", LogLevel.Trace);
            }
        }
    }

    public class BackpackStateMessage
    {
        public bool BackpackOpen { get; set; }
        public string MenuType { get; set; } = "";
        public string PlayerName { get; set; } = "";
    }
}
