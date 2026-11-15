# ASTER-M1-WP9-MEDIKIT-S4A-SEH-RCA-01 — success-path relay “SEH” root cause

**Owner decision:** NO DEPLOYMENT. Investigation only — no commits, pushes, or pins.

## Executive summary

The success-path “SEH” in the isolated medikit relay harness is **not** a medikit executor defect and **not** evidence of a null deref in native HEAL application. It is an **unhandled C++ exception** thrown during **post-success snapshot export** (`CompanionSnapshot::tryExport`), because the sparse test `Mod` does not register **`STR_GROUND`**, which production snapshot serialization requires.

| Classification | Verdict |
|----------------|---------|
| Root cause | **Test-fixture initialization gap** (missing `STR_GROUND` rule) |
| Production medikit relay path | **No proven defect** at RCA time (full ruleset loads `STR_GROUND`) |
| Misleading symptom | Earlier `0xC0000409` / `0xC0000409`-class exits when `__try/__except` masked `0xE06D7363` throw unwind |

## Reproduction

```powershell
$env:OPENXCOM_WP9_RELAY_SUCCESS_PROBE = '1'
$env:OPENXCOM_COMPANION_RELAY_TRACE = '<relay_dir>\wp9_relay_trace.log'  # set automatically by harness
.\companion_medikit_engine_test.exe
```

Without `STR_GROUND` on the harness `Mod`:

1. Probe builds co-tile unconscious HEAL scenario.
2. **First failing operation:** `CompanionSnapshot::tryExport` at `probe:tryExport_pre_inbox_enter` (before relay tick).
3. Process terminates with unhandled exception.

## Exception evidence

| Field | Value |
|-------|--------|
| Windows code (unhandled filter) | **`0xE06D7363`** (Microsoft C++ exception / throw) |
| Faulting address (throw site module) | `0x75ADB702` (system/CRT bridge; not product PC) |
| `std::exception::what()` (probe catch) | **`Inventory STR_GROUND not found`** |

**Last successful trace line (success relay path, before fix):**

```text
medikit:after_execute_ok
medikit:before_snapshot_sha256
medikit:snapshot_tryExport_enter
```

**Lines never reached:**

```text
medikit:snapshot_tryExport_exit
medikit:after_snapshot_sha256
medikit:after_write_result
medikit:after_journal
```

## Call chain (accepted HEAL → crash)

From env-gated trace steps in `CompanionCommandRuntime::tick` (medikit branch):

1. Inbox read + parse + validate → `medikit:accepted`
2. `game->tryExecuteCompanionMedikitHeal(...)` → `medikit:after_execute_ok` (**native apply succeeds**)
3. `snapshotSha256ForTerminalCommandResult(CMD_COMPLETED)`
   - `medikit:snapshot_tryExport_enter`
   - `CompanionSnapshot::tryExport(battle, &sha)` → **`buildSnapshot` → unit export → `appendActorGroundInventory`**
   - `mod->getInventory("STR_GROUND", true)` → **`Mod::Exception`: `Inventory STR_GROUND not found`**
4. Exception unwinds through `tick` (no handler) → process abort (observed as SEH `0xE06D7363`)

**First failing frame (product code, evidenced):**

```551:567:engine/OpenXcom/src/Engine/CompanionSnapshot.cpp
void appendActorGroundInventory(YAML::Node &entry, SavedBattleGame *battle, SavedGame *campaign, BattleUnit *unit)
{
	// ...
	RuleInventory *groundRule = mod->getInventory("STR_GROUND", true);
```

Throw originates in `Mod::getInventory(..., error=true)` when the rule is absent.

## Comparison to known-good fixture

`companion_snapshot_serialization_test.cpp` registers `STR_GROUND` via `snapshotTestGroundInventoryRule()` before any `CompanionSnapshot::tryExport` exercise. The medikit relay harness only registered hand slots (`STR_RIGHT_HAND` / `STR_LEFT_HAND`) and medikit rules — **same gap as snapshot tests would have without `snapshotTestGroundInventoryRule()`.**

S2 direct executor tests avoid this because they **do not** call `tryExport` on success. Rejection-only relay tests avoid it because **REJECTED** paths do not run `shouldExportSnapshotBeforeTerminalCommandResult(COMPLETED)` snapshot export.

## What is *not* the cause (evidence-bound)

- **`tryExecuteCompanionMedikitHeal`** on the same harness: `probe:direct_execute_ok`
- **Relay admission** for HEAL with valid binding: `medikit:accepted` + `medikit:after_execute_ok` (when binding not stale)
- **`BattlescapeGame::_parentState` / UI** note path: harness uses `BattlescapeGame(&battle, 0)`; post-execute UI mutation path is skipped (same as S2)
- **Assumed without proof:** busy stack, melee/off-tile geometry, journal IO bugs — not implicated by trace

## Verification after smallest harness correction

Register `STR_GROUND` on the probe/harness `Mod` (mirror `snapshotTestGroundInventoryRule()`):

| Step | Result |
|------|--------|
| `tryExport` pre-inbox | `probe:tryExport_pre_inbox_ok` |
| Direct HEAL | `probe:direct_execute_ok` |
| `tryExport` post-direct | `probe:tryExport_post_direct_ok` |
| Relay `tick` | **`probe:relay_tick_returned`** (no crash) |

Note: calling `tryExport` **before** relay tick updates live `noteSnapshotExportSha256`; the probe inbox still used a static binding SHA → **`STALE_SNAPSHOT` reject** (expected probe artifact, not a new crash).

## Smallest proposed correction

**Harness-only (recommended for S4 success suite):**

- In `companion_medikit_relay_e2e_harness.cpp`, register `STR_GROUND` with `INV_GROUND` on the test `Mod` at harness init (same pattern as `snapshotTestGroundInventoryRule()`).

**Optional production hardening (separate owner decision, not required for RCA):**

- Wrap `CompanionSnapshot::tryExport` body to catch `Exception` / `std::exception`, log, return `false` (relay already tolerates empty snapshot SHA on some rejects). This would prevent **any** ruleset gap from aborting the battlescape tick — behavior change, not investigated here.

## Instrumentation added for RCA (env-gated)

- `OPENXCOM_COMPANION_RELAY_TRACE` → append-only `wp9_relay_trace.log` steps in medikit relay completion path.
- `OPENXCOM_WP9_RELAY_SUCCESS_PROBE=1` → runs `wp9RunSuccessPathSehInvestigation()` only (does not enable success suite in default `main`).
- Removed `__try/__except` from `tickRelay()` so failures are not masked.

**Default gate unchanged:** `main` still runs `runMedikitRelayRejectionOnlySuite()` only.

## Commands run

```text
MSBuild .../companion_medikit_engine_test.vcxproj /p:Configuration=Release
OPENXCOM_WP9_RELAY_SUCCESS_PROBE=1 .../companion_medikit_engine_test.exe
(without probe env) .../companion_medikit_engine_test.exe  # rejection suite green
```

## STOP — owner review

Deployment remains **NO**. Next step: owner approves harness `STR_GROUND` registration (and snapshot-fixture parity checklist) before re-enabling `runMedikitRelayE2eSuite()` as a gate — not part of this RCA commit.