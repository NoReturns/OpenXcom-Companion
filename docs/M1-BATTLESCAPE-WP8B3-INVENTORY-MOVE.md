# M1 Battlescape WP8B3 — INVENTORY_MOVE tactical command

**Date:** 2026-11-06  
**Scope:** **`INVENTORY_MOVE`** — relocate one carried `BattleItem` by stable id between allowed soldier inventory sections (one atomic engine transaction). Ground pickup/drop uses separate **`PICKUP`** / **`DROP`** commands — see **`M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md`** (WP8B4); `STR_GROUND` remains rejected here.

## 1. Command contract (`schema_version` 1)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | int | Must be **`1`**. |
| `command_id` | string | Companion command id format (unchanged). |
| `command_type` | string | Must be **`INVENTORY_MOVE`**. |
| `actor_unit_id` | int | Player soldier unit id. |
| `item_battle_item_id` | int | `BattleItem::getId()` of the item to move. |
| `source_slot` | string | Ruleset inventory id where the item **currently** sits (e.g. `STR_BELT`). |
| `destination_slot` | string | Target ruleset inventory id. |
| `destination_x` | int | Destination grid X (0–255); hands use **0,0** per engine semantics. |
| `destination_y` | int | Destination grid Y (0–255). |
| `source_x` | int | Optional; **must** pair with `source_y` when present (identity guard for grid slots). |
| `source_y` | int | Optional; must match snapshot/export coordinates when supplied. |
| `snapshot_sha256` | string | 64-char lowercase hex; must match last export bytes. |
| `session_id` | string | 32-char hex; must match `eventLog.sessionId`. |
| `turn` | int | Must match tactical `turn`. |
| `state_version` | int | Must match `eventLog.latestSeq`. |

**Excluded sections:** `STR_GROUND` is rejected for both source and destination (WP8B4 ground work is separate).

**Supported carried sections (when present in the active ruleset):** `STR_RIGHT_HAND`, `STR_LEFT_HAND`, `STR_BELT`, `STR_BACK_PACK`, `STR_RIGHT_SHOULDER`, `STR_LEFT_SHOULDER`, `STR_RIGHT_LEG`, `STR_LEFT_LEG`.

**Node:** `parseInventoryMoveCommand`, `validateInventoryMoveAgainstSnapshot` in `companion/m0-publish/lib/tactical-command.cjs`; **`composeInventoryMoveCommand`** in `command-binding.cjs`.

## 2. Engine behavior (authoritative)

Reference: `BattlescapeGame::tryExecuteCompanionInventoryMove` in `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp`.

- **Identity:** Command targets a single `BattleItem` by id; engine requires `item->getOwner() == actor` and a non-ground carried `getSlot()`.
- **Nested ammunition:** If `item->isAmmo()` and `item->getSlot() == nullptr` (magazine inside a weapon), the move is rejected — use **`UNLOAD`** first.
- **Primed explosives:** If fuse is active (`getFuseTimer() >= 0` for grenade/proximity types), move is rejected (`PRIMED_EXPLOSIVE_NOT_MOVABLE`).
- **Ground:** Source or destination ground inventory is rejected.
- **TU:** Lookup `RuleInventory::getTransferCosts()` from **source** section to **destination** section id; same-section moves use **0** TU in validation. Spending uses `checkReservedTU` then `spendTimeUnits` (consistent with other inventory mutations).
- **Placement:** `RuleInventory::fitItemInSlot` plus overlap check (`companionInventoryOverlapItems` / runtime helper) before mutation.
- **Commit:** `companionInventoryMoveItemForUnit` then `item->moveToOwner(unit)` (mirrors inventory move semantics).

## 3. Snapshot preflight (Node)

Preflight is **binding + actor + item placement identity**; it does **not** replace engine geometry/TU/overlap checks when rules-reference geometry is absent.

- Fresh `snapshot_sha256`, `session_id`, `turn`, `state_version`.
- Actor is a player soldier row in `units` (same faction rules as other commands).
- Rejects `STR_GROUND` on source or destination early.
- Resolves the item by `battleItemId` across `hands` + `inventory[]`; must be **exactly one** match (ambiguous duplicates are rejected).
- `source_slot` must equal the snapshot `slot` for that item.
- Optional `source_x` / `source_y`: if both are set, they must match `inventoryX` / `inventoryY` when the row uses `inventorySlotType: slot`.
- Rejects ids that appear as **`nestedAmmo.battleItemId`** on a hand-held firearm (unload path only).
- Rejects grenade/proximity rows with **`primed: true`** (aligned with engine primed blocking).

## 4. Two-handed semantics

No special-case weapon list in Companion: legality is **`RuleItem` size** + **`RuleInventory` slot shape** + occupied cells. A two-handed *accuracy* profile does not automatically mean a weapon occupies both hand slots — the engine’s `fitItemInSlot` / overlap rules decide.

## 5. RELOAD / UNLOAD integration

After **`UNLOAD`**, a magazine is a normal carried item (typically left hand). A follow-up **`INVENTORY_MOVE`** can stow it using a fresh binding — then **`RELOAD`** can target a spare clip by id. Each step remains **one** command and **one** export binding.

## 6. Controlled live test (operator)

1. AI-assigned soldier (`companion-soldier-control.json`), executor enabled per runbook.
2. F6 export → confirm item `battleItemId`, `slot`, and grid coords in YAML.
3. Compose `INVENTORY_MOVE` with `composeInventoryMoveCommand` (or hand JSON matching the schema).
4. `node companion/m0-publish/publish-tactical-command-once.cjs --dry-run --path <draft>` then **`--publish`** only when authorized (see `AGENTS.md` — no raw GitHub PUT).
5. Confirm `tactical-result.json` **`COMPLETED`** and `tu_spent` matches the ruleset transfer row used by the engine.

## 7. Known limitations (WP8B3)

- No ground **PICKUP** / **DROP**.
- No swap or multi-item choreography in one command.
- Node preflight does not replicate full `RuleInventory` geometry without rules-reference data; engine remains authoritative for fit/overlap/TU edge cases.
