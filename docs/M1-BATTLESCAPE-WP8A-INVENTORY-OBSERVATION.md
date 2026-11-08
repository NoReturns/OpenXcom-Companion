# M1 Battlescape WP8A — Item-instance identity and inventory observation

**Date:** November 6, 2026  
**Scope:** Read-only battlescape observation (no new tactical commands).  
**Engine authority:** `BattleItem`, `BattleUnit`, `RuleInventory`, `RuleItem`; snapshot export in `CompanionSnapshot.cpp`.

## 1. Serialized fields (friendly roster soldiers)

Extended under each friendly unit’s existing **`hands`** and **`inventory[]`** entries (additive; old snapshots without these keys remain valid for the Node publisher).

### Per equipment row (hands.* or inventory[])

| Field | Type | Meaning |
|-------|------|---------|
| `battleItemId` | int | Stable `BattleItem::getId()` for this battle while the instance exists. |
| `itemType` | string | Ruleset type id (`RuleItem::getType()`). |
| `battleType` | int | Engine `BattleType` enum as integer. |
| `inventorySlotType` | string | `"hand"` / `"slot"` / `"ground"` from `RuleInventory` type (hands use `"hand"`). |
| `slot` | string | `RuleInventory::getId()` (e.g. `STR_BELT`, `STR_BACK_PACK`, `STR_RIGHT_HAND`). |
| `hand` | string | Only when `slot` is a hand: `"left"` or `"right"`. |
| `inventoryX`, `inventoryY` | int | Grid origin cell for **`INV_SLOT`** sections only; omitted for hands where the engine does not use grid placement for that slot. |

**Firearms (`BT_FIREARM`) — ammunition**

| Field | Type | Meaning |
|-------|------|---------|
| `nestedAmmo` | object | Magazine **inside** the weapon (if any): `battleItemId`, `ammoType`, `rounds`. Does **not** appear as a separate `inventory[]` row. |
| `loaded` | object | Chambered magazine state when rounds remain or magazine is present but dry: `ammoType`, `rounds`, `battleItemId`. |
| `empty` | bool | Weapon has a magazine with **zero** rounds (dry mag). |
| `noMagazineInserted` | bool | Distinct from dry mag: no magazine loaded at all. |

**Grenades**

| Field | Type | Meaning |
|-------|------|---------|
| `explosiveKind` | string | `"timed"` (`BT_GRENADE`) or `"proximity"` (`BT_PROXIMITYGRENADE`). |
| `primed` | bool | `fuseTimer >= 0` in engine terms. |
| `fuseTimer` | int | Present when primed / timed; engine fuse value. |

**Medikits (`BT_MEDIKIT`)**

| Field | Type | Meaning |
|-------|------|---------|
| `medikitCharges` | object | `heal`, `painKiller`, `stimulant` from engine quantities. |

### Per friendly unit (top-level on unit object)

| Field | Type | Meaning |
|-------|------|---------|
| `carriedWeight` | int | `BattleUnit::getCarriedWeight(0)` (engine units, same as movement/encumbrance). |
| `strength` | int | `getBaseStats()->strength`. |
| `encumbranceRatio` | float | `strength / carriedWeight` when `carriedWeight > 0`; omitted when weight is 0. |

Existing fields (`kneeled`, `activeHand`, `actionCosts`, etc.) are unchanged.

## 2. Item identity lifecycle

- **Source of truth:** `BattleItem`’s integer id, allocated by `SavedBattleGame` via `getCurrentItemId()` (incrementing counter for the battle).
- **Stability:** Id stays the same while the instance exists, including when the item moves between inventory slots (only `RuleInventory` / coordinates change).
- **Uniqueness:** Two identical clips are distinct instances with distinct ids (validated in C++ and Node tests).
- **Nested magazine:** The magazine loaded in a firearm is still one `BattleItem`; it is serialized under `nestedAmmo` / `loaded` on the weapon and is **skipped** as a top-level `inventory[]` row so it is not double-counted.

## 3. Nested ammunition representation

- Export uses `weapon->getAmmoItem()` for chambered ammo.
- Spare magazines elsewhere in the pack appear as normal `inventory[]` rows with their own `battleItemId`.
- Laser-style weapons (`clipSize == -1`) do not use a separate ammo `BattleItem`; snapshot follows engine behavior (no `nestedAmmo` for those cases).

## 4. Weight and encumbrance

- **`carriedWeight`** is exactly `BattleUnit::getCarriedWeight(0)` (armor + unit inventory items + weight of loaded magazine when not the weapon itself).
- **`encumbranceRatio`** is informational: strength divided by carried weight when weight &gt; 0. The engine applies movement via its own recovery rules (`BattleUnit::handleRecovery` path); this snapshot does not invent a separate capacity model.

## 5. Rules reference: inventory sections and transfer TU

**Schema:** `schema_version` **2** (`CompanionRulesReferenceExportCore::RULES_REFERENCE_SCHEMA_VERSION`).

Top-level JSON includes:

- **`inventorySections`**: array of `{ "id", "sectionType", "transferCosts": [ { "destinationSlotId", "tu" }, ... ] }` built from each `RuleInventory` in the mod (`RuleInventory::getTransferCosts()` → ruleset `costs` map).

**Note:** Reload (15 TU), unload (8 TU), and ground pickup (6 TU) are **engine constants**, not part of the per-section `costs` map; the export documents this in `inventoryTransferCosts` limitation text.

**Compatibility:** Validators accept schema version **1 or 2**; v2 requires well-formed `inventorySections`.

## 6. Fair play and ground items

- Hostile inventories are **not** exported (unchanged).
- Ground block remains schema v1 with observation status and fair-play filters (unchanged WP9 model).
- Snapshot export does **not** add live ground `battleItemId` for hidden or unrevealed items.

## 7. Engine fix: headless / test `SavedBattleGame`

`SavedBattleGame::getGeoscapeSave()` previously assumed a live `BattlescapeState`. Unit tests and some export paths use `SavedBattleGame` without it, which caused a null deref when snapshot **actionCosts** consulted research via `getGeoscapeSave()`.

**Behavior now:** If `_battleState` or `getGame()` is null, `getGeoscapeSave()` returns **null**; `companionResearchUsable()` already treats a null save as “usable” for the purpose of avoiding false research blocks in those contexts.

## 8. `BattleItem::occupiesSlot` and nested ammo

Magazines loaded only inside a weapon may have **no** `RuleInventory` slot set. `occupiesSlot` now returns **false** when `_inventorySlot == nullptr`, so nested ammo does not falsely “occupy” grid cells.

## 9. Schema compatibility

- Tactical snapshot **schemaVersion 4 / 5** unchanged; new fields are optional on the Node side.
- Rules reference **schema_version 1** still accepted; **2** adds `inventorySections`.

## 10. Automated tests

**C++ (Release Win32, `build-isolated-m1-23e`):**

- `companion_snapshot_serialization_test.exe` — WP8 inventory, weapons, grenades, medikit/weight, existing snapshot regression tests.
- `companion_rules_reference_export_test.exe` — rules reference JSON including schema 2 inventory sections.

**Node (`companion/m0-publish`):**

- `node companion/m0-publish/scripts/run-all-node-tests.cjs` — full suite including `inventory-observation-wp8a.test.cjs`, equipment validation, rules-reference export tests.

## 11. Known limitations and WP8B dependencies

- **Ground PICKUP identity:** Safe live `battleItemId` for every ground stack may require a future design if the fair-play ground model stays type-oriented; document any command contract in WP8B.
- **Research flags in tests:** When `getGeoscapeSave()` is null, research gating in `actionCosts[].usable` is lenient; full campaign behavior still uses the real `SavedGame` in-game.
- **Corpse / carried body:** Represented per existing engine `BattleType` rules; WP8A does not add synthetic weapon-like actions.

## 12. Non-goals (WP8A)

**Historical (WP8A charter):** No RELOAD, UNLOAD, PICKUP, DROP, inventory move commands, or END_TURN changes — that package was observation-only. **`RELOAD` / `UNLOAD` are implemented in later WP8B work packages** (see `M1-BATTLESCAPE-WP8B1-RELOAD.md`, `M1-BATTLESCAPE-WP8B2-UNLOAD.md`); this document remains the WP8A observation baseline.
