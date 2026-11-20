# ASTER-M1-MC-02B — Mind-controlled hostile remote execution (final delivery)

**Date:** 2026-11-20  
**Status:** **Owner-accepted** (`MC-02B-ACCEPTED-CHECKPOINT-01`)  
**Scope:** Native relay execution for AI-owned, X-COM-controlled hostiles (`MC_*` commands). No runtime deployment or canonical build-pin change in this checkpoint.

## Summary

MC-02B delivers binding schema v3 `player_mc_hostiles`, native inbox handlers, Battlescape execution hooks, and certification harnesses proving **terminal** `MC_MOVE`, **negative authority**, **posture policy** (stock kneel rules), and **`MC_TURN_FACE`** with correct relay typing.

## Implementation

### Engine (`OpenXcom`, branch `aster/m0`)

| Area | Files / symbols |
|------|-----------------|
| Authority | `CompanionTacticalMcHostileAuthorityCore` — binding, roster/HWP identity guards, stale binding, `WRONG_TURN`, `NOT_AI_CONTROLLED` |
| Move execution | `CompanionTacticalMcHostileMoveExecutionCore` — `tryStartMcMove`, `observeMcMoveLifecycle` |
| Posture validation | `CompanionTacticalMcHostilePostureExecutionCore` — preflight for `MC_TURN_FACE`, `MC_KNEEL`, `MC_STAND` |
| Relay runtime | `CompanionCommandRuntime` — `MC_MOVE`, `MC_TURN_FACE`, `MC_KNEEL`, `MC_STAND` inbox + in-flight `MC_MOVE` lifecycle; turn-face results echo `cmd.commandType` |
| Battlescape | `BattlescapeGame::tryExecuteCompanionMcMove/TurnFace/KneelDown/StandUp` — MC move via `UnitWalkBState`; kneel/stand **stock `SOLDIER` gate only** (no alien kneel invention) |
| Ownership / UI | `SavedBattleGame` MC AI assignment; `CompanionBattlescapeOwnershipCore`, `InventoryState` MC toggle; snapshot/control publish + ownership parsers |
| Tests | `companion_tactical_mc_hostile_authority_test`, `companion_tactical_mc_hostile_move_execution_test`, `companion_mc_hostile_move_relay_terminal_test` |

### Companion Node (`OpenXcom-Companion`, branch `main`)

| Area | Files |
|------|-------|
| Binding | `mc-hostile-command-binding.cjs`, `command-binding.cjs` schema v3, `soldier-control-relay.cjs`, `tactical-command.cjs` composers/validators |
| Publish | `tactical-publish.cjs` MC sparse observation keys |
| HWP hygiene | `hwp-command-binding.cjs` disjoint `mc_hostile_assignments` |
| Tests | `tactical-command-m1-mc-s2a-ownership.test.cjs`, `tactical-command-m1-mc-s2b-execution.test.cjs`, fixture `xcom-mc-hostile-observation-v5.yaml` |

## Supported commands (when binding + native gates allow)

| Command | Execution | Certification |
|---------|-----------|---------------|
| `MC_MOVE` | Relay + `UnitWalkBState` terminal walk | Terminal harness: adjacent `COMPLETED`, TU + position |
| `MC_TURN_FACE` | Immediate engine turn (stock turn-face core) | Terminal: `COMPLETED`, `command_type: MC_TURN_FACE`, TU spent, no movement |
| `MC_KNEEL` | — | **Rejected** for stock aliens (`INVALID_ACTOR`); matches stock kneel (`SOLDIER` only) |
| `MC_STAND` | — | **Rejected** for standing aliens (`INVALID_ACTOR` / `ALREADY_STANDING`) |

## Rejected commands / conditions (representative)

| Condition | Typical `reject_code` |
|-----------|----------------------|
| Human / reclaimed MC hostile | `NOT_AI_CONTROLLED` |
| Stale snapshot / state_version / session / turn | `STALE_*`, `WRONG_TURN` |
| Roster soldier or friendly HWP as MC actor | `INVALID_ACTOR` |
| Alien kneel / stand | `INVALID_ACTOR`, `ALREADY_STANDING` |
| Authority lost mid-`MC_MOVE` | `INTERRUPTED` (no post-cancel movement/TU) |
| MC execution gates off (build-time) | `MC_EXECUTION_NOT_SUPPORTED` |

## Certification evidence (2026-11-20, Release `build-s4j-rc/bin/Release`)

### Native executables (exit 0)

| Target |
|--------|
| `companion_tactical_mc_hostile_authority_test` |
| `companion_tactical_mc_hostile_move_execution_test` |
| `companion_mc_hostile_move_relay_terminal_test` |
| `companion_tactical_hwp_authority_test` |
| `companion_hwp_move_relay_terminal_test` |
| `companion_tactical_authority_test` |
| `companion_command_test` |

### Terminal harness highlights (`companion_mc_hostile_move_relay_terminal_test`)

| Case | Evidence |
|------|----------|
| Adjacent `MC_MOVE` | `COMPLETED` pos (3,2) tu 56 from 60 |
| Authority loss | `INTERRUPTED` pos 5,2 tu 64; post-cancel engine ticks: position/TU frozen; `isMoveInFlight` cleared |
| `MC_TURN_FACE` | `COMPLETED`, result `command_type: MC_TURN_FACE`, dir 2, TU 58 from 60 |
| `MC_KNEEL` / `MC_STAND` | `REJECTED`, no posture/TU change |
| Negatives | Stale binding, wrong turn, actor identity, human MC |

### Node (`companion/m0-publish`)

| Suite | Result |
|-------|--------|
| `tactical-command-m1-mc-s2a-ownership.test.cjs` | 4/4 |
| `tactical-command-m1-mc-s2b-execution.test.cjs` | 4/4 |
| `soldier-control-relay-p1b.test.cjs` | 11/11 (regression) |
| `tactical-command-m1-wp-turn-1a.test.cjs` | 11/11 (regression) |

## Known limitations

1. **`MC_KNEEL` / `MC_STAND`:** Envelope + relay preflight exist; engine deliberately **does not** enable alien kneeling (stock `BattlescapeGame::kneel` is `SOLDIER`-only). Companion must not treat these as operational on MC hostiles until stock gameplay supports them.
2. **`MC_TURN_FACE` vs roster `TURN_FACE`:** Shared result builder; roster commands still emit `TURN_FACE`; MC emits `MC_TURN_FACE`.
3. **In-flight MC authority:** Tactical assignment is re-evaluated live each tick; frozen control JSON from accept is not refreshed mid-walk (reclaim via battle assignment is sufficient for cancel).
4. **Terminal harness** requires full `BattlescapeState` + runtime data dir (`runtime/m0/bin`); headless `BattlescapeGame`-only tests cover queued walk and lifecycle observe only.
5. **Runtime pin:** Canonical `VERIFIED_BUILD_SHA256` in `companion-canonical-runtime.cjs` is **unchanged** in this checkpoint (no deployment).

## Hygiene (checkpoint)

- **Excluded from MC-02B commit:** CMake build trees, local scratch dirs, `companion-canonical-runtime.cjs` pin bump, unrelated melee audit doc edit.
- **Included:** All MC engine sources/tests listed above; Companion MC binding/tests/docs in this deliverable.