namespace ServerAutoLoad
{
    public class ModConfig
    {
        public bool Enabled { get; set; } = true;
        public string SaveFileName { get; set; } = "";
        public bool UseSelectedSaveMarker { get; set; } = true;
        public string SelectedSaveMarker { get; set; } = "/home/steam/.config/StardewValley/Saves/.selected_save";
        public bool AutoSelectMostRecentSave { get; set; } = true;
        public int StartupDelayTicks { get; set; } = 180;
        public int MaxWaitTicks { get; set; } = 7200;
        public string StateFile { get; set; } = "/home/steam/web-panel/data/server-autoload-state.json";
    }
}
