# ASTER-M1-WP9-MEDIKIT-S4D-ADJACENT-FAULT-01 — adjacent HEAL fault investigation

**Work package:** M1-WP9 medikit — adjacent east success-path blocker
**Owner review gate:** STOP — no commits, pushes, release pin, or deployment.

## Summary

| Item | Finding |
|------|---------|
| Reproduced with direction 2 (east)? | **Yes** — process abort during native target resolution (before relay terminal log) |
| Exit / fault code | **`0xC0000409`** (`STATUS_STACK_BUFFER_OVERRUN` — `/GS` security cookie / related UB) |
| First failing operation | `CompanionMedikitExecutionCore::resolveNativeMedikitTarget` → `TileEngine::validMeleeRange` → `TileEngine::canTargetUnit` → `calculateLine` |
| Co-tile success path | **Does not** call melee LOS (`canTargetUnit`); uses co-occupant scan only |
| Root cause class | **Production defensive gap** + **sparse harness map** (not relay freshness / duplicate logic) |
| Adjacent east COMPLETED certified? | **No** — remains release blocker for full adjacent success coverage |
| S4C certified paths | **Unchanged green** (co-tile HEAL/STIMULANT/PAINKILLER, rejections, duplicate) |

## Reproduction (isolated harness)

1. Medic `(1,1,0)` facing **2** (east), unconscious patient `(2,1,0)`, fatal torso wound.
2. `publishMedikitInbox` + `tickRelay` **or** direct `resolveNativeMedikitTarget` before inbox.
3. Bisect logs:
   - `tryExport` (pre-heal binding) **succeeds**
   - Crash **before** `WP9_ADJ_PROBE: after resolve` / before relay inbox on east success attempt
   - Mis-aimed **direction 3** does **not** crash (fails with `MEDIKIT_APPLICATION_FAILED` / non-COMPLETED, no mutation)

## Comparison: co-tile vs adjacent

| Step | Co-tile | Adjacent (east) |
|------|---------|-----------------|
| Target resolution | Same-tile unconscious scan | `validMeleeRange` + voxel `canTargetUnit` |
| Harness map | Floor on unit tiles only | Requires LOS voxel path between tiles |
| Relay outcome | COMPLETED + journal + terminal JSON | **Abort** during resolution (east) or APPLICATION_FAILED (mis-aim) |
| Production gameplay rules | Unchanged | Unchanged |

## Classification

1. **Production (defensive):** In `TileEngine::canTargetUnit`, branch `test == V_UNIT` used `_trajectory.at(0)` without verifying `_trajectory` non-empty — undefined behavior on sparse harness traces that report `V_UNIT` with an empty trajectory vector (manifests as `0xC0000409` under `/GS`).
   - **Smallest fix applied in-tree:** `if (_trajectory.empty()) { continue; }` before `.at(0)` in the hit-test loop.
   - **Gameplay impact:** None when trajectory is non-empty (normal maps); skips invalid scan slice when empty.

2. **Fixture / lifecycle:** Sparse 6×6 harness wires floor `MapData` only on unit-placement tiles unless `wireMedikitTestFloorGrid()` is called. Co-tile coverage does not exercise melee medikit LOS. Full-grid floor wiring **alone** was **not sufficient** to certify east COMPLETED in this investigation window (resolve/execute still aborted in standalone probes).

3. **Not caused by:** `STALE_SNAPSHOT`, duplicate journal logic, `STR_GROUND` export, or medikit relay admission after successful co-tile binds.

## Changes (this investigation)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Battlescape/TileEngine.cpp` | Guard empty `_trajectory` before `.at(0)` in `canTargetUnit` |
| `engine/OpenXcom/src/test/companion_medikit_engine_test.cpp` | `wireMedikitTestFloorGrid()` helper (shared floor `MapData`) |
| `engine/OpenXcom/src/test/companion_medikit_relay_e2e_harness.cpp` | `setupAdjacentUnconsciousPatient(facing)`; `runRelayAdjacentMisAimedNoMutation()` (dir 3, no COMPLETED, no mutation) |

## Test evidence (focused gates)

```text
companion_medikit_engine_test.exe     → exit 0, All companion medikit engine tests passed
companion_command_test.exe            → all tests passed (prior run)
Node WP9 S1/S3/S4                     → 14/14 pass (includes engine subprocess)
```

Adjacent east **COMPLETED** relay case **not** in default suite (disabled pending fixture/engine follow-up).

## Release readiness

| S4C scope (co-tile + rejections + duplicate) | **GO** — unchanged |
| Adjacent off-co-tile HEAL success (facing-correct) | **BLOCKED** — fault in native melee medikit resolution on sparse harness; defensive `canTargetUnit` fix does not complete certification |
| Recommendation | Ship WP9 medikit relay on **S4C bounds**; open follow-up for adjacent success using production-like map fixture (see `companion_guided_launch_engine_test.cpp` floor wiring) or ruleset-backed tiles |

## Proposed follow-up (not in S4D scope)

1. Adjacent east relay COMPLETED test behind full harness map + confirm `resolveNativeMedikitTarget` returns id 2 without abort.
2. Optional: unit test on `canTargetUnit` empty-trajectory `V_UNIT` slice (regression for `/GS` abort).

**STOP** — owner review only.