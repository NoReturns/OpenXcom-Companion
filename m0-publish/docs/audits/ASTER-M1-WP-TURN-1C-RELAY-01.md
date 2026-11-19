# ASTER-M1-WP-TURN-1C — Relay integration (`TURN_FACE`)

**Status:** Complete (dispatch + synchronous terminal results). **Prerequisites:** WP-TURN-1a, WP-TURN-1b accepted.

## Summary

`TURN_FACE` is wired on the production tactical inbox path: `CompanionCommandRuntime::tickCompanionCommand` → `validateTurnFaceCommand` → `BattlescapeGame::tryExecuteCompanionTurnFace` → terminal `tactical-result.json` (**COMPLETED** or **REJECTED**). No `EXECUTING` / in-flight command state (same pattern as KNEEL/STAND).

## Files changed

| Area | Path |
|------|------|
| Runtime dispatch | `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` |
| Result re-parse (interrupt) | `engine/OpenXcom/src/Engine/CompanionCommandRuntimeSupport.{h,cpp}` |
| Relay harness | `engine/OpenXcom/src/test/companion_turn_face_relay_e2e_harness.cpp`, `companion_turn_face_relay_test.cpp` |
| Build | `engine/OpenXcom/src/CMakeLists.txt` (`companion_turn_face_relay_test`) |

**Unchanged:** Node contract (1a), engine executor (1b), other command types, reaction fire, HWP.

## Runtime flow

1. Inbox type `TURN_FACE` allowed (no longer `UNSUPPORTED_COMMAND_TYPE`).
2. `parseTurnFaceCommandJson` → journal / duplicate guards → `fillBindingValidationInput` + authority (`isCompanionMoveActor`, tactical AI set, soldier control).
3. `validateTurnFaceCommand` — binding, bounds, same horizontal XY, insufficient TU (steps + `checkReservedTU`).
4. Synchronous `tryExecuteCompanionTurnFace` — verify position unchanged.
5. `buildTurnFaceResultJson` → **COMPLETED** with `tu_spent`, `final_direction`, `remaining_tu`, `snapshot_sha256`, `inbox_sha256`; `CompanionRelayPublicationFreshnessCore::noteTacticalBattleMutation()`.

## Result JSON examples

**Success (2-step turn east):**

```json
{
  "schema_version": 1,
  "command_id": "turn-face-relay-ok",
  "command_type": "TURN_FACE",
  "status": "COMPLETED",
  "session_id": "<session>",
  "turn": 1,
  "actor_unit_id": 1,
  "target": { "x": 7, "y": 5, "z": 0 },
  "starting_position": { "x": 5, "y": 5, "z": 0 },
  "final_position": { "x": 5, "y": 5, "z": 0 },
  "remaining_tu": 48,
  "kneeled": false,
  "tu_spent": 2,
  "final_direction": 2,
  "snapshot_sha256": "<export digest>",
  "inbox_sha256": "<inbox digest>",
  "completed_at": "engine-local"
}
```

**Already facing (`tu_spent: 0`):**

```json
{
  "status": "COMPLETED",
  "command_type": "TURN_FACE",
  "tu_spent": 0,
  "final_direction": 2,
  "remaining_tu": 50
}
```

**Preflight reject (same horizontal XY):**

```json
{
  "status": "REJECTED",
  "command_type": "TURN_FACE",
  "public_reason": "Target must differ from actor position on the horizontal plane.",
  "reject_code": "INVALID_TARGET"
}
```

**Insufficient TU (no mutation at validation):**

```json
{
  "status": "REJECTED",
  "command_type": "TURN_FACE",
  "public_reason": "Not enough time units to turn.",
  "reject_code": "INSUFFICIENT_TU"
}
```

(When reject code is `INSUFFICIENT_TU`, runtime may attach TU accounting extensions via `applyResultJsonExtensions`, same as KNEEL.)

## Test results

| Suite | Result |
|-------|--------|
| `node --test companion/m0-publish/test/tactical-command-m1-wp-turn-1a.test.cjs` | **11/11 pass** |
| `companion_turn_face_engine_test.exe` (1b) | **all pass** |
| `companion_command_test.exe` | **all pass** (incl. parse/validate TURN_FACE) |
| `companion_turn_face_relay_test.exe` | **PASS** (Release `build-s4j-rc`) — full six-scenario suite after [FAILFAST-01](./ASTER-M1-WP-TURN-1C-FAILFAST-01.md) harness fixes (`STR_GROUND`, singleton + `resetScenario()`). |

## F6 / snapshot publication

Successful turns call `noteTacticalBattleMutation()` and bind terminal `snapshot_sha256` via `snapshotSha256ForTerminalCommandResult`. Next F6 export reflects updated `facing` and remaining TU on the actor; no new LOS or hidden-unit fields in the command result.

## Remaining integration gaps

| Gap | Notes |
|-----|--------|
| Live GitHub cooperative E2E | Out of scope (1c); use existing `publish-tactical-command-once.cjs` after deploy |
| Native relay harness stability | **Resolved** in FAILFAST-01 (harness lifecycle); no production follow-up |
| Node relay package test | Optional `tactical-command-m1-wp-turn-1c-relay.test.cjs` mirroring medikit S3 (engine is authoritative for 1c) |

## Owner checklist

- [x] Runtime recognizes `TURN_FACE`
- [x] Synchronous **COMPLETED** with `tu_spent` + `final_direction`
- [x] Preflight reject without partial turn
- [x] HWP / non-roster rejected via binding + executor authority
- [x] No `EXECUTING` lifecycle for turn-only
- [x] No commit/deploy/push

**STOP — WP-TURN-1c.**