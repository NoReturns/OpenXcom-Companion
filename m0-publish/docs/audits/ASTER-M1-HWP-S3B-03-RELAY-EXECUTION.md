# ASTER-M1-HWP-S3B-03 — HWP_MOVE relay execution

**Scope:** Integrate `HWP_MOVE` with production tactical relay inbox. **No runtime deployment** in this work package.

## Changed files

| Area | Path |
|------|------|
| Engine authority | `engine/OpenXcom/src/Engine/CompanionTacticalHwpAuthorityCore.{h,cpp}` — `hwpMoveRelayExecutionSupported()`, `validateHwpMoveExecutionPreflight` uses MOVE-only gate |
| Engine execution header | `engine/OpenXcom/src/Engine/CompanionTacticalHwpMoveExecutionCore.h` (comment) |
| Engine relay | `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` — `KIND_HWP_MOVE`, inbox branch, async completion |
| Engine tests | `companion_tactical_hwp_authority_test.cpp`, `companion_tactical_hwp_move_execution_test.cpp`, **new** `companion_hwp_move_relay_test.cpp`, `src/CMakeLists.txt` |
| Companion binding | `companion/m0-publish/lib/hwp-command-binding.cjs`, `command-binding.cjs`, `tactical-command.cjs` |
| Companion tests | `companion/m0-publish/test/tactical-command-m1-hwp-s3b-movement.test.cjs` |

## Relay execution call path

```
CompanionCommandRuntime::tick
  → inbox allowlist includes HWP_MOVE
  → parseHwpMoveCommandJson
  → journal / duplicate-idempotency (shared with MOVE)
  → fillHwpRemoteAuthorityInput
  → validateHwpMoveExecutionPreflight (authority + bounds + hwpMoveRelayExecutionSupported)
  → CompanionTacticalHwpMoveExecutionCore::tryStartHwpMove
  → BattlescapeGame::tryExecuteCompanionHwpMove
  → queueCompanionPlayerOrderedWalk → UnitWalkBState
  → tactical-result EXECUTING + ActiveCommand KIND_HWP_MOVE
  → tick in-flight: observeHwpMoveLifecycle → evaluateWalkTerminalStatus
  → terminal tactical-result (COMPLETED / INTERRUPTED / FAILED) once
```

Soldier `MOVE` path unchanged (`KIND_MOVE`, roster authority, `tryExecuteCompanionMove`).

## HWP-specific authority gates

- `evaluateHwpRemoteCommandAuthority` at preflight and completion (re-validation).
- `hwpTacticalCommandExecutionSupported()` remains **false** (blocks `validateHwpTacticalCommandExecutionPreflight` for FIRE/TURN).
- `hwpMoveRelayExecutionSupported()` is **true** for `HWP_MOVE` only.
- Rejects: human-owned HWP, destroyed/non-operational HWP, roster soldier id, stale snapshot/session/turn/state_version, battle busy / units falling / actor busy, illegal destination, prior non-terminal command, `HWP_FIRE` / `HWP_TURN` (unsupported type).

## Capability / binding schema

Additive, backward-compatible:

- `player_hwps[].commandExecutionSupported` — still **`false`** (global HWP execution flag).
- `player_hwps[].hwpMoveExecutionSupported` — **`true`** when relay MOVE is supported (Node publish validation for `HWP_MOVE`).
- Roster `player_soldiers` rules unchanged.

## Async lifecycle

- Start: `CMD_EXECUTING` while `UnitWalkBState` active (`game->isBusy()`).
- Completion: `observeHwpMoveLifecycle` + shared walk terminal semantics; no `COMPLETED` on queue alone.
- `noteWalkBattleActionPop` and `isMoveInFlight` cover `KIND_HWP_MOVE`.
- Session interrupt path builds interrupted `HWP_MOVE` result like `MOVE`.

## Test results

**Engine (Release `build-s4j-rc/bin/Release`, 2026-11-19):**

| Target | Result |
|--------|--------|
| `companion_tactical_hwp_authority_test` | PASS |
| `companion_tactical_hwp_move_execution_test` | PASS |
| `companion_move_player_ordered_engine_test` | PASS |
| `companion_hwp_move_relay_test` | PASS (bounded relay: reject gates, `HWP_MOVE` accept → `EXECUTING`, soldier `MOVE` regression, no premature `COMPLETED`; async terminal walk completion deferred to live battlescape — headless `handleState` walk AV) |

**Companion Node:** `tactical-command-m1-hwp-s3b-movement.test.cjs` — **8/8 PASS**

## Remaining deployment blockers

- Runtime pin / `openxcom.exe` deployment not updated in this WP.
- Live playbook and relay operator confirmation unchanged.
- `HWP_FIRE`, `HWP_TURN`, turret, and reaction policies out of scope.

## Recommended live-test procedure

1. Deploy engine build containing S3B-03 (after owner pins runtime).
2. Ensure `companion-soldier-control.json` has AI `hwp_assignments` for target tank.
3. F6 export; confirm `commandBinding.player_hwps[].hwpMoveExecutionSupported === true` and `commandExecutionSupported === false`.
4. Publish `HWP_MOVE` via CLI dry-run + publish; observe `EXECUTING` then terminal result with engine `final_position` / `remaining_tu`.
5. Replay same `command_id` — no second movement.
6. Regression: roster `MOVE` on AI soldier still works; human HWP rejects.