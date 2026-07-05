using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace ServerAutoLoad
{
    public class ModEntry : Mod
    {
        private ModConfig Config;
        private int ticks;
        private string targetSave = "";
        private bool openedHostMenu;
        private bool activatedSlot;
        private bool finished;
        private bool failed;
        private string lastState = "";
        private string lastMessage = "";
        private DateTime lastStateWrittenAt = DateTime.MinValue;

        public override void Entry(IModHelper helper)
        {
            Config = helper.ReadConfig<ModConfig>();
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            Monitor.Log("Server Auto Load v2.0.0 loaded. Saves will be loaded through the native Co-op Host flow.", LogLevel.Info);
        }

        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            if (finished || failed || !Config.Enabled)
                return;

            ticks++;
            if (Context.IsWorldReady)
            {
                finished = true;
                WriteState("world_ready", true, $"Loaded {Game1.player?.farmName.Value ?? "save"} through Co-op host flow.");
                return;
            }

            if (ticks < Math.Max(1, Config.StartupDelayTicks))
            {
                WriteState("startup_delay", true, $"Waiting {Math.Max(1, Config.StartupDelayTicks) - ticks} ticks before opening Co-op Host.");
                return;
            }

            if (ticks > Math.Max(600, Config.MaxWaitTicks))
            {
                Fail("timeout", $"Co-op autoload timed out after {ticks} ticks. Last menu: {MenuName(Game1.activeClickableMenu)}.");
                return;
            }

            try
            {
                if (string.IsNullOrWhiteSpace(targetSave))
                {
                    targetSave = ResolveTargetSave();
                    if (string.IsNullOrWhiteSpace(targetSave) && !Config.AutoSelectMostRecentSave)
                    {
                        Fail("save_not_configured", "No SAVE_NAME, selected-save marker, or config SaveFileName was set.");
                        return;
                    }
                }

                if (!openedHostMenu)
                {
                    OpenNativeHostMenu();
                    return;
                }

                TryActivateTargetHostSlot();
            }
            catch (Exception ex)
            {
                Fail("exception", ex.Message);
                Monitor.Log($"Server Auto Load failed: {ex}", LogLevel.Error);
            }
        }

        private void OpenNativeHostMenu()
        {
            IClickableMenu currentMenu = Game1.activeClickableMenu;
            if (currentMenu is CoopMenu coopMenu)
            {
                coopMenu.SetTab(CoopMenu.Tab.HOST_TAB, playSound: false);
                openedHostMenu = true;
                WriteState("host_menu_open", true, "Co-op Host menu was already open.");
                return;
            }

            if (currentMenu != null && currentMenu is not TitleMenu)
            {
                WriteState("waiting_title_menu", true, $"Waiting for title menu; current menu is {MenuName(currentMenu)}.");
                return;
            }

            Game1.activeClickableMenu = new CoopMenu(true, false, CoopMenu.Tab.HOST_TAB, "");
            openedHostMenu = true;
            WriteState("host_menu_open", true, $"Opened native Co-op Host menu for save '{targetSave}'.");
            Monitor.Log($"Opened native Co-op Host menu for save '{targetSave}'.", LogLevel.Info);
        }

        private void TryActivateTargetHostSlot()
        {
            if (activatedSlot)
            {
                WriteState("slot_activated", true, "Host slot activated; waiting for world to finish loading.");
                return;
            }

            if (Game1.activeClickableMenu is not CoopMenu coopMenu)
            {
                WriteState("waiting_host_menu", true, $"Waiting for Co-op Host menu; current menu is {MenuName(Game1.activeClickableMenu)}.");
                return;
            }

            coopMenu.SetTab(CoopMenu.Tab.HOST_TAB, playSound: false);
            List<object> hostSlots = GetHostSlots(coopMenu);
            if (hostSlots.Count == 0)
            {
                WriteState("waiting_host_slots", true, "Waiting for Co-op Host save slots to populate.");
                return;
            }

            object chosen = null;
            Farmer chosenFarmer = null;
            List<string> available = new List<string>();
            List<string> blocked = new List<string>();

            foreach (object slot in hostSlots)
            {
                Farmer farmer = GetFarmer(slot);
                if (farmer == null)
                    continue;

                string saveName = GetSaveName(farmer);
                if (!string.IsNullOrWhiteSpace(saveName))
                    available.Add(saveName);

                if (!farmer.slotCanHost)
                {
                    blocked.Add(saveName);
                    continue;
                }

                if (string.IsNullOrWhiteSpace(targetSave) || SaveMatches(farmer, targetSave))
                {
                    chosen = slot;
                    chosenFarmer = farmer;
                    break;
                }
            }

            if (chosen == null)
            {
                string availableText = available.Count > 0 ? string.Join(", ", available) : "none";
                string blockedText = blocked.Count > 0 ? $" Blocked/non-hostable: {string.Join(", ", blocked)}." : "";
                WriteState("save_slot_not_found", false, $"Target save '{targetSave}' was not found in Co-op Host slots. Available: {availableText}.{blockedText}");
                return;
            }

            SetActivateDelayZero(chosen);
            InvokeActivate(chosen);
            activatedSlot = true;
            string activatedSave = chosenFarmer != null ? GetSaveName(chosenFarmer) : targetSave;
            WriteState("slot_activated", true, $"Activated native Host slot '{activatedSave}'. Waiting for world load.");
            Monitor.Log($"Activated native Co-op Host slot '{activatedSave}'.", LogLevel.Info);
        }

        private string ResolveTargetSave()
        {
            string configured = FirstNonEmpty(
                Config.SaveFileName,
                Environment.GetEnvironmentVariable("SAVE_NAME"),
                ReadSelectedSaveMarker());
            if (!string.IsNullOrWhiteSpace(configured))
                return configured.Trim();

            if (!Config.AutoSelectMostRecentSave)
                return "";

            string savesDir = GetSavesDir();
            if (!Directory.Exists(savesDir))
                return "";

            return Directory.GetDirectories(savesDir)
                .Where(IsValidSaveDirectory)
                .OrderByDescending(path => Directory.GetLastWriteTimeUtc(path))
                .Select(Path.GetFileName)
                .FirstOrDefault() ?? "";
        }

        private string ReadSelectedSaveMarker()
        {
            if (!Config.UseSelectedSaveMarker || string.IsNullOrWhiteSpace(Config.SelectedSaveMarker))
                return "";

            try
            {
                return File.Exists(Config.SelectedSaveMarker)
                    ? File.ReadAllText(Config.SelectedSaveMarker).Trim()
                    : "";
            }
            catch (Exception ex)
            {
                Monitor.Log($"Could not read selected save marker: {ex.Message}", LogLevel.Warn);
                return "";
            }
        }

        private string GetSavesDir()
        {
            if (!string.IsNullOrWhiteSpace(Config.SelectedSaveMarker))
            {
                string dir = Path.GetDirectoryName(Config.SelectedSaveMarker);
                if (!string.IsNullOrWhiteSpace(dir))
                    return dir;
            }

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "StardewValley",
                "Saves");
        }

        private bool IsValidSaveDirectory(string dir)
        {
            string name = Path.GetFileName(dir);
            return File.Exists(Path.Combine(dir, "SaveGameInfo"))
                && File.Exists(Path.Combine(dir, name));
        }

        private List<object> GetHostSlots(CoopMenu menu)
        {
            IEnumerable slots = GetField<IEnumerable>(menu, "hostSlots")
                ?? GetProperty<IEnumerable>(menu, "MenuSlots");

            if (slots == null)
                return new List<object>();

            return slots.Cast<object>()
                .Where(slot => slot != null && slot.GetType().Name == "HostFileSlot")
                .ToList();
        }

        private Farmer GetFarmer(object slot)
        {
            return GetField<Farmer>(slot, "Farmer");
        }

        private string GetSaveName(Farmer farmer)
        {
            if (farmer == null)
                return "";

            if (!string.IsNullOrWhiteSpace(farmer.slotName))
                return farmer.slotName;

            string farmName = farmer.farmName?.Value ?? "";
            return !string.IsNullOrWhiteSpace(farmName)
                ? $"{farmName}_{farmer.UniqueMultiplayerID}"
                : farmer.UniqueMultiplayerID.ToString();
        }

        private bool SaveMatches(Farmer farmer, string expected)
        {
            if (farmer == null || string.IsNullOrWhiteSpace(expected))
                return false;

            string expectedTrimmed = expected.Trim();
            string saveName = GetSaveName(farmer);
            string farmName = farmer.farmName?.Value ?? "";
            string composed = !string.IsNullOrWhiteSpace(farmName)
                ? $"{farmName}_{farmer.UniqueMultiplayerID}"
                : "";

            return string.Equals(saveName, expectedTrimmed, StringComparison.OrdinalIgnoreCase)
                || string.Equals(composed, expectedTrimmed, StringComparison.OrdinalIgnoreCase)
                || string.Equals(farmName, expectedTrimmed, StringComparison.OrdinalIgnoreCase);
        }

        private void SetActivateDelayZero(object slot)
        {
            FieldInfo field = slot.GetType().GetField("ActivateDelay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            field?.SetValue(slot, 0);
        }

        private void InvokeActivate(object slot)
        {
            MethodInfo method = slot.GetType().GetMethod("Activate", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (method == null)
                throw new InvalidOperationException($"Slot {slot.GetType().Name} does not expose Activate().");

            method.Invoke(slot, Array.Empty<object>());
        }

        private T GetField<T>(object instance, string name)
        {
            if (instance == null)
                return default;

            FieldInfo field = instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (field == null)
                return default;

            object value = field.GetValue(instance);
            return value is T typed ? typed : default;
        }

        private T GetProperty<T>(object instance, string name)
        {
            if (instance == null)
                return default;

            PropertyInfo property = instance.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (property == null)
                return default;

            object value = property.GetValue(instance);
            return value is T typed ? typed : default;
        }

        private string FirstNonEmpty(params string[] values)
        {
            return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
        }

        private string MenuName(IClickableMenu menu)
        {
            return menu?.GetType().Name ?? "";
        }

        private void Fail(string phase, string message)
        {
            failed = true;
            WriteState(phase, false, message);
            Monitor.Log(message, LogLevel.Error);
        }

        private void WriteState(string phase, bool ok, string message)
        {
            if (phase == lastState
                && message == lastMessage
                && (DateTime.UtcNow - lastStateWrittenAt).TotalSeconds < 10)
                return;

            lastState = phase;
            lastMessage = message;
            lastStateWrittenAt = DateTime.UtcNow;

            try
            {
                if (string.IsNullOrWhiteSpace(Config.StateFile))
                    return;

                string dir = Path.GetDirectoryName(Config.StateFile);
                if (!string.IsNullOrWhiteSpace(dir))
                    Directory.CreateDirectory(dir);

                string json = "{" +
                    $"\"updatedAt\":{Json(DateTime.UtcNow.ToString("O"))}," +
                    $"\"phase\":{Json(phase)}," +
                    $"\"ok\":{(ok ? "true" : "false")}," +
                    $"\"message\":{Json(message)}," +
                    $"\"targetSave\":{Json(targetSave)}," +
                    $"\"ticks\":{ticks}," +
                    $"\"activeMenu\":{Json(MenuName(Game1.activeClickableMenu))}," +
                    $"\"openedHostMenu\":{(openedHostMenu ? "true" : "false")}," +
                    $"\"activatedSlot\":{(activatedSlot ? "true" : "false")}" +
                    "}";

                string tmp = $"{Config.StateFile}.tmp-{Environment.ProcessId}";
                File.WriteAllText(tmp, json);
                File.Move(tmp, Config.StateFile, true);
            }
            catch (Exception ex)
            {
                Monitor.Log($"Could not write autoload state: {ex.Message}", LogLevel.Trace);
            }
        }

        private string Json(string value)
        {
            if (value == null)
                return "null";

            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
