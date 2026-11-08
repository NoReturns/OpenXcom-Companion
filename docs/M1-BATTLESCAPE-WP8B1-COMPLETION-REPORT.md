# M1 Battlescape WP8B1 — Completion report (RELOAD)

**Date:** November 6, 2026

## Executive summary

Implemented the **`RELOAD`** tactical command end-to-end: C++ parsing/validation, `BattlescapeGame::tryExecuteCompanionReload` using the same **15 TU + `setAmmoItem` + `moveToOwner(0)`** pathway as `BattleUnit::checkAmmo()`, `CompanionCommandRuntime` inbox handling with structured results (including `tu_spent` on success), Node schema (`tactical-command.cjs`), `composeReloadCommand`, and tests. **Magazine swap while a magazine remains in the weapon is explicitly unsupported** in B1 because `BattleItem::setAmmoItem` returns **-1** when already loaded.

## Files modified (high level)

- `engine/OpenXcom/src/Engine/CompanionCommandCore.{h,cpp}` — parse/validate RELOAD.
- `engine/OpenXcom/src/Battlescape/BattlescapeGame.{h,cpp}` — `tryExecuteCompanionReload`.
- `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` — inbox, `fillReloadValidationInput`, results.
- `engine/OpenXcom/src/test/companion_command_test.cpp` — core tests.
- `companion/m0-publish/lib/tactical-command.cjs`, `command-binding.cjs` — schema + composer.
- `companion/m0-publish/test/tactical-command-m1-wp8b1-reload.test.cjs` — new tests.
- `companion/docs/M1-BATTLESCAPE-INVENTORY-AUDIT.md` — command count updated.
- `companion/docs/M1-BATTLESCAPE-WP8B1-RELOAD.md` — contract and behavior.

## Final command schema

See `companion/docs/M1-BATTLESCAPE-WP8B1-RELOAD.md`. Required fields: `weapon_battle_item_id`, `ammo_battle_item_id`, plus standard binding fields.

## Engine behavior verified (source-level)

- `BattleUnit::checkAmmo` — 15 TU, `setAmmoItem`, `moveToOwner(0)`.
- `BattleItem::setAmmoItem` — **-1** if weapon already has ammo (no silent swap).
- `Inventory::mouseClick` — 15 TU reload drag when chamber empty.

## Node tests

- Command: `node companion/m0-publish/scripts/run-all-node-tests.cjs`
- **Result (2026-11-06 verification):** **589** tests passed, **0** failed (includes kneeling RELOAD preflight regression).

## C++ build and tests (Win32 Release, isolated tree)

**Toolchain:** Visual Studio 2022 Build Tools — MSBuild from  
`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe`  
( located via `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe` ).

**Solution:** `engine/OpenXcom/build-wp8-isolated/OpenXcom.sln`

**Targets built (Release | Win32):**

| Target | Output |
|--------|--------|
| `companion_command_test` | `engine/OpenXcom/build-wp8-isolated/bin/Release/companion_command_test.exe` |
| `companion_snapshot_serialization_test` | `.../companion_snapshot_serialization_test.exe` |
| `companion_rules_reference_export_test` | `.../companion_rules_reference_export_test.exe` |
| `openxcom` (full game) | `.../openxcom.exe` |

**Executions:** All three test executables were run successfully (**exit code 0**); each printed its usual “all tests passed” / named test banner.

## Corrections during verification

1. **`CompanionCommandRuntime.cpp`:** `rejectReloadCommand` called `writeResultFile` before the function’s definition inside the anonymous namespace → **added forward declaration** and marked `writeResultFile` **`static`** (MSVC C3861).
2. **`relay-rate-limit-gate.cjs`:** Concurrent merge-lock test could **timeout on Windows** when three child processes contended without yielding → **exponential backoff spin** in `withMergeLock`, default lock timeout **30s** (was 10s). Restores **green** `run-all-node-tests.cjs`.
3. **Node:** `tactical-command-m1-wp8b1-reload.test.cjs` — **`kneeled: true`** RELOAD preflight regression (stance must not block validate).

## KNEEL × RELOAD compatibility (code review)

- **KNEEL** unchanged by RELOAD work; still **kneel-down only** via `tryExecuteCompanionKneelDown` (underlying `kneel()` is a toggle, but companion only invokes standing → kneeling). **Standing up** is **not** the `KNEEL` command contract.
- **RELOAD** does not alter kneeling state (no `kneel()` call). TU for kneel vs reload remain **separate** engine costs.
- Both use the same **binding**, **AI ownership**, and **human-order** gates.

See `companion/docs/M1-BATTLESCAPE-WP8B1-RELOAD.md` §8.

## Tactical plan groundwork

- **`companion/docs/M1-TACTICAL-PLAN-FOUNDATION.md`** — primitives, gaps, relation to **`companion/m0-publish/docs/multi-turn-retrieve-audit.md`**, safe sequential rules (no queue in engine).

## Runtime deployment

- **`runtime\m0\bin\openxcom.exe`** was **not** copied or replaced. Built binary exists only under **`build-wp8-isolated/bin/Release/`**. No live GitHub publish.

## GO / NO-GO for live RELOAD

- **GO (engineering):** Sources compile; unit tests pass; Node suite passes — ready to **copy** a verified build into the operator runtime when desired.
- **NO-GO (operational live RELOAD)** until the operator deploys a build containing this code and runs an in-mission spot check (see WP8B1 RELOAD doc §6).

## Remaining risks

- Reload **only** when chamber is empty; players expecting mid-combat **magazine swap** need **UNLOAD** (WP8B2).
- Node `validateReloadAgainstSnapshot` is a **preflight helper**; edge cases still depend on engine rejection.

## WP8B2 GO/NO-GO

- **GO** to scope **UNLOAD** (and then reload-after-unload sequences) — engine/constants and inventory UI already document 8 TU unload; RELOAD path is proven in isolation.
- **NO-GO** for implementing full **plan controller** or relay **multi-command** inbox in WP8B2 — keep WP8B2 focused on **UNLOAD** + docs/tests per charter.

## WP8B2 scope suggestion

- **UNLOAD** (8 TU) + optional **RELOAD** after unload, or a single documented **swap** sequence.
