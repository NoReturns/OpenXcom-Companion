# ASTER-M1-WP10-MC-S4D — relay harness tile teardown repair

**Work package:** M1-WP10 — Stage S4D  
**Authorization:** Harness-only repair per S4C root cause. **No commit, push, deploy, or live relay.**

## Change summary

| Area | Action |
|------|--------|
| `companion_psi_panic_relay_e2e_harness.cpp` | `wp10DetachUnitFromTiles()` mirrors `SavedBattleGame::resetUnitTiles` clear footprint before `delete` |
| | `clearBattleUnits()` detaches tiles, deletes units, **`clearBattleItems()`** |
| | `wp10WireUnitTile()` uses `setUnitPosition` success + occupancy check |
| | `assertScenarioTileOccupancy()` / `assertNoStaleTileUnitReferences()` after each `setupPanicScenario` |
| | `runPsiRelayFixtureTileOccupancyRegression()` (reset → setup → reset → setup) at start of panic and MC relay suites |
| Production / CMake | **Unchanged** (no target-on-tile preflight; WP9 `CMakeLists.txt` not edited) |

## Stability — before vs after (bounded)

**Method:** Fresh relay directory before each run; **10 cycles per executable**; `build-isolated-m1-23e\bin\Release`.

| Executable | S4C baseline (15 / 10 cycles) | S4D after fix (10 cycles) |
|------------|-------------------------------|---------------------------|
| `companion_psi_panic_engine_test.exe` | **9 pass / 6 fail** (15 runs) | **10 / 10 pass** |
| `companion_psi_mind_control_engine_test.exe` | **4 pass / 6 fail** (10 runs) | **10 / 10 pass** |

**Single-run sanity (S4D build):** Both executables exit 0; relay logs show failed psychic roll → `COMPLETED` (no `PSI_*_APPLICATION_FAILED` on that path); duplicate idempotency cases pass.

## Regression gates (S4D run)

| Gate | Result |
|------|--------|
| `companion_psi_panic_engine_test.exe` | **PASS** |
| `companion_psi_mind_control_engine_test.exe` | **PASS** |
| `companion_command_test.exe` | **PASS** |
| `companion_snapshot_serialization_test.exe` | **PASS** |
| Node WP10 S1 + S3 (4 files, 21 tests) | **PASS** |

## Post-`psiAttack()` TU atomicity (S4D scope check only)

**Not changed.** In normal production flow, preflight uses `checkReservedTU` and executor re-checks `getTimeUnits()` before `psiAttack()`; failed roll always reaches successful `spendTimeUnits` on the green executor tests. The remaining edge (`psiAttack()` applied, `spendTimeUnits` false → `APPLICATION_FAILED` with 0 `tu_spent`) is **theoretically reachable** if TU is consumed between validate and spend on the same actor without going through relay preflight—companion instant psi does not model that race in harness. **Still tracked separately** from this fixture defect; no executor change without approval.

## Local build note (not S4D product change)

Incremental rebuild of psi test targets required linking **uncommitted** `CompanionMedikitExecutionCore.cpp` (already referenced by `BattlescapeGame.cpp`). **Tracked `CMakeLists.txt` unchanged per owner boundary.** Local `companion_psi_*_engine_test.vcxproj` under `build-isolated-m1-23e` was adjusted to compile that translation unit for this verification only—re-run CMake before release and fix WP9 inventory in the integrated WP9/WP10 deployment gate.

## Status

| Item | State |
|------|--------|
| S4C accepted | Yes |
| S4D harness repair | **Complete** |
| Fixture flake (relay 10/10) | **Resolved in sample** |
| TU post-attack edge | **Open** (documented) |
| Production deploy | **BLOCKED** (owner policy; no commit this stage) |

## STOP

Harness repair and bounded verification complete. Await owner commit/deploy authorization.