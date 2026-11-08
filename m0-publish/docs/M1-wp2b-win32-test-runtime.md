# M1-WP2B — Win32 Companion C++ test runtime

## Root cause

`companion_snapshot_export_test.exe` (and other Companion tests linking **dynamic** `yaml-cpp.dll`) failed with exit code **`0xC0000135`** (`STATUS_DLL_NOT_FOUND`) when run from `build-*/bin/Release/` because only `openxcom.exe` received post-build copies of dependency DLLs from `deps/lib/Win32/`.

The missing module was **`yaml-cpp.dll`** (confirmed by staging that tree next to the test executable).

## Permanent fix

CMake function **`openxcom_stage_win32_runtime_deps(target)`** in `engine/OpenXcom/src/CMakeLists.txt`:

- Globs `${DEPS_DIR}/lib/Win32/*.dll` (or `x64` when building 64-bit).
- Adds a **POST_BUILD** `copy_if_different` into `$<TARGET_FILE_DIR:target>` for each Companion test target that links yaml-cpp dynamically.

This mirrors the existing `openxcom` POST_BUILD DLL staging without modifying `runtime/m0/bin` or machine PATH.

## Targets staged (Win32)

- `companion_snapshot_export_test`
- `companion_snapshot_unit_state_test`
- `companion_snapshot_terrain_test`
- `companion_snapshot_serialization_test`

Other yaml-linked Companion tests can call the same helper when needed.

## Owner acceptance (remote commands)

Remote tactical commands (`MOVE`, `KNEEL`, `SNAP_SHOT`, `AUTO_SHOT`, `AIMED_SHOT`, …) require an **AI-owned** actor (`companion-soldier-control.json` / campaign assignment). **`readiness.engineActingUnitAvailable` is observational only** — do not treat a human-controlled soldier as a valid remote command target; expect `NOT_AI_CONTROLLED` when ownership is wrong.

Assign the test soldier to AI locally before enabling the command executor or publishing `tactical-command.json`.

## Serialization integration test notes

`companion_snapshot_serialization_test` exercises `CompanionSnapshotBuild::buildSnapshot` and `serializeSnapshotYaml` (same path as F6 export). Fixtures must:

- Use a **heap-owned `Base`** registered on `SavedGame`, then **`clear()` bases on the `SavedGame` before destruction** so `~SavedGame` never `delete`s static test memory.
- Pass a valid **`StatAdjustment`** when constructing hostile `BattleUnit` (`adjustStats(*adjustment)` dereferences the pointer).
