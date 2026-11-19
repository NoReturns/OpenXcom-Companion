# ASTER-M1-WP-TURN-1B — Engine execution (TURN_FACE)

**Status:** Complete (WP-TURN-1b scope only; no relay / WP-TURN-1c).  
**Prerequisite:** WP-TURN-1a Node contract accepted.

## Summary

Implemented synchronous `BattlescapeGame::tryExecuteCompanionTurnFace` using native `BattleUnit::lookAt` / `turn()` semantics (mirrors `UnitTurnBState::think` TU charging without pushing animated battle states). Added `CompanionCommandCore` parse/validate for `TURN_FACE` and focused C++ harnesses.

## Files changed

| Area | Path |
|------|------|
| Execution core | `engine/OpenXcom/src/Engine/CompanionTurnFaceExecutionCore.h`, `.cpp` |
| Executor | `engine/OpenXcom/src/Battlescape/BattlescapeGame.h`, `.cpp` (`tryExecuteCompanionTurnFace`) |
| Parse / validate | `engine/OpenXcom/src/Engine/CompanionCommandCore.h`, `.cpp` |
| Build | `engine/OpenXcom/src/CMakeLists.txt` (`CompanionTurnFaceExecutionCore.cpp`, `companion_turn_face_engine_test`) |
| Harness | `engine/OpenXcom/src/test/companion_turn_face_engine_test.cpp` |
| Command tests | `engine/OpenXcom/src/test/companion_command_test.cpp` (parse + same-XY validate) |

**Not in scope (unchanged):** `CompanionCommandRuntime` dispatch, relay inbox, Node contract, medikit/melee/psi paths.

## Authority and validation (executor entry)

- `CompanionTacticalAuthorityCore::isCompanionFriendlyRosterSoldierTarget` — live player roster soldier id range; rejects HWPs (`id >= MAX_SOLDIER_ID`) and non-soldier units.
- `companionMedikitActorAuthorized` — companion tactical AI admission when campaign save present (harness: no campaign → passes).
- Map bounds; reject target with same horizontal `(x,y)` as actor (Z may differ).
- Stale binding / busy battle checks consistent with other companion tactical executors.
- Preflight: `CompanionTuVisibilityCore::estimateDirectedFireFacingSteps` + `checkReservedTU` for kneel/fire reservations; **explicit** `steps > unit->getTimeUnits()` guard to reject under-TU turns with **no** partial facing mutation (see limitations).

## TU and completion behavior

| Case | Behavior |
|------|----------|
| Already facing bearing | Success, `tuSpent = 0`, no `lookAt` loop |
| N-step turn | `lookAt(target)` → while `STATUS_TURNING`: `checkReservedTU(1)`, `spendTimeUnits(1)`, `turn()`, optional `TileEngine::calculateFOV` |
| TU reported | `tuSpentOut = tuStart - tuRemaining` after loop; `finalDirectionOut` = `unit->getDirection()` |
| Success gate | Facing must equal `directionTo(target)`; position unchanged vs pre-turn |
| Failure | `abortTurn()` on reserve/TU failure mid-loop; preflight failures leave TU/facing unchanged |
| Lifecycle | Synchronous return from `tryExecuteCompanionTurnFace` (no `UnitTurnBState` stack / no premature relay `COMPLETED`; WP-TURN-1c owns async lifecycle) |

Step count uses `octagonalTurnSteps` (shortest arc), 1 TU per step — same estimate as directed-fire facing advisory.

## Harness results

Build: `build-s4j-rc`, target `companion_turn_face_engine_test` (Release).

```
companion_turn_face_engine_test: all tests passed.
```

Scenarios covered: 2-step clockwise, 1-step counter-clockwise, already-facing (0 TU), insufficient TU (no mutation), kneel-reserved TU block, HWP rejected, OOB + same-XY rejected, different-Z horizontal bearing.

`companion_command_test` (Release): added `testParseTurnFaceCommandJson`, `testValidateTurnFaceSameHorizontalRejected` — full suite green after rebuild.

## Native-engine limitations / notes

1. **Headless execution path:** Companion turn uses a tight `executeTurnFace` loop rather than scheduling `UnitTurnBState`, so there is no per-frame animation delay; FOV updates run when `TileEngine` exists (full game), skipped in minimal harness.
2. **`checkReservedTU` alone is insufficient for raw TU:** When no reserved shot mode applies, native `checkReservedTU` can return true even if `steps > getTimeUnits()`. Executor adds explicit total-TU preflight to meet the no-partial-mutation contract (aligned with player expectation, stricter than a single `UnitTurnBState` think tick in edge cases).
3. **WP-TURN-1c:** Runtime must not mark relay `COMPLETED` until any animated turn state finishes if dispatch later moves to `UnitTurnBState`; current API is intended for synchronous engine acceptance testing and direct executor calls.

## Owner review checklist

- [x] Soldier-only authority + HWP reject
- [x] Bearing target, not movement; no LOS requirement
- [x] Shortest-turn TU semantics + reserved TU
- [x] Already-facing 0 TU
- [x] No relay / commit / deploy
- [ ] WP-TURN-1c: `CompanionCommandRuntime` + lifecycle