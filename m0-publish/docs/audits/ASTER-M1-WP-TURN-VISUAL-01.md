# ASTER-M1-WP-TURN-VISUAL-01 — TURN_FACE battlescape presentation audit

**Work package:** Visual synchronization audit (live presentation defect)  
**Authorization:** **AUDIT ONLY** — no source changes, build, deploy, commit, or push.  
**Prerequisite context:** WP-TURN-1b synchronous executor, WP-TURN-1c relay path, WP-TURN-1d runtime deploy (`8b697b9d…` per deploy audit).

## Executive summary

| Question | Answer |
|----------|--------|
| Engine / relay truth likely correct? | **Yes (code-backed).** `CompanionTurnFaceExecutionCore::executeTurnFace` mutates facing and TU; `tryExecuteCompanionTurnFace` validates position; relay `COMPLETED` + F6 export are expected to reflect `final_direction` and TU. |
| Live symptom class | **Presentation lag:** map sprite facing (and optionally turn animation) does not update immediately; HUD TU may update if `companionUpdateSoldierInfoIfUiPresent` runs, but **map cache is not rebuilt** on the companion path. |
| Same family as inventory MOVE/PICKUP/DROP? | **Partially.** Inventory family shares **synchronous mutation + `companionUpdateSoldierInfoIfUiPresent`** (HUD bars / hand icons) but **does not** refresh an open `InventoryState` grid. TURN_FACE adds a **distinct map-sprite gap:** missing `Map::cacheUnit` / `setCache(0)` that native `UnitTurnBState` performs every turn step. |
| Reuse inventory HUD fix for TURN_FACE? | **Insufficient alone.** `companionUpdateSoldierInfoIfUiPresent` is already called post-turn; it does **not** rebuild battlescape unit sprites. |
| Recommended correction direction | **New map presentation hook** after successful turn: mirror native turn refresh (`unit->setCache(0); getMap()->cacheUnit(unit);`) and optionally `Map` redraw if needed; **do not** expect `companionUpdateSoldierInfoIfUiPresent` to fix facing. Optional follow-up: schedule `UnitTurnBState` for animated turns (larger scope). |

---

## 1. Reported symptom and audit scope

**Operator lead (historical):** Companion **INVENTORY_MOVE**, **PICKUP**, and **DROP** often showed:

- Engine mutation succeeded.
- Relay reported success.
- TUs were consumed.
- Battlescape HUD and/or inventory UI did **not** redraw until another UI refresh (camera nudge, close inventory, next local action, etc.).

**Current defect (TURN_FACE):** Same **truth vs paint** split is reported live: relay/F6 show new facing and spent TU, but the **unit on the map** may still display the pre-turn orientation until an unrelated refresh.

This audit compares code paths only (no live reproduction in this pass).

---

## 2. Historical inventory presentation audit (closest canonical sources)

There is **no** standalone document titled “inventory presentation-refresh audit.” The established record is spread across:

| Source | What it documents |
|--------|-------------------|
| `local/checkpoints/M1-LIFECYCLE-CLOSEOUT-2026-11-08/engine-tracked.patch` | Introduction of `BattlescapeGame::companionUpdateSoldierInfoIfUiPresent()` wired after companion inventory, kneel, reload, pickup/drop, etc. |
| `engine/OpenXcom/src/test/companion_command_test.cpp` (**P2-UI-REFRESH-02**, ~L2364) | While **inventory is open**, companion inbox polling does **not** run (`InventoryState` is top of stack); intentional limitation — not the same as stale grid after command with inventory **closed**. |
| `local/m0/audits/ASTER-PRODUCTION-DEEP-AUDIT-2026-11-09.md` (**ASTER-UI-03**) | Inventory open blocks companion tick — **INTENTIONAL LIMITATION**. |
| `local/m0/audits/ASTER-LIVE-TEST-MATRIX-2026-11-10-11.md` | RETRIEVE / inventory overlap expectations vs P2-UI-REFRESH-02. |

**Inventory-family correction that *was* shipped:** `companionUpdateSoldierInfoIfUiPresent` → `BattlescapeState::updateSoldierInfo`, updating TU/energy/health/morale bars and hand-item HUD widgets when `_parentState` exists.

**Inventory-family correction that *was not* shipped:** No engine helper walks the `Game` state stack to call `InventoryState::updateStats()`, `Inventory::arrangeGround()`, or `InventoryState::_refreshMouse()` when a remote mutation completes while inventory UI is open (local clicks still do this in `InventoryState.cpp`).

**Implication for TURN_FACE:** The partial HUD refresh explains **TU bar** catching up in some inventory cases; it does **not** explain **map facing** staleness.

---

## 3. Inspection areas

### 3.1 Battlescape rendering refresh / invalidation

**Native draw path:** `Map::drawUnit` blits pre-rendered surfaces from `BattleUnit::getCache(part)`. It does **not** re-read facing from sprites when the cache is stale; it uses whatever bitmap was last baked.

**Invalidation:** `BattleUnit::turn()` sets `_cacheInvalid = true` for visible or player-faction units (`BattleUnit.cpp` ~L860–861) but leaves existing `Surface*` entries in `_cache[]` until `Map::cacheUnit` rebuilds them.

**Rebuild trigger:** `Map::cacheUnit` only runs when code explicitly calls it (or `cacheUnits`). Ordinary `Map::animate` only recaches units with `getConstantAnimation()` armor (~L1423–1427).

**Companion TURN_FACE path:** After `executeTurnFace` completes, `tryExecuteCompanionTurnFace` calls `companionUpdateSoldierInfoIfUiPresent(false)` only — **no** `setCache(0)`, **no** `getMap()->cacheUnit(unit)`.

**Contrast — companion kneel (working map pose refresh):** `BattlescapeGame::kneel()` calls `getMap()->cacheUnits()` after posture change (`BattlescapeGame.cpp` ~L432–435). `tryExecuteCompanionKneelDown` delegates to `kneel()`.

**Contrast — companion directed fire:** Pushes `UnitTurnBState`, which each think-tick does `setCache(0)` + `cacheUnit` (`UnitTurnBState.cpp` ~L117–118).

| Path | Map sprite refresh after mutation |
|------|-----------------------------------|
| Native turn (`UnitTurnBState`) | **Yes** (per step) |
| Companion kneel | **Yes** (`cacheUnits`) |
| Companion directed fire (pre-shot turn) | **Yes** (via `UnitTurnBState`) |
| Companion TURN_FACE | **No** |

**Root mechanism (map facing):** Facing updates in savegame state; `_cacheInvalid` may be true; **bitmap on map stays old** until `cacheUnit` runs.

---

### 3.2 Unit sprite direction and animation state

**Logic / export:** `CompanionTurnFaceExecutionCore` runs a tight loop: `lookAt` → while `STATUS_TURNING`: spend 1 TU, `turn()`, optional `calculateFOV` (`CompanionTurnFaceExecutionCore.cpp` ~L96–124). Final direction must match `directionTo(target)`.

**Animation:** WP-TURN-1b deliberately **does not** push `UnitTurnBState` ([ASTER-M1-WP-TURN-1B-ENGINE-01.md](./ASTER-M1-WP-TURN-1B-ENGINE-01.md) § “Headless execution path”). Even after a cache fix, the soldier **snaps** to final facing on one frame — no stepped turn animation unless a follow-up WP schedules battle states.

**Status:** Loop ends with `STATUS_STANDING` when `_toDirection == _direction`; no walking/flying draw branch in `Map::drawUnit` for turn-in-place.

---

### 3.3 Native `UnitTurnBState` presentation updates

Per-cycle native behavior (`UnitTurnBState::think`):

1. `turn(_turret)`
2. `TileEngine::calculateFOV(_unit)`
3. `_unit->setCache(0)` — force cache invalidation flag via null cache
4. `_parent->getMap()->cacheUnit(_unit)` — rebake sprite with current direction / pose

Companion TURN_FACE replicates steps 1–2 inside `executeTurnFace` but **omits 3–4** entirely.

---

### 3.4 Synchronous Companion mutation refresh paths

**`tryExecuteCompanionTurnFace`** (`BattlescapeGame.cpp` ~L2796–2923):

| Phase | Presentation side effect |
|-------|---------------------------|
| Pre | `_parentState->updateSoldierInfo()` (full call, not guarded) |
| Execute | `executeTurnFace` — FOV only |
| Post success | `companionUpdateSoldierInfoIfUiPresent(false)` |
| Post success | `CompanionRelayPublicationFreshnessCore::notePlayerTacticalMutationIfSnapshotConfigured()` |

**Inventory MOVE pattern** (representative of WP8 family, ~L3853–3873): `companionUpdateSoldierInfoIfUiPresent(true/false)` around mutation; **no** `cacheUnit` for body facing (inventory layout change may affect hand sprites on HUD via `updateSoldierInfo`, not open inventory grid).

**Conclusion:** TURN_FACE already uses the **same HUD hook** as inventory commands. The facing defect is **not** fixed by duplicating only `companionUpdateSoldierInfoIfUiPresent`; it needs the **map cache hook** absent from both inventory and turn paths, but **only turn** visibly affects iso-map soldier orientation.

---

### 3.5 Existing inventory UI-refresh corrections vs TURN_FACE

| Layer | Inventory correction | Applies to TURN_FACE? |
|-------|---------------------|------------------------|
| TU / energy / morale HUD | `companionUpdateSoldierInfoIfUiPresent` | **Already present** post-turn |
| Open inventory grid | **None** in companion executors | N/A (facing); separate P2 if inventory open during remote ops |
| Map unit sprite | Kneel uses `cacheUnits`; turn uses **nothing** on companion sync path | **Gap — primary** |
| Stepped animation | N/A for inventory | **Gap — secondary** (by 1b design) |

---

## 4. Determination

**Classification:** **CONFIRMED PRESENTATION DEFECT (code-backed)** — synchronous companion turn completes engine state but skips map sprite rebake required for immediate facing display.

**Not the same primary fix as inventory HUD lag:** Inventory live lag was **partially** addressed by soldier info refresh; open-inventory staleness remains a **different** missing hook. TURN_FACE requires **`Map::cacheUnit`** (or equivalent) at minimum.

**Not implicated (based on static review):**

- Relay terminal publication / `final_direction` in result payload.
- WP-TURN-1c harness lifecycle (addressed in FAILFAST-01).
- P2-UI-REFRESH-02 inventory-open tick blocking (unless operator tests TURN_FACE with inventory open — command may not execute at all).

---

## 5. Recommended fix direction (owner review only — not implemented)

### 5.1 Minimal (recommended first)

After successful `executeTurnFace` in `tryExecuteCompanionTurnFace` (when `getMap() != 0`):

```cpp
unit->setCache(0);
getMap()->cacheUnit(unit);
```

Mirror the **end state** of native `UnitTurnBState::think`, not necessarily per-step calls inside the tight loop (final facing is what matters for static sprite).

**Precedent:** `kneel()` → `cacheUnits()`; `UnitTurnBState` → `setCache(0)` + `cacheUnit`.

**Harness gap:** `companion_turn_face_engine_test` runs without full `Map`/`BattlescapeState` in some scenarios — add or extend a **BattlescapeGame + Map** integration test that asserts cache invalidation → `cacheUnit` invocation if hooks are added (follow-up WP).

### 5.2 Optional / larger scope

- Push `UnitTurnBState` for companion-only turn (animated, relay `EXECUTING` until pop) — aligns with live UX and directed-fire pattern; conflicts with WP-TURN-1b/1c **synchronous COMPLETED** contract unless lifecycle is renegotiated.
- If map still fails to paint: investigate `Map::_redraw` / `Map::draw()` scheduling after sync mutation (secondary; cache miss is sufficient explanation for stale facing).

### 5.3 Do not do

- Rely on **`companionUpdateSoldierInfoIfUiPresent` alone** for map facing.
- Treat **inventory grid refresh** helpers as sufficient for TURN_FACE without map cache.

---

## 6. Verification plan (follow-up WP, not run here)

| Check | Method |
|-------|--------|
| Live facing | Deployed `openxcom.exe`; TURN_FACE via relay; observe iso sprite **before** any camera move / end turn |
| Truth | F6 export `facing` / `direction` vs on-map sprite |
| HUD TU | Soldier bar updates immediately (expected with current code) |
| Regression | `companion_turn_face_engine_test`, `companion_turn_face_relay_test`, kneel/fire paths unchanged |
| Animation expectation | Document **instant snap** unless UnitTurnBState path adopted |

---

## 7. Key file references

| File | Relevance |
|------|-----------|
| `engine/OpenXcom/src/Engine/CompanionTurnFaceExecutionCore.cpp` | Sync turn loop, FOV, no presentation |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` | `tryExecuteCompanionTurnFace`, `companionUpdateSoldierInfoIfUiPresent`, `kneel`, inventory executors |
| `engine/OpenXcom/src/Battlescape/UnitTurnBState.cpp` | Canonical `setCache` + `cacheUnit` per turn step |
| `engine/OpenXcom/src/Battlescape/Map.cpp` | `cacheUnit`, `drawUnit` cache blit |
| `engine/OpenXcom/src/Savegame/BattleUnit.cpp` | `turn()` sets `_cacheInvalid`; `setCache(0)` semantics |
| `engine/OpenXcom/src/Battlescape/BattlescapeState.cpp` | `updateSoldierInfo` HUD scope |
| `engine/OpenXcom/src/Battlescape/InventoryState.cpp` | Local-only grid refresh pattern |
| `companion/m0-publish/docs/audits/ASTER-M1-WP-TURN-1B-ENGINE-01.md` | Intentional sync / no `UnitTurnBState` |

---

## 8. Audit attestation

- **Changes made in this WP:** None (documentation only).
- **Build / deploy:** Not performed.
- **STOP** per owner mandate.