# M1 Battlescape WP8B4 — PICKUP / DROP (ground inventory)

**Date:** 2026-11-06  
**Scope:** **`PICKUP`** — move one ground `BattleItem` from the actor’s **standing tile** into a carried section; **`DROP`** — move one carried item to **engine-chosen** ground coordinates on that tile. One command → one atomic inventory mutation. **No** relay publish instructions here — see `AGENTS.md` and `companion/m0-publish/docs/tactical-command-m1-20b.md`.

## 1. Fair-play snapshot rule

The Companion may only target ground items that appear under the actor’s **per-unit** `groundInventory` export (`CompanionSnapshot::appendActorGroundInventory`). That list mirrors **items on the unit’s current tile** in the engine ground grid (same tile as `unit->getPosition()`), not map-wide ground. Remote or undiscovered tiles do not populate another soldier’s `groundInventory`.

## 2. Command contracts (`schema_version` 1)

### 2.1 PICKUP

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | int | **`1`**. |
| `command_id` | string | Companion id format. |
| `command_type` | string | **`PICKUP`**. |
| `actor_unit_id` | int | Player soldier. |
| `item_battle_item_id` | int | Stable `BattleItem::getId()` of the ground item. |
| `ground_position` | object | **`{ x, y, z }`** — must equal the actor’s **tile** (same as snapshot `units[].position`). |
| `destination_slot` | string | Carried ruleset id (`STR_RIGHT_HAND`, `STR_BELT`, …). Not `STR_GROUND`. |
| `destination_x` / `destination_y` | int | Destination grid coords; **hands use 0,0**. |
| `snapshot_sha256`, `session_id`, `turn`, `state_version` | | Same binding rules as other tactical commands (`state_version` = `eventLog.latestSeq`). |

### 2.2 DROP

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | int | **`1`**. |
| `command_id` | string | Companion id format. |
| `command_type` | string | **`DROP`**. |
| `actor_unit_id` | int | Player soldier. |
| `item_battle_item_id` | int | Carried item id. |
| `source_slot` | string | Ruleset section where the item currently sits. |
| `source_x` / `source_y` | int | Optional; **paired** — if present, must match grid placement for `inventorySlotType: slot` rows (WP8B3 semantics). |
| `snapshot_sha256`, `session_id`, `turn`, `state_version` | | Same as above. |

**Drop destination:** The engine finds the first free ground cell via `companionFindFirstGroundPlacement`; the command does **not** carry arbitrary world or ground-grid coordinates.

## 3. Engine behavior (authoritative)

Reference: `BattlescapeGame::tryExecuteCompanionPickup`, `BattlescapeGame::tryExecuteCompanionDrop` in `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp`.

**PICKUP**

- `ground_position` must equal `unit->getPosition()`.
- Item must be on **ground** (`INV_GROUND`), on the **same tile** as the actor, `getOwner()==nullptr`.
- Rejects nested magazine (`isAmmo()` and `getSlot()==0`).
- TU: `STR_GROUND` → destination from `RuleInventory::getTransferCosts()`; `checkReservedTU` then `spendTimeUnits`.
- Placement: `fitItemInSlot` + overlap check (`companionInventoryOverlapItems`) before mutation; then `companionInventoryMoveItemForUnit` + `moveToOwner`.

**DROP**

- Item must be **carried** by the actor (`getOwner()==unit`), not already on ground.
- Rejects nested magazine.
- TU: source section → `STR_GROUND` via transfer costs; reserved TU enforced.
- Placement: `companionFindFirstGroundPlacement` then `companionInventoryMoveItemForUnit` to ground rule.

**Primed explosives:** Pickup/drop paths do **not** add a primed block (unlike `INVENTORY_MOVE`). Vanilla inventory allows moving primed grenades when the UI would; engine remains authoritative.

## 4. Node (`tactical-command.cjs`)

- `parsePickupCommand` / `parseDropCommand`, `validatePickupAgainstSnapshot` / `validateDropAgainstSnapshot`.
- `validateTacticalCommandAgainstSnapshot` dispatches **`PICKUP`** and **`DROP`** explicitly (no fall-through to `MOVE`).
- Preflight: binding freshness; actor; **`ground_position`** matches actor `position` **as `[x,y,z]` array**; ground item resolved **only** from `actor.groundInventory` with unique `battleItemId`; optional hand **0,0** rule; rejects `nestedAmmo` ids; DROP matches INVENTORY_MOVE-style source identity.

## 5. Compose helpers (`command-binding.cjs`)

- **`composePickupCommand`** — requires `groundPosition` consistent with `player_soldiers[].position` from the binding (tile guard at author time).
- **`composeDropCommand`** — optional paired `sourceX`/`sourceY`.

## 6. Rejection codes (non-exhaustive)

Aligned with `CompanionCommandCore::validatePickupCommand` / `validateDropCommand` and engine `rejectReason` strings — e.g. `GROUND_POSITION_MISMATCH`, `GROUND_ITEM_NOT_KNOWN`, `ITEM_DOES_NOT_FIT`, `DESTINATION_OCCUPIED`, `INSUFFICIENT_TU`, `NESTED_AMMUNITION`, `TRANSFER_COST_UNAVAILABLE`, `INVALID_GROUND_DESTINATION`, `SOURCE_LOCATION_MISMATCH`, `PICKUP_START_FAILED`, `DROP_START_FAILED`.

## 7. Controlled live test (operator)

1. F6 export; confirm actor `groundInventory` and `battleItemId` for the tile.
2. Draft JSON (or `composePickupCommand` / `composeDropCommand`).
3. `node companion/m0-publish/publish-tactical-command-once.cjs --dry-run --path <draft>` then **`--publish`** only when authorized (`AGENTS.md`).
4. Verify terminal `tactical-result.json` and refreshed snapshot.

## 8. Limitations

- No adjacent-tile pickup; ground access is **actor tile only**, matching engine checks.
- Node does not prove ruleset fit without engine; may see engine rejects after preflight.
- No multi-item or swap in one command.

## 9. WP8B4V automated verification (summary)

Evidence and exact MSBuild / exe paths are in **`M1-BATTLESCAPE-WP8B4-COMPLETION-REPORT.md`**.

| Layer | What ran |
|-------|----------|
| Node | `node companion/m0-publish/scripts/run-all-node-tests.cjs` |
| C++ command core | `companion_command_test.exe` |
| Engine integration | `companion_pickup_drop_engine_test.exe` — success/rejection paths, TU/reserved TU, primed fuse preservation |
| Snapshot | `companion_snapshot_serialization_test.exe` — `groundInventory` export semantics |
| Full link | Isolated **`openxcom.exe`** (not copied to **`runtime\m0\bin\`**) |

**Live relay** (GitHub inbox + real F6) remains a separate gate — not exercised in WP8B4V.
