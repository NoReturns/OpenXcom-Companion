# ASTER-M1-WP-TURN-VISUAL-02 — TURN_FACE map sprite refresh (implementation)

**Authorization:** Owner accepted [ASTER-M1-WP-TURN-VISUAL-01](./ASTER-M1-WP-TURN-VISUAL-01.md).  
**Scope:** Engine presentation fix + focused harness coverage. **No commit, push, or deploy** in this WP.

## Executive summary

| Item | Result |
|------|--------|
| Fix | After successful synchronous `TURN_FACE`, call native sprite rebake: `unit->setCache(0)` + `Map::cacheUnit(unit)` when `getMap() != 0` |
| Sync relay lifecycle | **Unchanged** — still synchronous `COMPLETED` from executor |
| Animation | **None** — instant snap (no `UnitTurnBState`) |
| Tests | `companion_turn_face_engine_test`, `companion_turn_face_relay_test`, `companion_command_test` — **PASS** (Release, `build-s4j-rc`) |
| Live deployment | **Ready after owner review** — requires Release rebuild of `openxcom.exe` + runtime pin update (not performed here) |

---

## Exact diff

### `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp`

Inserted in `tryExecuteCompanionTurnFace` after TU / `finalDirection` outputs are set and **before** `companionUpdateSoldierInfoIfUiPresent`:

```diff
 	if (finalDirectionOut != 0)
 	{
 		*finalDirectionOut = outcome.finalDirection;
 	}
 
+	Map *map = getMap();
+	if (map != 0)
+	{
+		unit->setCache(0);
+		map->cacheUnit(unit);
+	}
+
 	if (_parentState != 0)
 	{
 		companionUpdateSoldierInfoIfUiPresent(false);
 	}
```

**Guard:** `getMap()` returns `BattlescapeState` map when present, else `_companionProjectileHarnessMap`; both may be null in headless unit tests — refresh is skipped safely.

**Unchanged paths:** `CompanionTurnFaceExecutionCore::executeTurnFace`, FOV inside turn loop, pre/post `updateSoldierInfo` / `companionUpdateSoldierInfoIfUiPresent`, rejection paths (no cache call on failure).

### `engine/OpenXcom/src/test/companion_turn_face_engine_test.cpp`

- Added optional `testMapCacheRefreshWhenMapAvailable(argv0)` using loaded game data + `BattlescapeState` (skips when `-data` assets unavailable).
- Verifies: reject path leaves TU/facing/cache stable; success path updates facing, rebakes cache (`!isCacheInvalid()`, cache surface non-null).
- `main` now `main(int argc, char **argv)` for data-dir discovery.

---

## Design alignment

| Requirement | How preserved |
|-------------|----------------|
| Synchronous `COMPLETED` | No `UnitTurnBState`; executor still returns immediately after mutation + refresh |
| TU / reservations | `executeTurnFace` unchanged |
| Facing / position gates | Cache refresh runs only after position check and successful outcome |
| FOV | Still inside `executeTurnFace` loop only |
| HUD | `companionUpdateSoldierInfoIfUiPresent(false)` still runs after map refresh |
| Kneel / directed fire | **No edits** — `kneel()` still uses `cacheUnits()`; directed fire still uses `UnitTurnBState` |
| Inventory UI | **No edits** |

**Mechanism:** Matches end-state behavior of `UnitTurnBState::think` (`setCache(0)` + `cacheUnit`) without per-frame animation.

---

## Test outcomes (2026-11-19, Release `build-s4j-rc`)

| # | Target | Command | Result |
|---|--------|---------|--------|
| 1 | TURN_FACE engine harness | `build-s4j-rc\bin\Release\companion_turn_face_engine_test.exe` | **PASS** (includes map-cache scenario when `runtime/m0/bin` data present) |
| 2 | TURN_FACE relay harness | `build-s4j-rc\bin\Release\companion_turn_face_relay_test.exe` | **PASS** |
| 3 | Companion command core | `build-s4j-rc\bin\Release\companion_command_test.exe` | **PASS** |
| 4 | Map-cache presentation | Embedded in (1) — BattlescapeState + real `Map` | **PASS** on this machine |
| 5 | Rejected commands | Existing engine cases + map test reject branch | **PASS** |
| 6 | Kneel / directed fire | Not modified; relay + command suites unchanged | **PASS** (no regression signal) |

**Note:** Full `openxcom.exe` Release link was **not** run in this WP (owner stop before deploy). Promotion path: rebuild `openxcom.vcxproj` Release, verify SHA gate, deploy to `runtime/m0/bin`, live TURN_FACE facing spot-check.

---

## Expected live behavior (post-deploy)

- Successful `TURN_FACE`: iso soldier **immediately** shows new facing (single-frame snap).
- TU bar updates via existing HUD refresh.
- No movement, no weapon fire, no extra TU beyond turn steps.
- Failed commands: no facing/TU change; no new cache refresh (reject before success block).

---

## Live deployment readiness

| Gate | Status |
|------|--------|
| Root cause addressed in source | **Yes** |
| Harness regression | **Green** |
| Behavior change localized to success path of `tryExecuteCompanionTurnFace` | **Yes** |
| Runtime binary updated | **No** (awaiting owner deploy WP) |
| Canonical SHA pin | **Stale** until rebuilt `openxcom.exe` promoted |

**Owner review:** Accept for deploy WP or request follow-up (e.g. optional stepped animation via `UnitTurnBState` — out of scope here).

---

## Related

- Audit: [ASTER-M1-WP-TURN-VISUAL-01.md](./ASTER-M1-WP-TURN-VISUAL-01.md)
- Engine baseline: [ASTER-M1-WP-TURN-1B-ENGINE-01.md](./ASTER-M1-WP-TURN-1B-ENGINE-01.md)

**STOP** — no commit, push, or deploy.