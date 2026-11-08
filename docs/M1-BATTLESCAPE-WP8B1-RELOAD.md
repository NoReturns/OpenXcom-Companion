# M1 Battlescape WP8B1 — RELOAD tactical command

**Date:** November 6, 2026  
**Scope:** End-to-end **`RELOAD`** — first inventory-mutation command with explicit `BattleItem` identity for weapon and ammunition.

## 1. Command contract (schema_version 1)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | int | Must be `1`. |
| `command_id` | string | Existing command id format (companion core). |
| `command_type` | string | Must be **`RELOAD`**. |
| `actor_unit_id` | int | Player soldier unit id. |
| `weapon_battle_item_id` | int | `BattleItem::getId()` of the **hand-held firearm**. |
| `ammo_battle_item_id` | int | `BattleItem::getId()` of the **magazine instance** to load. |
| `snapshot_sha256` | string | 64-char lowercase hex; must match last export. |
| `session_id` | string | 32-char lowercase hex; must match `eventLog.sessionId`. |
| `turn` | int | Must match tactical `turn`. |
| `state_version` | int | Must match `eventLog.latestSeq`. |

Weapon and ammo ids **must differ**. The Node publisher validates JSON shape in `companion/m0-publish/lib/tactical-command.cjs`; **`composeReloadCommand`** is in `command-binding.cjs`.

## 2. Supported scenarios (WP8B1)

- **Weapon:** Must be `BT_FIREARM`, `needsAmmo()` true, positive `clipSize`, carried in **`STR_LEFT_HAND` or `STR_RIGHT_HAND`** (must match `weapon_battle_item_id` to the hand item in the snapshot / engine).
- **Chamber:** **`getAmmoItem() == nullptr`** only — i.e. snapshot shows `noMagazineInserted: true`. This matches the **15 TU** insert path used by `BattleUnit::checkAmmo()` and inventory drag-to-weapon: **`setAmmoItem` returns -1 if a magazine is already present**, so magazine swap / partial replace is **out of scope for B1** (requires unload or a future command).
- **Ammunition:** `BT_AMMO`, **not** on the ground (`slot` not `INV_GROUND`), owned by the same unit, type must appear in weapon rules `compatibleAmmo`.
- **Ground ammunition:** **Not supported** (explicitly rejected in engine).
- **Research:** **`SavedGame` required**. Weapon and ammo **`getRequirements()`** must pass `SavedGame::isResearched` — **no permissive null-geoscape bypass** on the execution path.
- **TU:** **15** per engine convention (`BattleUnit::checkAmmo`, `Inventory::mouseClick` drag-to-weapon). Spent only after preflight passes; on `setAmmoItem` failure after spend, TU is restored (best-effort atomicity in `tryExecuteCompanionReload`).

## 3. Engine code paths

- **Execution:** `BattlescapeGame::tryExecuteCompanionReload` — mirrors **`BattleUnit::checkAmmo()`** after validation: `spendTimeUnits(15)`, `weapon->setAmmoItem(ammo)`, `ammo->moveToOwner(0)`, reload sound.
- **Validation core:** `CompanionCommandCore::parseReloadCommandJson`, `validateReloadCommand`.
- **Inbox:** `CompanionCommandRuntime` — same binding / journal / duplicate handling as other commands; result JSON includes `weapon_battle_item_id`, `ammo_battle_item_id`, and on success **`tu_spent`: 15**.

## 4. Node snapshot preflight (`validateReloadAgainstSnapshot`)

Preflight (non-authoritative vs engine) ensures:

- `weapon_battle_item_id` matches the firearm in **left or right hand** in the export.
- Hand firearm has **`noMagazineInserted: true`** (empty chamber in export terms).
- `ammo_battle_item_id` matches a row in `inventory[]` for that unit with `battleType === BT_AMMO`.

Engine remains authoritative for compatibility, TU, and actual mutation.

## 5. Unsupported / deferred

- Magazine replacement while a magazine is already inserted (partial/full) — use **`UNLOAD`** then a fresh **`RELOAD`** (WP8B2 + binding refresh); not one combined command.  
- PICKUP, DROP, inventory moves, automatic clip choice.  
- Ground reload.

## 6. Live gameplay test (operator)

1. New Battle or campaign: AI-owned soldier with **unloaded** rifle in hand (`noMagazineInserted`), spare clip in belt/pack with known `battleItemId` from F6 export.  
2. Publish `RELOAD` with matching binding.  
3. Confirm 15 TU spent, weapon `nestedAmmo` / `loaded` updated, clip removed from top-level inventory list as appropriate.

## 7. WP8B2 / magazine swap

- **`UNLOAD`** is specified in `M1-BATTLESCAPE-WP8B2-UNLOAD.md` (8 TU; magazine identity via `loaded_ammo_battle_item_id` / `nestedAmmo.battleItemId`).  
- Stricter Node preflight if snapshot adds per-item **compatibility hints** without widening fair-play leaks.

## 8. KNEEL interaction (WP8B1 verification)

- **`KNEEL` remote command** (`tryExecuteCompanionKneelDown`) only transitions **standing → kneeling** (rejects if already kneeling). It does **not** stand the soldier back up.
- Underlying `BattlescapeGame::kneel` is a **toggle** (4 TU down, 8 TU up), but the companion entry point only calls it when the unit is **not** kneeling, so **standing up requires a future explicit command or human UI** — not `KNEEL`.
- **`RELOAD`** does not call `kneel()` or change stance; it only spends reload TU and attaches ammo. A **kneeling** soldier reloads like a standing one if engine rules allow (same `checkReservedTU` / research / item checks).
