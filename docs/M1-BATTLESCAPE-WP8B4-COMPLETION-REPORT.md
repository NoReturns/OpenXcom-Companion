# M1 Battlescape WP8B4 — Completion report (ground PICKUP / DROP)

**Date:** 2026-11-06  
**Scope:** **`PICKUP`** and **`DROP`** — Node parse/validate/compose, snapshot **`units[].groundInventory`** fair-play export (engine side from prior implementation in tree), C++ runtime validation + execution, tests, documentation. **No** `runtime\m0\bin\openxcom.exe` overwrite, **no** GitHub relay publish in this pass.

---

## 1. Executive summary

WP8B4 closes **verification** for **ground ↔ carried** `PICKUP` / `DROP`: Node binding and C++ command core stay unchanged in contract; this pass adds a **Release Win32 engine harness** (`companion_pickup_drop_engine_test`) that calls `BattlescapeGame::tryExecuteCompanionPickup` / `tryExecuteCompanionDrop`, extends **`companion_snapshot_serialization_test`** for `units[].groundInventory`, fixes snapshot/test-mod plumbing and a **double-delete** hazard in the serialization fixture, and completes an **isolated** full solution build including **`openxcom.exe`** under `engine/OpenXcom/build-wp8-isolated/bin/Release/`. **Canonical** `runtime\m0\bin\openxcom.exe` was **not** touched; **live GitHub relay** end-to-end is still **not** verified here (separate acceptance stage).

---

## 2. Source audit findings (vanilla-aligned)

| Topic | Finding |
|-------|---------|
| Ground representation | Ground items use `INV_GROUND` / `STR_GROUND`; tile from `item->getTile()`. |
| UI / reach | Inventory ground grid is for the **selected unit’s tile**; Companion mirrors **actor tile only** in export + command guard. |
| Pickup/drop mechanics | `tryExecuteCompanionPickup` / `tryExecuteCompanionDrop` use transfer costs, `fitItemInSlot`, overlap (pickup), `companionFindFirstGroundPlacement` (drop), reserved TU, then `companionInventoryMoveItemForUnit` + ownership updates. |
| Ground slot geometry | Ground slots are **2D cells** on the ground ruleset; exported as `inventoryX` / `inventoryY` on `groundInventory` rows. |
| TU | From `RuleInventory::getTransferCosts()` (ground→section or section→ground). |
| Stacking | Engine overlap checks on pickup; drop searches for first free cell. |
| Corpses / unconscious | Not special-cased in these helpers beyond normal `BattleItem` rules. |
| Primed grenades | **No** extra primed block in pickup/drop paths (unlike `INVENTORY_MOVE`); matches allowing primed items in inventory when rules allow. |

---

## 3. Fair-play decision

| Exposed | Rationale |
|---------|-----------|
| `units[].groundInventory[]` for friendly soldiers | Only items on that unit’s **current engine tile** ground grid, arranged for export — equivalent to opening ground for that tile in the battlescape inventory UI. |

| Hidden | Rationale |
|------|-----------|
| Ground on other tiles | Not in this unit’s ground export. |
| Enemy / MC inventories | Unchanged WP8A rules. |

Snapshot schema: **no** new root version required; additive **`groundInventory`** on friendly units when present.

---

## 4. Final command contracts

See **`M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md`** §2.

---

## 5. Files touched in WP8B4V (verification closure)

| Area | Path |
|------|------|
| Engine snapshot | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` — `modFromBattle` falls back to `SavedBattleGame::getTestMod()`; `appendActorGroundInventory` exports tile ground rows using **engine slot coordinates** (no `Inventory::arrangeGround` replay in export) |
| Runtime include | `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` — `#include` `Tile.h` for `findGroundItemFromActorExport` |
| Ground placement safety | `engine/OpenXcom/src/Engine/CompanionGroundInventoryCore.cpp` — iteration cap in `companionArrangeGroundSlotCoordsForUnit` (drop/pickup paths still use arrange; avoids unbounded scan on degenerate layouts) |
| CMake / harness | `engine/OpenXcom/src/CMakeLists.txt` — `companion_pickup_drop_engine_test` (option `OPENXCOM_BUILD_COMPANION_PICKUP_DROP_ENGINE_TEST`) |
| Engine integration tests | `engine/OpenXcom/src/test/companion_pickup_drop_engine_test.cpp` |
| Snapshot serialization tests | `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` — `groundInventory` coverage; `SavedBattleGame::setTestMod`; `adoptGroundItemForBattleCleanup` duplicate-guard |
| WP8B3 doc table | `companion/docs/M1-BATTLESCAPE-WP8B3-COMPLETION-REPORT.md` — WP8B4 cross-reference moved out of the modified-files table |
| This report + contract | `companion/docs/M1-BATTLESCAPE-WP8B4-COMPLETION-REPORT.md`, `companion/docs/M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md` |

Representative **already-implemented** command surfaces (unchanged contracts this pass): `BattlescapeGame::tryExecuteCompanionPickup` / `tryExecuteCompanionDrop`, `CompanionCommandCore`, `CompanionCommandRuntime`, Node `tactical-command.cjs` / `command-binding.cjs`.

---

## 6. Item identity and ownership

- **PICKUP:** `item_battle_item_id` must appear **exactly once** in `actor.groundInventory` in the snapshot; engine requires ground item on **actor tile** and correct `BattleItem` id.
- **DROP:** Item must resolve to exactly one carried placement; `source_slot` (+ optional coords) matches WP8B3.

---

## 7. Atomicity

- Engine returns `false` before `spendTimeUnits` when prechecks fail; success path performs a single move mutation.

---

## 8. Primed explosive behavior

- **ENGINE:** Pickup/drop paths do **not** add the `INVENTORY_MOVE` primed block (unchanged).
- **ENGINE HARNESS (`companion_pickup_drop_engine_test`):** Timed grenade `fuseTimer==3` and proximity `fuseTimer==0` are picked up from the actor tile; **fuse is preserved**; TU and inventory assertions match successful path.
- **VANILLA UI:** Not replayed in this harness — behavior is asserted against **`tryExecuteCompanionPickup`** and the same `BattleItem` / `RuleItem` rules as other engine tests.
- **LIVE:** Not verified.

---

## 9. Verification categories (WP8B4V)

| Category | Status |
|----------|--------|
| **Implemented** (prior + this pass) | `PICKUP` / `DROP` command core, runtime dispatch, `appendActorGroundInventory`, dedicated CMake harness, snapshot tests |
| **Core-test verified** | `companion_command_test.exe` — parse/validate JSON + PICKUP/DROP branches |
| **Engine-integration verified** | `companion_pickup_drop_engine_test.exe` — real `BattlescapeGame::tryExecuteCompanionPickup` / `tryExecuteCompanionDrop` success + many rejection/no-mutation cases |
| **Serialization verified** | `companion_snapshot_serialization_test.exe` — `groundInventory` under friendly units, ordering, undiscovered tile gate, v5 additive field, two soldiers same tile |
| **Build verified** | Release \| Win32 **`openxcom.exe`** in isolated tree (see §10) |
| **Live-relay verified** | **Not verified** (no publish, no inbox exercise) |

---

## 10. Verification matrix (commands run)

| Artifact | Result |
|----------|--------|
| `node companion/m0-publish/scripts/run-all-node-tests.cjs` | **616** pass, **0** fail |
| `companion_command_test.exe` | Pass |
| `companion_rules_reference_export_test.exe` | Pass |
| `companion_inventory_move_engine_test.exe` | Pass |
| `companion_snapshot_serialization_test.exe` | Pass |
| `companion_pickup_drop_engine_test.exe` | Pass |

**MSBuild (isolated tree, 2026-11-06):**

`"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" "E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\OpenXcom.sln" /m /p:Configuration=Release /p:Platform=Win32 /t:"companion_pickup_drop_engine_test;companion_command_test;companion_snapshot_serialization_test;companion_rules_reference_export_test;companion_inventory_move_engine_test;openxcom"`

- **Exit:** 0  
- **`openxcom.exe` output:** `E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\bin\Release\openxcom.exe`  
- **Note:** Warnings only (e.g. C4996 `fopen`/`getenv`, LNK4075 manifest) — same class as prior isolated builds.

---

## 11. Compatibility

| Primitive | Status |
|-----------|--------|
| WP8B1 RELOAD | **NOT REGRESSED** (Node suite includes existing RELOAD tests) |
| WP8B2 UNLOAD | Same |
| WP8B3 INVENTORY_MOVE | Same; `STR_GROUND` still rejected for INVENTORY_MOVE |
| MOVE / combat | Node regression suite passes |

---

## 12. Remaining risks / not verified

- **Live relay:** No `publish-tactical-command-once.cjs` run against GitHub; no real F6 → snapshot → command round trip.
- **Operator UI parity:** Harness uses test `Mod` rules (`registerTestInventoryRule`) and flat `tuSnap` on the test rifle for deterministic **`checkReservedTU`** — not a full ruleset load.
- **Canonical runtime:** Deliberately **not** deployed; isolated build path only.

---

## 13. Runtime deployment status

- Canonical **`runtime\m0\bin\openxcom.exe`** was **not** modified.  
- **No** GitHub relay publish performed.

---

## 14. GO / NO-GO

| Gate | Verdict |
|------|---------|
| Isolated **engine** PICKUP/DROP + **serialization** + **Release `openxcom.exe`** | **GO** for continuing toward controlled deployment (automated evidence above) |
| **Live GitHub relay** / production `runtime\m0\bin\openxcom.exe` swap | **NO-GO** until operator runs relay workflow per `AGENTS.md` |

---

## 15. Recommended next milestone

**WP8 inventory family — controlled live integration** (RELOAD, UNLOAD, INVENTORY_MOVE, PICKUP, DROP) with fresh bindings per step; then consider bounded sequential planning per `M1-TACTICAL-PLAN-FOUNDATION.md`.
