# ASTER-M1-HWP-S5-FIRE-AUDIT-01 — HWP directed fire (authorized read-only audit)

**Status:** **Authorized** — owner decisions required before S5-1a implementation  
**Date:** 2026-11-19  
**Mode:** Read-only — **no** `HWP_FIRE` relay or engine executor in this audit  
**Prerequisite:** HWP-S4 `HWP_TURN` live (`hwpTurnRelayExecutionSupported`, runtime pin `e4f6a4d9…`); HWP-S3B `HWP_MOVE`  
**Evidence:** `engine/OpenXcom/src`, `companion/m0-publish/lib`, live export `local/m0/tactical-live.yaml`, `ASTER-M1-HWP-SNAPSHOT-VALIDATION-02-RESULT.md`

**Operator context:** Two AI-owned tanks (Cannon + Laser) drive, rotate hull, and aim turrets independently. Firing is the next capability tranche.

---

## Owner decisions (lock before S5-1a)

| Question | Recommended default | Rationale |
|----------|---------------------|-----------|
| Command surface | **`HWP_FIRE`** with required **`fire_mode`**: `"snap"` \| `"aimed"` | Matches existing relay rejection tests; keeps soldier `SNAP_SHOT` / `AIMED_SHOT` ids out of HWP binding |
| Auto shot | **Exclude v1** | Cannon/Laser HWP weapons export only `snap` + `aimed` `actionCosts`; no `AUTO_SHOT` in live snapshot |
| Weapon identity | **`weapon_battle_item_id`** on `fixedWeapons[0].battleItemId` | Fixed turret item; not `active_hand` (HWP has no roster hand row) |
| Execution lifecycle | **Async** (soldier directed-fire stack) | Native path: `UnitTurnBState` (`targeting`) + `ProjectileFlyBState`; not synchronous like `HWP_TURN` |
| Node `nestedAmmo` on binding | **Normalize in S5-0** (publisher passthrough) | Validator accepts but does not copy `nestedAmmo` today — blocks honest ammo preflight on Cannon |
| Soldier fire paths | **Reuse engine only** — no edits to soldier parse/validate/relay branches | Call existing `tryExecuteCompanionDirectedFire` after HWP weapon resolution |

---

## Executive summary

| Topic | Finding |
|--------|---------|
| Cannon ammo | Magazine-style `nestedAmmo` + `loaded.rounds`; `companionFirearmHasAmmo` uses `weapon->getAmmoItem()`; each shot decrements clip in native `ProjectileFlyBState` |
| Laser Cannon | Energy firearm: live export has **no** `nestedAmmo`; `needsAmmo()` false → ammo checks pass without clip |
| Snap / Aimed TU | Engine `BattleUnit::getActionTUs(BA_SNAPSHOT\|BA_AIMEDSHOT, weapon)`; live Cannon snap **23** / aimed **56**; Laser snap **23** / aimed **52** (export `actionCosts`) |
| Turret aim | `UnitTurnBState` with `_turret = getTurretType() != -1 && targeting`; `ProjectileFlyBState::init` / companion executor `lookAt(target, turret=true)` |
| Facing advisory (Node) | **`buildDirectedFireCompositeHint` uses body/roster facing only** — HWP fire needs **turret-facing** step estimate (mirror `estimateHwpTurnFacing` with `turn_part: turret` semantics) |
| LOS / blocked target | Soldier preflight: `ProjectileFlyBState::companionPreflightVisibleUnitTargetBlocked`; HWP executor must reuse same probe with resolved fixed weapon |
| Reaction / reserve TU | `tryExecuteCompanionDirectedFire` → `checkReservedTU(unit, fireTu, true)` before push; turn steps in `UnitTurnBState` also spend TU and respect reserve |
| Terminal reporting | Soldier: `KIND_SNAP_SHOT` / `KIND_AIMED_SHOT` async journal through projectile complete; HWP needs parallel `KIND_HWP_FIRE` + result fields (`tu_spent`, ammo delta, optional `final_turret_direction`) |
| Today | Inbox rejects `HWP_FIRE` → `UNSUPPORTED_COMMAND_TYPE`; `hwpTacticalCommandExecutionSupported()` still **false** for non–per-type gates |

---

## 1. Cannon vs Laser — ammunition and energy behaviour

### 1.1 Native / engine

| Weapon | Rules type | Ammo model | Companion preflight (`companionFirearmHasAmmo`) |
|--------|------------|------------|--------------------------------------------------|
| **STR_TANK_CANNON** | `BT_FIREARM`, fixed | `setAmmoItem` clip; `needsAmmo()` true | Requires `getAmmoItem()` with `ammoQuantity > 0` |
| **STR_TANK_LASER_CANNON** | `BT_FIREARM`, fixed | No nested clip in export | `!needsAmmo()` → passes without magazine |

Fixed weapons: `RuleItem::isFixed()` — grenade prime/throw helpers already **reject** fixed items (`companionItemIsThrowableGrenade`, prime validation); directed fire **allows** fixed firearms.

### 1.2 Snapshot export (live battle)

**Cannon (`id` 1_000_000):**

- `fixedWeapons[0].battleItemId: 0` (engine-first item id — accepted by publisher S3B fix)
- `nestedAmmo`: `battleItemId: 1`, `ammoType: STR_HWP_CANNON_SHELLS`, `rounds: 30`
- `loaded`: mirrors magazine identity and round count
- `actionCosts`: snap (`actionType` 6) + aimed (7) only

**Laser (`id` 1_000_001):**

- `fixedWeapons[0].battleItemId: 2`
- **No** `nestedAmmo` or `loaded` block
- Same snap + aimed `actionCosts` shape

### 1.3 Relay implication

- Cannon commands must bind **`weapon_battle_item_id`** to the **fixed weapon** id (`0` in live battle), not the nested clip id (`1`), unless a deliberate split contract is chosen (not recommended — soldier fire uses hand weapon id only).
- Ammo exhaustion: terminal `COMPLETED` must reflect post-shot `loaded.rounds` / nested rounds on next F6 export; journal may optionally echo `rounds_remaining` if engine result JSON adds it in S5-1c.
- Laser: Node validates **no** `loaded_ammo_battle_item_id`; reject fire if exporter marks `empty: true` when that field exists.

---

## 2. `nestedAmmo` normalization and weapon identity

### 2.1 Publisher gap (blocking for honest Node preflight)

`validateFixedWeapon()` in `friendly-hwp-observation-v1.cjs` allows `nestedAmmo` in `WEAPON_KEYS` but **does not copy** validated `nestedAmmo` onto the output weapon object ([ASTER-M1-HWP-SNAPSHOT-VALIDATION-02-RESULT.md](./ASTER-M1-HWP-SNAPSHOT-VALIDATION-02-RESULT.md)).

**Effect today:** Engine export and `tactical-live.yaml` contain full nested ammo; **validated** tactical publish / binding strip may drop it → AI ammo awareness diverges from battle.

**S5-0 (pre-1a):** Passthrough `nestedAmmo` (and optionally `slot` / `hand` / `inventorySlotType`) on validated fixed weapons; extend `friendly-hwp-observation-v1.test.cjs`; pin fixture from live Cannon row.

### 2.2 Binding row

`mapPlayerHwpBindingRow` copies `fixedWeapons` verbatim from validated observation — once normalization is fixed, `player_hwps[].friendlyHwpObservationV1.fixedWeapons` carries ammo identity for compose/validate.

### 2.3 Engine resolution

Executor must locate `BattleItem *weapon` on HWP inventory by **`weapon_battle_item_id`** (same as melee `melee_weapon_battle_item_id` pattern for soldiers). Fixed item occupies `STR_RIGHT_HAND` in export but relay should **not** require `active_hand` string on HWP commands.

---

## 3. Snap Shot and Aimed Shot TU costs

### 3.1 Source of truth

| Layer | Mechanism |
|-------|-----------|
| **Runtime** | `unit->getActionTUs(BA_SNAPSHOT, weapon)` / `BA_AIMEDSHOT` |
| **Export advisory** | `fixedWeapons[].actionCosts[]` with `tuCost`, `canAffordTu`, `canAffordTuWithCurrentReservation` |
| **Node advisory (HWP)** | New `buildHwpFirePlanningHint`: fire TU from `actionCosts` by mode + **turret** `estimateHwpTurnFacing(actor, target, 'turret')` composite |

Soldier `buildDirectedFireCompositeHint` remains unchanged; HWP-specific hint avoids coupling HWP ids into soldier directed-fire validators.

### 3.2 AUTO_SHOT

HWP tank weapons in UFO / OpenXcom commonly lack meaningful auto mode. Live export shows **no** auto `actionCosts` entry. **v1 contract: reject `fire_mode: "auto"`** at Node parse. Revisit only if modded HWPs export auto affordances.

### 3.3 Reaction reserve

Export exposes `canAffordTuWithCurrentReservation` — engine enforces via `checkReservedTU` at fire preflight and per facing step in `UnitTurnBState`. Node should treat false as soft advisory only; engine is authoritative.

---

## 4. Turret alignment, targeting, trajectories, line of fire

### 4.1 Native call path (unchanged gameplay)

```
tryExecuteCompanionDirectedFire
  → _currentAction.targeting = true
  → statePushFront(UnitTurnBState)   // turret steps when getTurretType() != -1
  → statePushBack(ProjectileFlyBState)
```

- **Turret alignment:** `UnitTurnBState` constructor: `_turret = getTurretType() != -1 && (targeting || strafe)`.
- **Projectile origin:** `TileEngine::getOriginVoxel` uses turret direction when strafe/turret rules apply (`TileEngine.cpp` reads `getTurretDirection()` when `Options::strafe` and turret present for **some** LOS paths; companion fire does not set `strafe` — turret rotation via `lookAt(..., turret=true)` in turn + fly states).
- **Range:** `ProjectileFlyBState::init` — `distanceUnitToPositionSq`, `getMaxRangeSq()`, cannon-specific short-range diagonal exceptions (unchanged).
- **Ammo at init:** Empty clip / no ammo → pop state with `STR_NO_AMMUNITION_LOADED` / `STR_NO_ROUNDS_LEFT`.

### 4.2 Targeting modes

| Target | Relay contract |
|--------|----------------|
| Map tile (ground) | `target: { x, y, z }` — same as soldier directed fire |
| Visible unit | Tile of unit; engine `companionPreflightVisibleUnitTargetBlocked` rejects blocked visible hostile LOS when panic handled |

HWP **2×2 footprint:** Use anchor position from `friendlyHwpObservationV1.position` for advisory bearing; engine uses `BattleUnit::getPosition()` for voxel origin (existing native behaviour).

### 4.3 Independent hull vs turret

After S4, hull and turret facings may differ. Fire composite TU must count **turret** octagonal steps from `turretFacing` to bearing on target, not hull `bodyFacing`. Mis-estimating hull facing would under-report TU and cause surprise rejects.

### 4.4 Line of fire restrictions

Reuse soldier engine checks:

- `companionFirearmSupportsDirectedFire` (waypoints / guided weapons excluded)
- `getItemUsable(weapon)` research / battered flags
- `companionPreflightVisibleUnitTargetBlocked` for unit targets
- No new HWP-specific LOS shortcuts

**Out of scope v1:** `BA_LAUNCH` / fusion waypoints on HWP (if ever mounted).

---

## 5. Reaction-fire interactions and terminal reporting

### 5.1 Player-ordered HWP fire

- `tryExecuteCompanionDirectedFire` sets `playerOrdered = true` — same reaction policy as soldier companion fire.
- Interrupted walk/fire: HWP fire uses projectile stack, not `KIND_HWP_MOVE` — expect `INTERRUPTED` / `FAILED` semantics aligned with soldier directed fire when battle aborts mid-flight (panic, MC, death).
- **Reaction shots against the HWP** during AI turn: native battlescape behaviour unchanged; relay does not special-case.

### 5.2 Terminal result shape (proposed S5-1c)

Mirror soldier directed-fire result JSON where possible:

| Field | Notes |
|-------|--------|
| `status` | `COMPLETED` \| `REJECTED` \| `INTERRUPTED` \| `FAILED` |
| `tu_spent` | Fire TU + turn-in-place TU actually spent |
| `remaining_tu` | Actor TU after terminal |
| `final_turret_direction` | Optional but recommended when turret moved |
| `final_direction` | Hull facing if body coupling occurred during turn state (usually unchanged) |
| `weapon_battle_item_id` | Echo command |
| `fire_mode` | `snap` \| `aimed` |

Synchronous **`REJECTED`** at accept time (stale binding, no ammo, blocked LOS preflight, insufficient TU) must not mutate battle state.

### 5.3 Journal / runtime kind

Proposed: single runtime kind `KIND_HWP_FIRE` with `fire_mode` in parsed command — avoids duplicating soldier `KIND_SNAP_SHOT` / `KIND_AIMED_SHOT` completion handlers and keeps HWP authority on separate code path (parallel to `KIND_HWP_TURN` vs soldier turn).

---

## 6. Reuse of soldier firing infrastructure (no soldier behaviour change)

### 6.1 Reuse (call, do not fork)

| Component | Reuse |
|-----------|--------|
| `BattlescapeGame::tryExecuteCompanionDirectedFire` | **Yes** — after resolving fixed `BattleItem*` |
| `ProjectileFlyBState` / `UnitTurnBState` | **Yes** — unmodified |
| `companionFirearmHasAmmo` / `companionFirearmSupportsDirectedFire` | **Yes** |
| `ProjectileFlyBState::companionPreflightVisibleUnitTargetBlocked` | **Yes** — fill validation input in HWP preflight |
| Soldier `CompanionCommandRuntime` SNAP/AIMED branches | **No** — leave actor roster checks intact; add parallel HWP inbox branch |

### 6.2 New HWP-specific pieces (smallest slice)

1. **Node S5-1a:** `parseHwpFireCommand`, `composeHwpFireCommand`, `validateHwpFireAgainstSnapshot`, `buildHwpFirePlanningHint`; `hwpFireExecutionSupported` on `player_hwps[]` (default false until S5-1c).
2. **Engine S5-1b:** `parseHwpFireCommandJson`, `validateHwpFireExecutionPreflight`, `tryStartHwpFire` → directed fire entry.
3. **Engine S5-1c:** Relay inbox `HWP_FIRE`, `hwpFireRelayExecutionSupported()`, `KIND_HWP_FIRE` lifecycle + harnesses (Cannon + Laser).
4. **Publisher S5-0:** `nestedAmmo` passthrough (can land before 1a).

### 6.3 Authority gates (pattern from S3B/S4)

| Gate | FIRE expectation |
|------|------------------|
| `hwpTacticalCommandExecutionSupported()` | Remains **false** global lock |
| `hwpFireRelayExecutionSupported()` | New per-type flag, default **false** until harness green |
| `evaluateHwpRemoteCommandAuthority` | Same as MOVE/TURN — AI-owned, operational HWP |
| Roster `SNAP_SHOT` on HWP id | **Reject** at Node (mutual exclusion) |

---

## 7. Proposed `HWP_FIRE` relay contract (Node S5-1a draft)

```json
{
  "schema_version": 1,
  "command_id": "hwp-fire-example",
  "command_type": "HWP_FIRE",
  "actor_unit_id": 1000000,
  "fire_mode": "snap",
  "weapon_battle_item_id": 0,
  "target": { "x": 30, "y": 12, "z": 1 },
  "snapshot_sha256": "<64-hex>",
  "session_id": "<32-hex>",
  "turn": 1,
  "state_version": 42
}
```

| Field | Rule |
|-------|------|
| `fire_mode` | Required `"snap"` or `"aimed"` |
| `weapon_battle_item_id` | Must match exactly one `fixedWeapons[].battleItemId` on actor |
| `target` | In map bounds; for unit shots, center tile of target unit |
| Binding | `player_hwps`, `controlMode: "ai"`, `hwpFireExecutionSupported: true` (when live) |

---

## 8. Test requirements (before S5-1c flip)

| Tier | Cases |
|------|--------|
| **Node** | Compose/parse; stale binding; wrong weapon id; laser vs cannon ammo rules; out of bounds; `fire_mode` enum; mutual exclusion with soldier fire types |
| **Engine unit** | Fixed weapon resolve; insufficient TU; empty cannon clip; laser fire without clip |
| **Engine integration** | `companion_hwp_fire_engine_test` — Cannon snap + aimed; Laser snap; blocked visible target reject |
| **Relay** | `companion_hwp_fire_relay_test` — async COMPLETED; journal; TU + turret facing echo |
| **Regression** | Soldier `SNAP_SHOT`/`AIMED_SHOT` harnesses unchanged; HWP MOVE/TURN tests green |

---

## 9. Phased delivery

| Phase | Deliverable |
|-------|-------------|
| **S5-0** | `nestedAmmo` / fixed-weapon passthrough normalization |
| **S5-1a** | Node contract + tests + hints (**this audit acceptance**) |
| **S5-1b** | Engine preflight + `tryExecuteCompanionDirectedFire` wiring |
| **S5-1c** | Relay async lifecycle + `hwpFireRelayExecutionSupported()` |
| **S5-1d** | Live deploy doc + Cannon/Laser drill (owner) |

---

## 10. Key sources

| Area | Files |
|------|--------|
| Directed fire executor | `BattlescapeGame.cpp` (`tryExecuteCompanionDirectedFire`) |
| Projectile / LOS | `ProjectileFlyBState.cpp` |
| Soldier relay | `CompanionCommandRuntime.cpp` (SNAP/AIMED branches) |
| HWP authority pattern | `CompanionTacticalHwpAuthorityCore.{h,cpp}` |
| HWP turn (turret TU model) | `tu-composite-advisory.cjs` (`estimateHwpTurnFacing`) |
| Snapshot weapons | `CompanionSnapshot.cpp` (`buildEquipmentItemNode`, fixedWeapons) |
| Publisher gap | `friendly-hwp-observation-v1.cjs` |

---

## Audit authorization checklist

- [x] Audit persisted (this document)
- [x] Cannon vs Laser ammo behaviour documented
- [x] `nestedAmmo` normalization called out as S5-0 prerequisite
- [x] Snap/Aimed TU and turret facing advisory gap identified
- [x] Turret targeting / native stack documented
- [x] Reaction + terminal reporting aligned with soldier async fire
- [x] Soldier path isolation explicit
- [ ] Owner accepts decisions table → unlock **S5-0 / S5-1a**

**STOP** — no `HWP_FIRE` implementation until owner accepts this audit.