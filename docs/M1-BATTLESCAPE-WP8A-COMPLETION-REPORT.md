# M1 Battlescape WP8A — Completion report

**Date:** November 6, 2026  
**Workspace:** `E:\Open X-Com Companion`  
**Runtime:** Canonical `runtime\m0\bin\openxcom.exe` was **not** modified or deployed.

## 1. Executive summary

WP8A adds **read-only**, **instance-aware** battlescape equipment to the Companion tactical snapshot: stable **`battleItemId`** (`BattleItem::getId()`), **ruleset-accurate placement** (slot id, hand identity, grid coordinates for slot sections), **nested magazine** representation (no duplicate row for the loaded clip), **firearm / grenade / medikit** state, and **carried weight** plus **strength** / **encumbrance ratio** from the engine. Rules reference export is extended to **schema_version 2** with **`inventorySections`** and per-section **transfer TU** maps from `RuleInventory`.

**Reliability fixes delivered with WP8A:**

- **`SavedBattleGame::getGeoscapeSave()`** is null-safe when no `BattlescapeState` is attached (unit tests and headless snapshot paths). This prevents crashes when **`actionCosts`** evaluates research eligibility.
- **`BattleItem::occupiesSlot`** returns false when **`_inventorySlot` is null**, so magazines that exist only as **`weapon.getAmmoItem()`** are not treated as occupying a grid cell.

No new tactical commands; no F6 workflow changes.

## 2. Files touched (implementation)

**Engine**

- `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` — equipment serialization, weight, nested ammo, grenade kinds, medikit charges.
- `engine/OpenXcom/src/Engine/CompanionRulesReferenceExport.cpp`
- `engine/OpenXcom/src/Engine/CompanionRulesReferenceExportCore.cpp`
- `engine/OpenXcom/src/Engine/CompanionRulesReferenceExportCore.h`
- `engine/OpenXcom/src/Mod/RuleInventory.h` — `getTransferCosts()` accessor.
- `engine/OpenXcom/src/Savegame/SavedBattleGame.cpp` — `getGeoscapeSave()` null guard.
- `engine/OpenXcom/src/Savegame/BattleItem.cpp` — `occupiesSlot` null-slot guard.
- `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` — WP8 regression tests.

**Companion / Node**

- `companion/m0-publish/lib/tactical-publish.cjs` — validation for new snapshot fields.
- `companion/m0-publish/lib/rules-reference-export.cjs` — schema 1/2 and `inventorySections`.
- `companion/m0-publish/test/inventory-observation-wp8a.test.cjs` (and related test updates per suite).

**Documentation**

- `companion/docs/M1-BATTLESCAPE-WP8A-INVENTORY-OBSERVATION.md` — field definitions and semantics.
- This report.

## 3. Snapshot fields added or changed (summary)

See the implementation doc for the full table. Highlights:

- **`battleItemId`**, **`inventorySlotType`**, **`slot`**, **`hand`**, **`inventoryX`/`inventoryY`** (slot grids only).
- Firearms: **`nestedAmmo`**, **`loaded`**, **`empty`**, **`noMagazineInserted`** (mutually consistent per validator).
- Grenades: **`explosiveKind`** (`timed` | `proximity`), **`primed`**, **`fuseTimer`**.
- Medikits: **`medikitCharges`**.
- Unit: **`carriedWeight`**, **`strength`**, **`encumbranceRatio`** (ratio only if weight &gt; 0).

Rules reference: **`schema_version` 2**, **`inventorySections`**, expanded limitation text for transfer vs engine-fixed TU.

## 4. Example serialized shapes (from C++ test expectations)

Identity and nested magazine (abridged):

```yaml
hands:
  right:
    battleItemId: <rifle id>
    itemType: STR_WP8_RIFLE
    nestedAmmo:
      battleItemId: <loaded clip id>
      ammoType: STR_WP8_CLIP
      rounds: 20
    loaded:
      ammoType: STR_WP8_CLIP
      rounds: 20
      battleItemId: <loaded clip id>
inventory:
  - slot: STR_BELT
    battleItemId: <spare A>
    itemType: STR_WP8_CLIP
  - slot: STR_BACK_PACK
    battleItemId: <spare B>
    itemType: STR_WP8_CLIP
```

## 5. Item identity and nested ammunition guarantees

- **Uniqueness:** Distinct `BattleItem` instances receive distinct ids for the lifetime of the battle (see Node + C++ tests).
- **Stability:** Re-exporting the snapshot does not allocate new ids; ids come from live `BattleItem` state.
- **Moves:** Moving a spare clip between belt and backpack preserves **`battleItemId`** (C++ test).
- **Nested clip:** The loaded magazine’s id appears under **`nestedAmmo`** / **`loaded`** and is **omitted** from **`inventory[]`** so it is not double-listed.

## 6. Research and fair-play

- **Research:** In full game play, `companionResearchUsable` uses `SavedGame::isResearched` when a geoscape save is reachable; in headless tests with no battle state, **`getGeoscapeSave()`** may be null and eligibility defaults to permissive for **`actionCosts`** only — not a gameplay change on console builds.
- **Hostile / ground:** Existing concealment and hostile-minimal export behavior preserved; WP8A does not export hostile carried inventory.

## 7. Automated test commands and totals

| Suite | Command | Result |
|-------|-----------|--------|
| C++ snapshot integration | `MSBuild ... companion_snapshot_serialization_test.vcxproj` (Release Win32) then `companion_snapshot_serialization_test.exe` | **All tests passed** (stderr lists all WP2 + WP8 cases; ends with `all tests passed.`) |
| C++ rules reference | `MSBuild ... companion_rules_reference_export_test.vcxproj` then `companion_rules_reference_export_test.exe` | **all passed.** |
| Node (full m0-publish) | `node companion/m0-publish/scripts/run-all-node-tests.cjs` | **583 pass, 0 fail** |

## 8. Build results

- **Configuration:** Release, **Win32**, project tree `engine\OpenXcom\build-isolated-m1-23e`.
- **Warnings:** MSVC C4996 on `fopen` / `getenv` in some translation units (pre-existing patterns); LNK4075 manifest notice on test projects.

## 9. Snapshot size and compatibility

- New fields are **additive**; Node accepts older snapshots without WP8A keys.
- No change to terrain cap logic; full Node suite still includes 256 KiB terrain verifier.

## 10. Known limitations and risks

- **Ground instance targeting** for a future PICKUP command may still need a dedicated design if fair-play ground observations remain partially anonymous — called out in the WP8A implementation doc.
- **actionCosts** research “usable” in test harness without geoscape is optimistic; live game path uses real `SavedGame`.

## 11. GO / NO-GO for WP8B

**GO.** The snapshot exposes stable item ids, placement, ammo/explosive/medikit state, weight, and static inventory transfer costs via rules reference — suitable as the basis for inventory manipulation commands in WP8B, with ground identity noted as the main follow-up.

## 12. Suggested minimum WP8B scope

- Define command binding for **item-scoped** actions using **`battleItemId`** + current **`commandBinding`** freshness.
- Implement one vertical slice (e.g. **RELOAD** or **INVENTORY_MOVE** within a single section) using **`inventorySections[].transferCosts`** for TU validation hints, engine for legality.
- Resolve **ground-item instance** strategy for **PICKUP** if required by fair-play.

---

**Live battlescape:** No manual in-game session was required; behavior is covered by the automated suites above.
