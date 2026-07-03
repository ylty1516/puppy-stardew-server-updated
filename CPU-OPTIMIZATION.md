# CPU Optimization Report

Date: 2026-03-09

## Summary

This pass adds an opt-in `LOW_PERF_MODE` for the containerized server. Default behavior stays unchanged. When enabled, the startup script now reduces render cost, lowers Xvfb color depth, moves the framebuffer into shared memory, disables SDL audio output, and applies conservative GC limits.

## What I Changed

### 1. Xvfb render cost reduction

Implemented in [docker/scripts/entrypoint.sh](/root/puppy-stardew-server/docker/scripts/entrypoint.sh):

- low-perf resolution: `800x600`
- low-perf Xvfb depth: `16-bit`
- low-perf framebuffer directory: `/dev/shm/xvfb` via `-fbdir`

Why:
- Xvfb officially supports custom screen geometry/depth through `-screen WxHxD`.
- Xvfb also supports `-fbdir`, which lets the framebuffer live in a directory instead of anonymous memory-backed defaults.

Expected CPU savings:
- resolution + depth reduction: `~15-30%` on software-rendered Xvfb paths
- `/dev/shm` framebuffer placement: `~1-3%` from reduced backing-store overhead

### 2. SDL and graphics tuning

In low-perf mode the script now exports:

- `SDL_VIDEODRIVER=x11`
- `SDL_AUDIODRIVER=dummy`
- `LIBGL_ALWAYS_SOFTWARE=1` when `USE_GPU != true`

Why:
- SDL’s official driver hint docs list `x11` as the Linux default/backend selection path.
- I intentionally did **not** switch to `SDL_VIDEODRIVER=dummy`. That would likely remove the visible X11 surface and conflicts with the project requirement that VNC must still show the game when enabled. This is an inference from the SDL docs plus the project’s VNC requirement.
- `SDL_AUDIODRIVER=dummy` is enabled only in low-perf mode because the server is unattended and audio output is unnecessary.
- `LIBGL_ALWAYS_SOFTWARE=1` is only applied on non-GPU paths so it does not sabotage explicit `USE_GPU=true` deployments.

Expected CPU savings:
- dummy audio driver: `~2-5%`
- forcing software GL on Xvfb fallback: stabilizes software paths more than it reduces CPU; expected gain is small but avoids mixed/failed GL probing

### 3. Mono / .NET GC tuning

In low-perf mode the script now exports:

- `MONO_GC_PARAMS=nursery-size=8m`
- `DOTNET_GCHeapHardLimit=0x30000000` (`768 MiB`)

Why:
- Mono’s SGen docs explicitly document `MONO_GC_PARAMS` and `nursery-size`.
- Microsoft’s .NET runtime docs document `DOTNET_GCHeapHardLimit` as a hex byte limit.

Expected CPU savings:
- GC tuning: `~0-5%` CPU reduction, mainly fewer minor collections at the cost of a modest memory tradeoff

### 4. Startup preferences alignment

When `LOW_PERF_MODE=true`, startup preferences are rewritten to match the lower resolution and enable safer low-cost client settings:

- fullscreen resolution -> current low-perf resolution
- preferred resolution -> current low-perf resolution
- `vsyncEnabled=true`
- `startMuted=true`
- music/sound volumes -> `0`

Why:
- Without this, the game config can keep requesting `1280x720` even after the X server has been reduced to `800x600`.

Expected CPU savings:
- config alignment + muted startup: `~1-3%`

## Always On Server Mod Review

Reviewed:
- [docker/mods/AlwaysOnServer/config.json](/root/puppy-stardew-server/docker/mods/AlwaysOnServer/config.json)
- [docker/mods/AlwaysOnServer/manifest.json](/root/puppy-stardew-server/docker/mods/AlwaysOnServer/manifest.json)

Result:
- no exposed config key for target FPS
- no exposed config key for render skipping
- no exposed config key for tick throttling

I also checked the shipped DLL strings. Internal symbols like `Rendered`, `skipTicks`, and `UpdateTicked` exist, but I did not find a stable user-facing config option to tune them safely. Because of that, I left the mod config unchanged.

## Effective vs Not Selected

Implemented:
- lower Xvfb resolution/depth in low-perf mode
- `/dev/shm` framebuffer for Xvfb
- SDL audio disable
- conservative Mono/.NET GC limits
- startup preference alignment

Considered but not enabled:
- `SDL_VIDEODRIVER=dummy`
  - not selected because it risks breaking visible rendering and VNC usability
- changing the default mode globally
  - rejected because the task required backward compatibility and opt-in behavior
- forcing mod-level FPS throttling
  - no safe exposed Always On Server config was found locally

## Restart Requirements

Container restart required:
- `LOW_PERF_MODE`
- `TARGET_FPS`
- `SDL_*`
- `LIBGL_ALWAYS_SOFTWARE`
- `MONO_GC_PARAMS`
- `DOTNET_GCHeapHardLimit`
- Xvfb resolution/depth changes

No extra manual action required:
- startup preferences are rewritten automatically on container start when low-perf mode is enabled

## Estimated Overall Impact

Best-case expected savings on Xvfb/software-rendered deployments:
- `~20-40%` CPU reduction

More realistic steady-state expectation:
- `~15-25%`

These are engineering estimates based on the rendering and GC changes above, not direct benchmarks from this workspace.

## Future Work

- benchmark actual CPU deltas with `LOW_PERF_MODE=false` vs `true`
- if a safe MonoGame/SMAPI headless path is confirmed, test `SDL_VIDEODRIVER=dummy` behind a separate experimental flag
- expose low-perf resolution/depth as first-class env vars in docs if users need finer control
- investigate whether a mod-side frame cap exists in a newer Always On Server release

## Sources

- X.Org Xvfb man page: https://www.x.org/archive/X11R7.0/doc/html/Xvfb.1.html
- SDL hint docs (`SDL_HINT_VIDEODRIVER`): https://wiki.libsdl.org/SDL2/SDL_HINT_VIDEODRIVER
- Mono SGen GC docs: https://www.mono-project.com/docs/advanced/garbage-collector/sgen/
- .NET GC heap hard limit docs: https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector
