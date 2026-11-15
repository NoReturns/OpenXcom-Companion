# ASTER-M1-WP10-MC-S4A-FOV-HARNESS-01 — post-MC / native psi relay harness instability

**Work package:** M1-WP10 mind control — Stage S4A (investigation only)
**Authorization:** Reproduce, classify, harness-only fix if warranted. **No deployment, commit, or push.**

## Executive summary

| Question | Answer |
|----------|--------|
| Was instability MC-specific or post-MC FOV? | **No.** Failure occurs on **first `CompanionSnapshot::tryExport`** in the shared WP10 relay harness, **before** `tickCompanionCommand`, for both **PSI_PANIC** and **PSI_MIND_CONTROL** inbox paths. |
| Production vs harness? | **Harness-only.** Same root cause class as WP9 medikit S4A (`STR_GROUND` missing on test `Mod`). Executor paths (`tryExecuteCompanionPsiPanic` / `tryExecuteCompanionPsiMindControl`) never call `tryExport` on success and remained green. |
| Psychic / ownership code changed? | **No** production changes. One harness registration added. |

## Reproduction (Release, `build-isolated-m1-23e`)

```text
.\companion_psi_panic_engine_test.exe   # runPsiPanicRelayE2eSuite enabled in main
.\companion_psi_mind_control_engine_test.exe   # runPsiMindControlRelayE2eSuiteExtended in main
```

**Before fix:** process abort `0xC0000409` (stack buffer overrun / unhandled exception) at `publishPanicInbox` → `exportSnapshotBinding` → `CompanionSnapshot::tryExport` (debug stopped at “export”, never reached relay tick).

**After fix:** both exes complete relay suites without abort.

## Root cause (evidence-bound)

Relay harness places **live roster soldiers** on a `Base` and exports a full tactical snapshot for binding. Friendly unit export calls `appendActorGroundInventory`, which requires `mod->getInventory("STR_GROUND", true)`.

WP10 `Wp10RelayHarness` registered hand inventories only (mirror of pre-S4A medikit harness). Missing `STR_GROUND` throws `Mod::Exception` (“Inventory STR_GROUND not found”), unwinding through `tryExport` with no handler → process abort.

**Not implicated by trace:**

- Mind-control faction flip or FOV recompute (never reached).
- `BattlescapeGame::tickCompanionCommand` or psi execution (export fails pre-tick).
- Differences in panic vs MC relay dispatch (both share the same harness and fail identically pre-fix).

**Canonical comparison:** [ASTER-M1-WP9-MEDIKIT-S4A-SEH-RCA-01](./ASTER-M1-WP9-MEDIKIT-S4A-SEH-RCA-01.md).

## Fix applied (harness only)

In `companion_psi_panic_relay_e2e_harness.cpp`:

- `wp10RegisterGroundInventory(mod)` — same pattern as `wp9RegisterGroundInventory` in the medikit relay harness / `snapshotTestGroundInventoryRule()` in snapshot serialization tests.
- Called from `Wp10RelayHarness` constructor after hand inventory registration.

No changes to `CompanionSnapshot.cpp`, psi formulas, faction rules, or command ownership.

## Verification (S4A gate)

| Gate | Result |
|------|--------|
| `companion_psi_panic_engine_test.exe` — executor + **full** `runPsiPanicRelayE2eSuite()` | **PASS** |
| `companion_psi_mind_control_engine_test.exe` — executor + `runPsiMindControlRelayE2eSuiteExtended()` (success / failed roll / insufficient TU) | **PASS** |
| Relay **COMPLETED** paths consume **25 TU** (`tu_spent` in result); **no psychic leak** in terminal JSON (harness assertions) | **PASS** |
| MC success: faction conversion + companion AI roster exclusions (harness assertions) | **PASS** |
| Node `tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs` | **PASS** |
| Node `tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs` | **PASS** |
| `companion_command_test.exe` | **PASS** (unchanged) |

## Panic vs MC behavior after fix

Both use the same relay harness and snapshot path. MC extended suite exercises inbox success (with faction change), failed psychic roll (outcome-blind **COMPLETED** + TU), and insufficient-TU **REJECTED** — matching the accepted panic fair-play contract.

## STOP — S4A complete

- **Deployment:** NOT authorized (per owner mandate).
- **Commit / push:** NOT performed.
- **Recommended follow-up for S4B/S5 (owner):** Decide whether to wire full MC relay rejection matrix (mirror panic suite) as default exe gates; optional cleanup of redundant `wp10WireUnitTile` vs parent `wireUnitTile` (cosmetic harness only).
