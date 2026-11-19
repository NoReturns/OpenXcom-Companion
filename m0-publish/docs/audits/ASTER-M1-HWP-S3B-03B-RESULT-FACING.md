# ASTER-M1-HWP-S3B-03B — HWP_MOVE terminal `final_direction`

**Scope:** Additive relay reporting only — expose engine-observed hull facing on **terminal** `HWP_MOVE` results. **No movement logic, deployment, commit, or push.**

**Depends on:** ASTER-M1-HWP-S3B-03A terminal walk certification (accepted).

## Summary

| Requirement | Result |
|-------------|--------|
| `final_direction` on terminal `HWP_MOVE` | **Done** — `COMPLETED` and `INTERRUPTED` |
| Value from live `BattleUnit::getDirection()` at terminal observation | **Yes** |
| Soldier `MOVE` unchanged | **Yes** (no `final_direction` on roster `MOVE`) |
| Omit when actor unavailable | **Yes** (direction must be 0–7; `-1` omitted) |
| Existing position/TU/stop-reason/lifecycle preserved | **Yes** |

## Implementation

**File:** `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp`

1. `buildMoveResultJson(..., int engineObservedDirection = -1)` — backward-compatible default.
2. `insertHwpMoveFinalDirectionField()` — inserts `"final_direction": <n>` only when:
   - `command_type == "HWP_MOVE"`
   - `status` is `COMPLETED` or `INTERRUPTED`
   - `0 <= engineObservedDirection < 8`
3. **HWP in-flight completion** (`KIND_HWP_MOVE`): `engineObservedDirection = unit != 0 ? unit->getDirection() : -1`.
4. **Session-boundary interrupt** for inbox `HWP_MOVE`: same from resolved `actor` when present.

Soldier `MOVE` and `HWP_MOVE` `EXECUTING` payloads are unchanged (no `final_direction`).  
Binding-reset interrupt without battle actor resolution continues to omit `final_direction` (no invented value).

## Backward compatibility

- Additive JSON field on `HWP_MOVE` terminals only; schema_version remains `1`.
- Consumers that ignore unknown keys are unaffected.
- Mirrors optional `final_direction` pattern already used for `TURN_FACE` (different command type and statuses).

## Test evidence (Release `build-s4j-rc/bin/Release`, 2026-11-19)

**Harness:** `companion_hwp_move_relay_terminal_test` — **PASS** (extended assertions for `final_direction` + soldier `MOVE` lacks field).

**Focused gates:**

| Target | Result |
|--------|--------|
| `companion_hwp_move_relay_terminal_test` | PASS |
| `companion_hwp_move_relay_test` | PASS |
| `companion_tactical_hwp_authority_test` | PASS |
| `companion_tactical_hwp_move_execution_test` | PASS |
| `tactical-command-m1-hwp-s3b-movement.test.cjs` | **8/8 PASS** |

Raw log: `local/companion_hwp_move_relay_terminal_test-stderr.txt`

### Completed walk

- Engine: `dir=2` (hull facing after walk; start `dirBefore=4`).
- Relay:

```json
"status": "COMPLETED",
"final_position": { "x": 3, "y": 1, "z": 0 },
"remaining_tu": 72,
"destination_reached": true,
"final_direction": 2
```

Harness: `final_direction` present; `relayDir == tank->getDirection() == 2`.

### Interrupted walk

- Engine at interrupt: `pos=4,1` (facing from unit at observation).
- Relay:

```json
"status": "INTERRUPTED",
"final_position": { "x": 4, "y": 1, "z": 0 },
"remaining_tu": 68,
"destination_reached": false,
"movement_stop_reason": "movement_incomplete",
"final_direction": 2
```

Harness: `final_direction` matches `tank->getDirection()` at terminal.

### Soldier `MOVE` regression (same harness)

Terminal `COMPLETED` result contains **no** `"final_direction"` key.

## Owner review — STOP

Reporting correction complete on local dirty tree. Await owner acceptance before runtime pin / deployment.