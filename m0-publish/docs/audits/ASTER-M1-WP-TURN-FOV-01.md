# ASTER-M1-WP-TURN-FOV-01 — TURN_FACE FOV / discovery audit and bounded test

**Authorization:** Audit + bounded harness test only. **No deploy, commit, or push.**  
**Context:** Nov 19 live test (Kees, West→North, 2 TU, F6=facing correct, sprite still West, no visible new terrain). [VISUAL-02](./ASTER-M1-WP-TURN-VISUAL-02.md) sprite fix present in source, **not** deployed to runtime at audit time.

## Executive summary

| Question | Verdict |
|----------|---------|
| Does companion `TURN_FACE` call native FOV in live battlescape? | **Yes** — per turn step inside `CompanionTurnFaceExecutionCore::executeTurnFace` when `BattlescapeGame::getTileEngine()` is non-null (live battles always have `SavedBattleGame::initUtilities`). |
| Does FOV mutate discovery state? | **Yes** — `TileEngine::calculateFOV(BattleUnit*)` sets `Tile::setDiscovered(true, *)` for player units (native rules). |
| Bounded test: turn toward undiscovered tile | **PASS** — companion path matches manual native turn loop on discovery. |
| Nov 19 live “no new terrain” | **Most consistent with outcome A** (nothing new in that arc) **plus sprite outcome B** (stale unit bitmap; VISUAL-02 not deployed). **No proven FOV/discovery engine defect** on the live path. |
| VISUAL-02 `cacheUnit` | **Does not touch** `TileEngine`, discovery flags, or FOV. |
| Deployment readiness (FOV) | **No engine FOV fix required** before deploy; **deploy VISUAL-02** for sprite. Optional post-deploy live check for genuinely unexplored arcs. |

---

## 1. Owner observation vs mechanisms

| Observation | Interpretation |
|-------------|----------------|
| F6 / logic North, 2 TU | Engine facing + TU path **consistent** with `executeTurnFace`. |
| Sprite West | **Unit map cache only** — [VISUAL-01](./ASTER-M1-WP-TURN-VISUAL-01.md); not FOV. |
| No newly revealed terrain | Either **no undiscovered tiles** in the new LOS cone, and/or operator expectation tied to **sprite** still showing old facing (misread of “what changed”). Terrain redraw uses `Tile::isDiscovered(2)` each draw — not unit cache. |
| Other soldier MOVE did not fix Kees sprite | Expected — other units do not rebake this unit’s sprite without `cacheUnit` on Kees ([VISUAL-01](./ASTER-M1-WP-TURN-VISUAL-01.md)). MOVE may refresh **that** actor’s FOV/discovery, not Kees’s facing bitmap. |

---

## 2. Outcome classification (A / B / C)

| ID | Definition | Evidence for Nov 19 |
|----|------------|---------------------|
| **A** | No new terrain to reveal (already discovered in save) | Plausible; cannot disprove without pre-turn tile state on that mission. FOV still runs; may discover **zero new** cells. |
| **B** | State updates, display stale | **Proven for unit sprite** (undeployed VISUAL-02). **Not proven for terrain** in code review; terrain is not cached like unit sprites. |
| **C** | FOV / discovery fails in engine | **Not proven.** Relay harness uses `initUtilities`; core calls `calculateFOV` each step; bounded test discovers ahead tile. |

---

## 3. Exact FOV calculation path (live)

### 3.1 Call chain

```
CompanionCommandRuntime (TURN_FACE)
  → BattlescapeGame::tryExecuteCompanionTurnFace
      → CompanionTurnFaceExecutionCore::executeTurnFace
          loop while STATUS_TURNING:
            spendTimeUnits(1)
            BattleUnit::turn()
            TileEngine *te = game->getTileEngine()
            if (te) te->calculateFOV(actor)    // per octagonal step
      → (VISUAL-02) Map::cacheUnit — presentation only, post-success
      → companionUpdateSoldierInfoIfUiPresent(false)  // HUD; checkFOV=false
```

**`getTileEngine()`:** `BattlescapeGame` → `SavedBattleGame::getTileEngine()` (created in `initUtilities`).

**Not used:** `UnitTurnBState` (no animation queue). Native animated turn calls the same `calculateFOV` **once per think tick** per step ([`UnitTurnBState.cpp`](../../../../engine/OpenXcom/src/Battlescape/UnitTurnBState.cpp) ~L115–116).

### 3.2 What `calculateFOV(BattleUnit*)` does (discovery)

For `FACTION_PLAYER` ([`TileEngine.cpp`](../../../../engine/OpenXcom/src/Battlescape/TileEngine.cpp) ~L229–343):

- Uses **current** `unit->getDirection()` (or turret direction when strafe option applies).
- Marks LOS tiles `setVisible(+1)` and **`setDiscovered(true, 2)`** on floor/body; adjacent walls `setDiscovered(true, 0/1)`.
- Does **not** bypass fog rules; no companion shortcuts found in this path.

### 3.3 F6 / snapshot reflection

Terrain export includes only tiles with floor discovery ([`CompanionSnapshot.cpp`](../../../../engine/OpenXcom/src/Engine/CompanionSnapshot.cpp) / `CompanionSnapshotTerrainCapture` `isDiscovered(2)`). If FOV marks a tile discovered in RAM, the **next F6 export** should include it — same as native play.

---

## 4. Native vs companion comparison

| Aspect | `UnitTurnBState::think` | `executeTurnFace` (companion) |
|--------|-------------------------|-------------------------------|
| TU per step | 1 (when charging) | 1 |
| `turn()` | Yes | Yes |
| `calculateFOV(actor)` | **Every step** | **Every step** (if TileEngine present) |
| `setCache` + `cacheUnit` | Every step | **Only post-success** in VISUAL-02 (once) |
| `Map::invalidate` | Via `BattlescapeGame::think` when battle states run | **Not called** on sync companion return (same as kneel/inventory sync family) |
| Presentation | Animated | Instant snap |

**Conclusion:** FOV **semantics align** with native per-step updates; companion omits battle-state **animation** and (until VISUAL-02 deploy) **unit** cache refresh.

---

## 5. Rendering refresh (terrain vs sprite)

| Layer | Refresh driver after sync TURN_FACE |
|-------|-------------------------------------|
| **Unit facing bitmap** | Stale until `setCache(0)` + `cacheUnit` (VISUAL-02) — **proven defect class** pre-deploy. |
| **Terrain fog / discovered floor** | `Map::drawTerrain` reads `tile->isDiscovered(2)` each draw — **no separate terrain bitmap** tied to turn. Next `BattlescapeState` draw cycle should show new discovery without `cacheUnit`. |
| **Explicit map invalidate** | Used in `BattlescapeGame::think` during active `BattleState` stacks (~L1058), **not** after sync companion executors. Theoretical same-frame lag until next draw timer; not observed as discovery failure in harness. |

---

## 6. Bounded visibility / discovery test

**Location:** `engine/OpenXcom/src/test/companion_turn_face_engine_test.cpp` (added in this WP, **not committed** per owner stop).

### 6.1 `testTurnFaceNoFovWithoutTileEngine`

- `initMap` only — **no** `initUtilities`.
- Undiscovered tile ahead; `tryExecuteCompanionTurnFace` **succeeds** but tile **stays** undiscovered.
- Documents **harness-only** gap; **not** live battlescape (relay E2E calls `initUtilities`).

### 6.2 `testTurnFaceFovDiscoversTerrain` (requires game data)

Setup (loaded xcom1 mod + `TileEngine`):

1. Open corridor; soldier at `(7,7)` facing **away** from `(11,7)`.
2. Clear discovery on `(11,7)`; `calculateFOV` while facing away → still undiscovered.
3. `tryExecuteCompanionTurnFace` toward `(11,7)` → **discovered(2)** on ahead tile.
4. Reset tile; repeat with **native** manual loop (`lookAt` + `turn` + `calculateFOV` per step, mirroring `UnitTurnBState`).
5. Same discovery result.

**Result (Release `build-s4j-rc`, 2026-11-19):** `companion_turn_face_engine_test: all tests passed` (includes map-cache tests from VISUAL-02 worktree).

---

## 7. VISUAL-02 interaction

Post-success block in `tryExecuteCompanionTurnFace`:

```cpp
unit->setCache(0);
map->cacheUnit(unit);
```

- **Does not** call or skip `calculateFOV`.
- **Does not** alter `Tile::setDiscovered`.
- **Cannot** explain Nov 19 terrain observation; **does** address sprite West/North mismatch once deployed.

---

## 8. Proven defects

| Defect | Status |
|--------|--------|
| FOV not called on live TURN_FACE | **Not proven** — code + bounded test contradict. |
| Discovery not written to tiles | **Not proven** — bounded test marks ahead tile discovered. |
| F6 export omits discovered tiles after turn | **Not investigated live**; export filter is discovery-based, not presentation-based. |
| Stale **soldier sprite** after turn | **Proven (pre-VISUAL-02 deploy)** — separate WP. |

---

## 9. Minimal correction recommendation

1. **Deploy [VISUAL-02](./ASTER-M1-WP-TURN-VISUAL-02.md)** to runtime — addresses observed sprite/facing paint lag; **no FOV code change**.
2. **Live re-test** (owner): pick soldier with **known** black/unexplored tile in the turn arc; TURN_FACE toward it; confirm terrain **and** F6 terrain pack gain cells. If terrain stays black while F6 shows discovery, open **map-invalidate** follow-up (`getMap()->invalidate()` after successful sync turn) — **not required** by current harness evidence.
3. **Do not** add companion-only LOS or discovery shortcuts.

---

## 10. Deployment readiness verdict

| Area | Ready? |
|------|--------|
| FOV / fog / discovery logic | **Yes** — no additional engine fix identified. |
| Sprite presentation | **Blocked on VISUAL-02 binary deploy** (FOV independent). |
| Regression gates | **PASS** — `companion_turn_face_engine_test` (incl. FOV scenarios) on audited build. |
| Commit / push / runtime | **Not performed** (owner stop). |

**Owner review:** Nov 19 narrative fits **A + sprite B** far better than **C**. Proceed with VISUAL-02 deploy; use optional unexplored-tile live probe to close terrain question on that mission geometry.

---

## 11. Key references

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionTurnFaceExecutionCore.cpp` | FOV in turn loop |
| `engine/OpenXcom/src/Battlescape/UnitTurnBState.cpp` | Native per-step FOV + cache |
| `engine/OpenXcom/src/Battlescape/TileEngine.cpp` | Discovery in `calculateFOV` |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` | `tryExecuteCompanionTurnFace`, `getTileEngine` |
| `engine/OpenXcom/src/test/companion_turn_face_relay_e2e_harness.cpp` | `initUtilities` on relay path |
| `engine/OpenXcom/src/test/companion_turn_face_engine_test.cpp` | Bounded FOV tests |

**STOP** for owner review.