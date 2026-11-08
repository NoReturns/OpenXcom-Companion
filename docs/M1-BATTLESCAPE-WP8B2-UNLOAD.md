# M1 Battlescape WP8B2 — UNLOAD tactical command

**Date:** 2026-11-06  
**Scope:** **`UNLOAD`** — remove the magazine currently inserted in a hand-held firearm (second inventory mutation after WP8B1 `RELOAD`).

## 1. Command contract (`schema_version` 1)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | int | Must be `1`. |
| `command_id` | string | Existing companion command id format. |
| `command_type` | string | Must be **`UNLOAD`**. |
| `actor_unit_id` | int | Player soldier unit id. |
| `weapon_battle_item_id` | int | `BattleItem::getId()` of the **hand-held firearm**. |
| `loaded_ammo_battle_item_id` | int | `BattleItem::getId()` of the **magazine instance currently attached** to that weapon (WP8A `nestedAmmo.battleItemId`). |
| `snapshot_sha256` | string | 64-char lowercase hex; must match last export. |
| `session_id` | string | 32-char lowercase hex; must match `eventLog.sessionId`. |
| `turn` | int | Must match tactical `turn`. |
| `state_version` | int | Must match `eventLog.latestSeq`. |

Weapon and magazine ids **must differ**. The magazine id is an **identity guard**: it must equal the engine’s authoritative `weapon->getAmmoItem()->getId()` at execution time.

**Node:** `parseUnloadCommand`, `validateUnloadAgainstSnapshot` in `companion/m0-publish/lib/tactical-command.cjs`; **`composeUnloadCommand`** in `command-binding.cjs`.

## 2. Engine behavior (verified from source)

Reference: `engine/OpenXcom/src/Battlescape/Inventory.cpp` **`Inventory::unload`**.

| Question | Answer |
|----------|--------|
| Must the weapon be in a hand? | **Yes** — must be in `STR_LEFT_HAND` or `STR_RIGHT_HAND` (same as companion `RELOAD`). |
| Does the other hand need to be empty? | **Yes** — the loop requires **no other item** in either hand slot besides the selected weapon (`STR_BOTH_HANDS_MUST_BE_EMPTY`). |
| Where does the magazine go? | **Left hand** (`moveItem` to `STR_LEFT_HAND` at 0,0), then `weapon` is moved to **right hand** at 0,0 — same ordering as UI unload. |
| UI cursor? | Drag uses a cursor; **`unload()`** applies changes **directly** to slots (no separate “cursor held” state in the save). |
| Destination automatic? | **Fixed layout**: left = magazine, right = gun after success. |
| Unload with both hands occupied? | **No** — rejects. |
| Empty / partial / dry magazines? | **Yes** — any `BattleItem` ammo attached via `setAmmoItem` is removed; rounds are preserved on the magazine `BattleItem`. |
| No magazine? | **`getAmmoItem()==0`** — unload returns false (companion: `NO_MAGAZINE_INSERTED`). |
| Ammunition-free weapon (`needsAmmo()` false)? | Rejects (`UNSUPPORTED_WEAPON` / no insertable magazine). |
| Rockets / special launchers | Supported only if they use the **same** nested-`BattleItem` magazine model (`needsAmmo()`, `clipSize > 0`, `BT_AMMO` loaded instance). Odd cases not matching that model are rejected. |
| Detachment | `weapon->setAmmoItem(0)` after moving items; magazine keeps the same **`BattleItem::getId()`**. |
| After detach | Weapon has **no** `getAmmoItem()`; magazine is a normal inventory item in **left hand** (final pose). |
| Research | Same **`SavedGame::isResearched`** checks on **weapon and magazine** rules as `tryExecuteCompanionReload` (not a separate “unload-only” bypass). |

**TU:** **8** — hardcoded in `Inventory::unload` (`spendTimeUnits(8)`). Companion execution uses **`checkReservedTU(..., 8, true)`** then **`spendTimeUnits(8)`** (mirrors reload’s 15 TU pattern).

**Stance:** Unload does **not** call kneel/stand toggles (same class of side effects as `RELOAD`).

## 3. Companion execution

- **Parser / validation core:** `CompanionCommandCore::parseUnloadCommandJson`, `validateUnloadCommand`.
- **Engine mutation:** `BattlescapeGame::tryExecuteCompanionUnload` — reproduces **`Inventory::unload`** item moves via a local `companionInventoryMoveItemForUnit` helper (equivalent to `Inventory::moveItem` for this path), then `setAmmoItem(0)`, **`Mod::ITEM_DROP`** sound.
- **Runtime / inbox:** `CompanionCommandRuntime` — journal, duplicate id, binding, AI ownership, busy gate — same pipeline as `RELOAD`.
- **Result JSON:** On success, **`tu_spent`: 8**, plus `weapon_battle_item_id`, `loaded_ammo_battle_item_id`.

### Reject codes (non-exhaustive)

| Code | Typical cause |
|------|----------------|
| `INVALID_WEAPON_INSTANCE` | Bad id / not owned / not found on unit |
| `WEAPON_NOT_IN_HAND` | Firearm not in a primary hand slot |
| `UNSUPPORTED_WEAPON` | Not `BT_FIREARM` or no insertable clip (`clipSize` / `needsAmmo`) |
| `NO_MAGAZINE_INSERTED` | `getAmmoItem()` null |
| `MAGAZINE_IDENTITY_MISMATCH` | `loaded_ammo_battle_item_id` ≠ inserted magazine id |
| `INCOMPATIBLE_AMMUNITION` | Inserted item not `BT_AMMO` |
| `UNLOAD_HANDS_NOT_FREE` | Other hand occupied |
| `RESEARCH_CONTEXT_UNAVAILABLE` | No campaign save for research checks |
| `RESEARCH_RESTRICTED` | `isResearched` failure on weapon or magazine |
| `INSUFFICIENT_TU` | Less than 8 TU or reserve failure |
| `UNLOAD_START_FAILED` | Engine `tryExecuteCompanionUnload` returned false (see `public_reason`) |

## 4. Node snapshot preflight (`validateUnloadAgainstSnapshot`)

Authoritative legality remains with the engine. Preflight checks:

- Binding freshness (same as other commands).
- Actor is a player soldier in the snapshot.
- `weapon_battle_item_id` matches the firearm in **left or right** `hands`.
- Hand firearm is `BT_FIREARM` and **not** `noMagazineInserted: true`.
- **`nestedAmmo.battleItemId`** present (WP8A) and equals **`loaded_ammo_battle_item_id`**.
- **Other hand is null** — mirrors engine “both hands free except weapon” rule; without this, unload would be rejected in-engine after a wasted planning step.

Legacy snapshots **without** `nestedAmmo` cannot be preflight-validated for identity; the engine still validates if a command is submitted through other means.

## 5. Interaction with RELOAD (magazine swap)

A full swap is typically **up to three** separate companion commands (each with its **own** fresh binding after F6 export), not two:

1. `UNLOAD` with correct `loaded_ammo_battle_item_id` → magazine in **left hand**, weapon **empty** in **right hand** (8 TU).
2. If **RELOAD** needs a clear hand or a different carried layout, **`INVENTORY_MOVE`** (WP8B3, `M1-BATTLESCAPE-WP8B3-INVENTORY-MOVE.md`) or the game UI — **one command per publish**, new snapshot before the next step.
3. Fresh snapshot → `RELOAD` with spare `ammo_battle_item_id` as in WP8B1 (15 TU, empty chamber).

When step 2 is unnecessary (layout already allows reload), the sequence is **two** commands: `UNLOAD` then `RELOAD`.

If **ordinary** OpenXcom hand layout prevents carrying a spare clip while respecting unload’s “other hand empty” rule, that is a **gameplay equipment constraint**, not something the remote layer bypasses.

## 6. Live test (operator)

1. AI-owned soldier, rifle **with** magazine, **other hand empty**, ≥ **8 TU**.
2. F6 export → confirm `nestedAmmo.battleItemId` on the hand firearm.
3. Publish `UNLOAD` via **`publish-tactical-command-once.cjs`** (dry-run, then publish) — **do not** hand-PUT GitHub per `AGENTS.md`.
4. Confirm `tactical-result.json` **COMPLETED**, `tu_spent: 8`, next export: `noMagazineInserted` on gun, magazine visible (typically **left hand** in engine terms after unload).

## 7. Limitations (WP8B2)

- No pickup/drop/inventory reposition commands; unload **does not** free belt space automatically.
- No multi-command orchestration in one inbox file.
- No automatic spare-magazine selection.
- Ground reload / ground unload — **out of scope** (reload already rejects ground ammo; unload targets inserted magazine only).
