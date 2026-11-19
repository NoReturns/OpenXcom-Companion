# ASTER-M1-HWP-S3B-02 — HWP_MOVE native execution (engine)

**Date:** 2026-11-19  
**Engine base:** `a89112777e2bce42013460c0a2c67bf90a9c6fc1` (+ local S3B-02 delta, uncommitted)  
**Companion base:** `d62a580a254a87aa1ceba2ebb3c2092b021f5eb2` (unchanged this WP)  
**Scope:** Engine-side HWP movement execution foundation. **No live relay dispatch.**

---

## 1. Native movement call path (shared with roster MOVE)

| Stage | Implementation |
|-------|----------------|
| Path preview / validate | `SavedBattleGame::getPathfinding()->calculate(unit, dest)` inside `BattlescapeGame::queueCompanionPlayerOrderedWalk` |
| Queue walk | `statePushBack(new UnitWalkBState(this, _currentAction))` with `playerOrdered = true` |
| Soldier entry | `tryExecuteCompanionMove` → **roster-only guard** → `queueCompanionPlayerOrderedWalk` |
| HWP entry | `CompanionTacticalHwpMoveExecutionCore::tryStartHwpMove` → `tryExecuteCompanionHwpMove` → `queueCompanionPlayerOrderedWalk` |
| Authority | HWP: `validateHwpMoveCommand` + `evaluateHwpRemoteCommandAuthority` (not soldier `validateMoveCommand`) |
| Async steps | `BattlescapeGame::handleState` / `UnitWalkBState::think` (same as human / companion soldier walks) |
| Stop tokens | `CompanionWalkStopTokens` via `UnitWalkBState` → `CompanionCommandRuntime::noteWalkBattleActionPop` (soldier MOVE relay only today) |
| Lifecycle | `evaluateWalkTerminalStatus` + `resolveWalkStopDiagnostics` (reused for HWP via `observeHwpMoveLifecycle`) |

**Not shared:** Roster `validateMoveCommand`, `isCompanionMoveActor`, soldier relay `processMove` inbox path.

---

## 2. Implementation summary

### New

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionTacticalHwpMoveExecutionCore.{h,cpp}` | `tryStartHwpMove`, `observeHwpMoveLifecycle` |
| `engine/OpenXcom/src/test/companion_tactical_hwp_move_execution_test.cpp` | Focused execution harness |
| `engine/OpenXcom/src/test/companion_tactical_hwp_move_execution_test_main.cpp` | Test main |

### Changed

| File | Role |
|------|------|
| `BattlescapeGame.{h,cpp}` | `queueCompanionPlayerOrderedWalk`; `tryExecuteCompanionMove` soldier-only guard; `tryExecuteCompanionHwpMove` |
| `CompanionTacticalHwpAuthorityCore.h` | Clarify relay lock vs native executor |
| `CMakeLists.txt` | Link execution core; add test target |

**Unchanged:** `CompanionCommandRuntime.cpp` — `HWP_MOVE` not in inbox allowlist; `hwpTacticalCommandExecutionSupported()` still `false`.

---

## 3. Execution lifecycle (engine semantics)

| Phase | Behavior |
|-------|----------|
| **Rejected before walk** | Authority, binding, bounds, `BATTLE_BUSY`, `ACTOR_BUSY`, or path start failure (`MOVE_START_FAILED`). No `UnitWalkBState` queued. |
| **Started** | `tryStartHwpMove` returns `started=true`; `observeHwpMoveLifecycle` → `CMD_EXECUTING` while `battleBusy`. |
| **Completed** | After native walk idle at `requestedDest`: `CMD_COMPLETED` (same rules as roster MOVE). |
| **Interrupted** | Native `action.result` tokens only (`PATH_BLOCKED`, `REACTION_FIRE`, etc.) → `CMD_INTERRUPTED` + `resolveWalkStopDiagnostics`. |

Initiating a walk is **not** reported as arrival success (relay must not emit `CMD_COMPLETED` until `evaluateWalkTerminalStatus` says so).

---

## 4. Safety checklist

| Requirement | Status |
|-------------|--------|
| HWP authority via `CompanionTacticalHwpAuthorityCore` | Yes — `tryStartHwpMove` |
| Soldier MOVE not used for HWPs | `tryExecuteCompanionMove` rejects `id >= MAX_SOLDIER_ID` HWPs |
| HWP_MOVE not on soldier path | Separate `tryExecuteCompanionHwpMove` |
| Live relay lock | `hwpTacticalCommandExecutionSupported() == false` |
| Human / destroyed / stale HWP | Authority rejects (covered in execution + S3A tests) |
| No wall destruction / path invention | Reuses vanilla `Pathfinding` + `UnitWalkBState` only |

---

## 5. Test results (Release `build-s4j-rc`)

| Suite | Result |
|-------|--------|
| `companion_tactical_hwp_move_execution_test` | **PASS** |
| `companion_tactical_hwp_authority_test` | **PASS** |
| `companion_move_player_ordered_engine_test` | **PASS** |

Execution tests cover: relay preflight lock, 2×2 footprint fixture, no-path / occupied rejects, lifecycle diagnostics, authority rejects, soldier MOVE regression, busy/actor-busy guards. Full `UnitWalkBState` resolution with live map render requires `BattlescapeState` (planned S3B-03 relay integration / WP8-style harness).

---

## 6. Remaining blockers for live relay (S3B-03)

1. Add `HWP_MOVE` to `CompanionCommandRuntime` inbox allowlist **only when** owner flips `hwpTacticalCommandExecutionSupported()`.
2. Wire `tick` branch: parse → `tryStartHwpMove` → `CMD_EXECUTING` result; poll `observeHwpMoveLifecycle` + `noteWalkBattleActionPop` (mirror roster MOVE).
3. Use `buildMoveResultJson` (or HWP-specific result wrapper) with `WalkStopDiagnostics`.
4. Owner flip of relay execution lock with paired Node + operator runbook.

---

## 7. Recommended smallest S3B-03 integration

1. Engine: `processHwpMove` sibling of `processMove`; `ActiveCommand::KIND_HWP_MOVE` (or reuse `KIND_MOVE` with separate authority input — prefer **separate kind** to avoid soldier validators).
2. Flip `hwpTacticalCommandExecutionSupported()` to read owner config / compile flag.
3. Companion: no schema change; optional relay result `command_type` echo `HWP_MOVE`.
4. One E2E harness with `BattlescapeState` + short walk completion test (reuse guided-launch map shell).

---

## 8. STOP — owner review

No commit, push, or runtime deployment in this package.