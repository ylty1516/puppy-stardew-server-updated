# AutoHideHost v1.0.1 Release Notes

## v1.2.5

- Added festival proxy triggering: when any connected farmhand enters today's festival location during the festival time window, the hidden host automatically enters and starts the festival event.
- Added `EnableFestivalProxyTrigger` and `FestivalProxyCooldownSeconds` config options.
- Added festival status to `game-state.json`, including festival ID, location, time window, open state, proxy enabled state, and the last proxy trigger.
- Made the joinable state conservative when the host is blocked by a menu or non-skippable event.
- Limited the host farm-warp guard to the local host player so remote farmhand warps don't accidentally trigger host re-hide logic.

## v1.2.4

- Added a structured SMAPI state bridge at `/home/steam/web-panel/data/game-state.json`.
- The bridge reports world readiness, server role, multiplayer initialization, joinable state, save/date/time, pause/saving state, online players, active menu/event, host hidden state, sleep automation state, and the latest automation result.
- The web panel can now distinguish "game process is running" from "players can actually join".

## 🐛 Bug Fixes

### Fixed: Black screen when selling items and sleeping in multiplayer

**Issue:** In multiplayer games, when players sell items during the day and then sleep at night, the game would display a black screen and become unresponsive after the sleep transition.

**Root Cause:** AutoHideHost was triggering instant sleep while the game's settlement menu (showing day's earnings) was trying to display, causing a conflict that resulted in a black screen.

**Solution:** Added a critical check in `CheckAndAutoSleep()` function to wait for any active menu (including settlement menu) to complete before triggering sleep. The fix ensures:
- The settlement menu displays properly showing daily earnings
- Sleep transition happens only after menu is closed
- No more black screen freeze issues

**Files Changed:**
- `ModEntry.cs` - Added menu check before triggering sleep

## 📋 Installation

1. Replace the old `AutoHideHost.dll` in your `Mods/AutoHideHost` folder
2. Update `manifest.json` to version 1.0.1 (included)
3. Restart your server

## ⚠️ Important

- Make sure to replace ALL files in the mod folder
- This fix is compatible with SMAPI 4.0.0+
- No configuration changes needed

## 🙏 Acknowledgments

Special thanks to the community for reporting and helping test this fix.

## 📄 License

Same as original mod license.
