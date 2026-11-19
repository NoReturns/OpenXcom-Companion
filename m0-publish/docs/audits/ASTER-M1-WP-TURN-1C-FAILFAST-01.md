# ASTER-M1-WP-TURN-1C-FAILFAST-01 — TURN_FACE relay harness crash investigation

**Work package:** M1-WP-TURN-1c relay gate — fail-fast audit  
**Authorization:** Reproduce, classify, harness-only fix if proven. **No deployment, commit, or push.**

## Executive summary

| Question | Answer |
|----------|--------|
| Root cause | **Proven harness lifecycle defect** (two issues): (1) missing `STR_GROUND` on test `Mod` during first `CompanionSnapshot::tryExport`; (2) **per-scenario harness destruction** after relay tick leaving `CompanionCommandRuntime` globals bound to freed `SavedBattleGame` → **heap corruption** (`0xC0000374`) on second scenario. |
| Production / shared relay? | **Not implicated.** TURN_FACE dispatch, executor, and terminal publication are unchanged; first scenario already reached **COMPLETED** before crashes. |
| TURN_FACE implementation? | **Not implicated.** Crash occurred before or between harness scenarios, not inside `tryExecuteCompanionTurnFace`. |
| Deployment safety | **Production TURN_FACE relay path:** no defect found in audited code. **Harness gate:** **GREEN** after harness fix (see verification). **Deployment:** **NOT authorized** (owner mandate unchanged). |

## Reproduction (Release, `build-s4j-rc`)

```text
.\bin\Release\companion_turn_face_relay_test.exe
```

### Pre-fix symptoms

| Pass | Exit code | NTSTATUS | Last observable phase |
|------|-----------|----------|------------------------|
| Initial (STR_GROUND missing) | `-1073740791` | `0xC0000409` (`STATUS_STACK_BUFFER_OVERRUN` / unhandled throw unwind) | **`export_begin`** — abort inside `exportSnapshotBinding()` → `CompanionSnapshot::tryExport`, **before** `tickCompanionCommand` |
| After STR_GROUND + tile detach only | `-1073740940` | `0xC0000374` (`STATUS_HEAP_CORRUPTION`) | First scenario **COMPLETED** (logs show full inbox → terminal path); abort on **teardown** before scenario 2 |

## Failure phase classification

| Phase | Implicated? | Evidence |
|-------|-------------|----------|
| Test setup / snapshot export | **Yes (primary pre-tick)** | Missing `STR_GROUND` → `Mod::Exception` in `appendActorGroundInventory` during `tryExport` (same class as WP9/WP10) |
| Command execution | **No** | Pre-fix: never reached tick on failing run; post partial-fix: `TURN_FACE` **COMPLETED** with expected logging |
| Relay result publication | **No** | `tactical-result.json` written; terminal status observed in logs |
| Scenario cleanup | **Yes (secondary)** | `TurnFaceRelayHarness` destructor + stack-scoped harness destroyed `BattlescapeGame` while relay runtime retained session/binding globals |
| Process shutdown | **No** | Abort mid-suite, not at exit after all tests |

## Comparison with WP10 PSI relay stress failure

| Aspect | WP10 (S4A) | TURN_FACE (1C) |
|--------|------------|----------------|
| Missing `STR_GROUND` on export | **Yes** — first failure mode | **Yes** — identical export path |
| Relay tick reached on failing run | **No** (export pre-tick) | **Yes** after first harness fix |
| Harness lifecycle pattern | Singleton `wp10RelayHarness()` + `resetScenario()` | **Was:** new `TurnFaceRelayHarness` per test + destructor; **Now:** mirrors WP9/WP10 |
| MC / FOV / psi execution | N/A | N/A |
| Assumption | **Not** the same single root cause end-to-end; shared **export fixture** gap plus **unique** multi-instance teardown corruption |

Canonical WP10 write-up: [ASTER-M1-WP10-MC-S4A-FOV-HARNESS-01.md](./ASTER-M1-WP10-MC-S4A-FOV-HARNESS-01.md).

## Diagnostic evidence

- **Exception class:** Windows fast-fail, not a caught C++ assert in harness.
- **Log trace (post partial-fix):** `executor enabled` → inbox accepted → `TURN_FACE started` → `terminal … status=COMPLETED` → process abort (no second scenario log).
- **Code path (export):** friendly roster soldier on discovered tiles → snapshot export → ground inventory rules require `STR_GROUND`.
- **Code path (heap):** `CompanionCommandRuntime` uses process-global binding/inbox state; medikit/WP10 tests **never** destroy the active `SavedBattleGame` between scenarios (intentional leaked singleton).

**Call stack:** not captured with a debugger in this audit; classification is from phased logging, NTSTATUS, and harness pattern parity with stabilized WP9/WP10 suites.

## Harness-only corrections (production unchanged)

**File:** `engine/OpenXcom/src/test/companion_turn_face_relay_e2e_harness.cpp`

1. Register hand inventories + `turnRegisterGroundInventory(mod)` (`STR_GROUND`).
2. `turnDetachUnitFromTiles` before unit delete; footprint clear checks `occupied->getUnit() == unit` (WP10 pattern).
3. Shared floor `MapDataSet`; `turnWireFloorTile` / `turnWireUnitTile` for actor placement.
4. **Singleton** `turnFaceRelayHarness()` + `resetScenario()` between scenarios; **removed** per-test harness destructor that tore down battle/game while relay globals remained active.

**No changes** to `CompanionCommandRuntime.cpp`, `CompanionSnapshot.cpp`, `BattlescapeGame::tryExecuteCompanionTurnFace`, or relay publication core.

## Verification (post-fix, Release `build-s4j-rc`)

| Gate | Result |
|------|--------|
| `companion_turn_face_relay_test.exe` — all 6 scenarios | **PASS** (exit **0**); success, already-facing, invalid target, insufficient TU, duplicate leg, stale binding |
| `companion_turn_face_engine_test.exe` | **PASS** |
| `companion_command_test.exe` | **PASS** |
| `node --test companion/m0-publish/test/tactical-command-m1-wp-turn-1a.test.cjs` | **PASS** (11/11) |

Relay log summary (duplicate scenario): first leg **COMPLETED**; second leg **JOURNAL_MALFORMED** reject when journal manually seeded (harness assertion accepts terminal handling). Stale binding: **REJECTED** `STALE_STATE_VERSION`.

## Classification verdict

| Layer | Verdict |
|-------|---------|
| Test harness lifecycle | **Defect — fixed** |
| Shared relay infrastructure | **No production change required** (globals behave as designed; harness must not destroy bound battle) |
| TURN_FACE implementation | **Clear** |
| Engine memory ownership | **No engine defect proven**; harness violated expected relay+battle lifetime contract |
| Unknown | **None** remaining for relay exe gate |

## Deployment safety verdict

| Item | Status |
|------|--------|
| Production TURN_FACE relay behavior | **No blocker identified** from this audit |
| Native relay regression gate | **UNBLOCKED** (harness green) |
| Authorized deployment | **BLOCKED** — owner review required; no deploy performed |
| Commit / push | **NOT performed** |

## STOP — owner review

Recommended owner actions (not executed here):

- Accept harness diff for 1c relay gate promotion in release checklist.
- Optionally add Node `tactical-command-m1-wp-turn-1c-relay.test.cjs` (mirrors other commands; engine exe remains authoritative).