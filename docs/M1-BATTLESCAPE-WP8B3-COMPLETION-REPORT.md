# M1 Battlescape WP8B3 — Completion report (INVENTORY_MOVE)

**Date:** 2026-11-06  
**Scope:** **`INVENTORY_MOVE`** end-to-end (engine already present from prior work in this milestone) **+ Node publisher**, **regression tests**, **engine integration test fixes**, **documentation**. No deployment to canonical `runtime\m0\bin\openxcom.exe`, no GitHub relay publish.

## 1. Executive summary

`INVENTORY_MOVE` is wired through Node (`parse` / `validate` / `compose`) with snapshot preflight aligned to WP8A identity fields, **`validateTacticalCommandAgainstSnapshot` now dispatches `MOVE` first** (fixes a latent bug where non-MOVE types fell through to MOVE validation), C++ **core** tests cover parse + `validateInventoryMoveCommand`, and the **engine harness** `companion_inventory_move_engine_test` exercises real `BattlescapeGame::tryExecuteCompanionInventoryMove` success/failure paths after fixing ownership setup and Win32 `main` vs SDL’s `SDL_main` rename.

## 2. Files modified (this completion pass)

| Area | Path |
|------|------|
| Node tactical command | `companion/m0-publish/lib/tactical-command.cjs` |
| Node command binding | `companion/m0-publish/lib/command-binding.cjs` |
| Node tests | `companion/m0-publish/test/tactical-command-m1-wp8b3-inventory-move.test.cjs` |
| C++ command core tests | `engine/OpenXcom/src/test/companion_command_test.cpp` |
| C++ engine integration test | `engine/OpenXcom/src/test/companion_inventory_move_engine_test.cpp` |
| WP8B3 contract doc | `companion/docs/M1-BATTLESCAPE-WP8B3-INVENTORY-MOVE.md` |
| Canonical cross-links | `companion/docs/M1-BATTLESCAPE-WP8B2-UNLOAD.md`, `companion/docs/M1-TACTICAL-PLAN-FOUNDATION.md` |
| CMake → VS regen | `engine/OpenXcom/build-wp8-isolated/*` (regenerated via `ZERO_CHECK` after `src/CMakeLists.txt` change) |

Ground **`PICKUP`** / **`DROP`** (WP8B4) are documented in **`M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md`** and **`M1-BATTLESCAPE-WP8B4-COMPLETION-REPORT.md`** (see WP8B4 for verification — outside WP8B3 scope).

## 3. Final command schema

See **`M1-BATTLESCAPE-WP8B3-INVENTORY-MOVE.md` §1** — matches `CompanionCommandCore::parseInventoryMoveCommandJson` (required `destination_x` / `destination_y`; optional paired `source_x` / `source_y`).

## 4. Supported item and slot categories

Carried ruleset sections only (`STR_GROUND` rejected). Nested magazine instances (`getSlot()==0` for ammo) and primed explosives are rejected in-engine; Node preflight flags nested `nestedAmmo.battleItemId` and snapshot `primed: true` for grenades.

## 5. Engine source reused

- `BattlescapeGame::tryExecuteCompanionInventoryMove` — TU via `RuleInventory::getTransferCosts`, `fitItemInSlot`, overlap check, `checkReservedTU`, `companionInventoryMoveItemForUnit`, `moveToOwner`.
- `CompanionCommandRuntime` / `CompanionCommandCore` — parse + `validateInventoryMoveCommand` + inbox path (existing).

## 6. Destination validation

Authoritative: `RuleInventory` + overlap + TU. Node: binding, actor, item uniqueness, `source_slot` (+ optional grid guard), carried-section allowlist, ground rejection, nested-id and primed snapshot hints.

## 7. Item identity guarantees

`item_battle_item_id` must resolve to exactly one carried row/hands entry; ambiguous duplicate ids are rejected in Node preflight.

## 8. TU behavior

From **source** section’s `costs` map to **destination** section id; same-section **0**; engine enforces `checkReservedTU` / `spendTimeUnits`.

## 9. Atomicity and rejection

Failed paths return before spending TUs (see `tryExecuteCompanionInventoryMove` — spend after prechecks). Reject reasons align with `validateInventoryMoveCommand` codes (`NESTED_AMMUNITION`, `PRIMED_EXPLOSIVE_NOT_MOVABLE`, `INSUFFICIENT_TU`, etc.).

## 10. C++ tests and verification level

| Executable | What ran | Result |
|------------|----------|--------|
| `companion_command_test.exe` | Parse + `validateInventoryMoveCommand` synthetic inputs | **Pass** |
| `companion_snapshot_serialization_test.exe` | Existing WP8 regression | **Pass** |
| `companion_rules_reference_export_test.exe` | Existing rules reference | **Pass** |
| `companion_inventory_move_engine_test.exe` | Minimal `SavedBattleGame` + `Mod::registerTestInventoryRule`: clip hand→belt success, nested ammo reject, insufficient TU no mutation | **Pass** |

**Note:** `companion_inventory_move_engine_test` links a large translation unit set (same pattern as `companion_snapshot_terrain_test`). Win32 **SDL** renames `main` → `SDL_main`; the test TU uses `#undef main` after includes so the console entry links correctly.

## 11. Node test totals

`node companion/m0-publish/scripts/run-all-node-tests.cjs`:

- **607** passed, **0** failed (was **597** at WP8B2 baseline → **+10** from `tactical-command-m1-wp8b3-inventory-move.test.cjs` and related harness paths).

## 12. Win32 Release build

MSBuild **Release | Win32** (after `ZERO_CHECK` regen for the new CMake target):

`"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" "E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\OpenXcom.sln" /p:Configuration=Release /p:Platform=Win32 /t:"companion_command_test;companion_snapshot_serialization_test;companion_rules_reference_export_test;companion_inventory_move_engine_test;openxcom" /m`

**Succeeded** (LNK4075 manifest noise only).

## 13. RELOAD / UNLOAD interaction

Documented in **`M1-BATTLESCAPE-WP8B3-INVENTORY-MOVE.md` §5** and WP8B2 cross-link: after `UNLOAD`, use **`INVENTORY_MOVE`** + fresh binding before `RELOAD` when layout requires stowing the expelled magazine.

## 14. MOVE automatic-standing investigation (read-only)

Companion **`MOVE`** uses `BattlescapeGame::tryExecuteCompanionMove` → `UnitWalkBState` (same walk state as the human UI).

In `UnitWalkBState::think`, if the unit **`isKneeled()`**, the first tick calls **`BattlescapeGame::kneel(unit)`** to **stand** (`kneel()` toggles posture). That path spends the **stand-up TU** via the same kneel/stand machinery as the normal UI; it is **not** a separate undocumented free stand.

**Node MOVE preflight** only checks binding + destination bounds + actor; it does **not** model stand-up TU (same class of “engine authoritative” gap as other commands). The **post-walk snapshot** exports `kneeled` from engine state, so stance after completion should match the engine.

## 15. Snapshot and rules-reference

No snapshot schema version bump required for WP8B3; uses existing `battleItemId`, `slot`, `inventoryX` / `inventoryY`, `nestedAmmo`, grenade `primed`.

## 16. Research and fair-play

No change to hostile intelligence or perception contracts.

## 17. Remaining risks

- Node preflight cannot prove destination fit without rules-reference geometry; operators may see engine `ITEM_DOES_NOT_FIT` / `DESTINATION_OCCUPIED` after passing snapshot checks.
- Duplicate `battleItemId` in a single export is rejected by Node but would be **invalid game data** if it occurred in-engine.

## 18. Runtime deployment status

**Not deployed.** Built binaries only under `engine/OpenXcom/build-wp8-isolated/bin/Release/`.

## 19. GO/NO-GO for controlled live testing

**GO** for isolated/operator-controlled runs when executor + AI ownership + `publish-tactical-command-once.cjs` workflow are satisfied (`AGENTS.md`). No change to cooperative policy (still no remote `END_TURN`).

## 20. Recommended scope for WP8B4 (ground PICKUP/DROP)

Separate **`PICKUP`** / **`DROP`** (or equivalently named) commands — **out of scope** for WP8B3. Scoping constraints for design:

- **Item identity:** Target a specific **ground** `battleItemId` (or engine-equivalent), not “any magazine on this tile,” so the Companion cannot substitute a similar stack.
- **Legitimate knowledge:** Authorize only tiles/items the operator’s snapshot and fair-play rules already expose (same contract as WP8A / `hostile-intelligence-consumer`: no cross-map clairvoyance; use `groundItems` and soldier position as exported).
- **Accessibility:** Engine validates path, TU, and whether the soldier can reach the tile (Companion does not invent reach or ignore blocking).
- **One command, one mutation** — then **fresh binding** before another ground or inventory action (`M1-TACTICAL-PLAN-FOUNDATION.md`).

**Suggested sequence after WP8B4:** controlled **live** integration pass over the inventory command family (`RELOAD`, `UNLOAD`, `INVENTORY_MOVE`, ground PICKUP/DROP when implemented). Defer a **multi-command planner** until these primitives are proven in isolation.
