# ASTER-M1-MELEE-PRODUCTION-DEPLOY-01

**Date:** 2026-11-18  
**Authorization:** Owner — deploy S3 to production runtime; bounded regression only  
**Scope:** Release build, deploy, Battle Mode test prep (no commit/push)

## Verdict

| Item | Status |
|------|--------|
| **Production deployment** | **SUCCESS** |
| **Animated melee live acceptance** | **PENDING OWNER LIVE ACCEPTANCE** |

---

## A1. Preflight

| Check | Result |
|-------|--------|
| S1 contract | **Present** — `tactical-command.cjs`, `composeMeleeAttackCommand`, `tactical-command-m1-melee-stun-s1.test.cjs` |
| S2a engine executor | **Present** — `BattlescapeGame::tryExecuteCompanionMeleeAttack`, `CompanionMeleeExecutionCore.cpp` |
| S2b relay + gate | **Present** — `MELEE_EXECUTION_DISABLED` path in `CompanionCommandRuntime.cpp`, `OPENXCOM_COMPANION_MELEE_EXECUTION` in `CompanionSoldierOwnershipCore.cpp` |
| S3 animated path | **Present** — `MeleeAttackBState::resolveHit` → `noteMeleeAttackResolved`; live `UnitTurnBState` + `MeleeAttackBState` (`companionRelayMelee`) |
| Build tree | `engine/OpenXcom/build-s4j-rc` (canonical in `companion-canonical-runtime.cjs`) |
| Git working tree | **N/A** — workspace root is not a git repository on this machine |
| Reference doc | `ASTER-M1-MELEE-STUN-S3-COMPLETION-01.md` |

Source timestamps (2026-11-18) were **newer** than the previously deployed runtime binary (2026-11-15); rebuild was required.

---

## A2. Release build and verification

| Step | Result |
|------|--------|
| CMake Release build | **SUCCESS** — `cmake --build engine/OpenXcom/build-s4j-rc --config Release --target openxcom companion_command_test companion_medikit_engine_test companion_psi_panic_engine_test companion_psi_mind_control_engine_test` |
| `companion_command_test.exe` | **PASS** (Release) |
| `companion_medikit_engine_test.exe` | **PASS** (Release) |
| `companion_psi_panic_engine_test.exe` | **PASS** (Release) |
| `companion_psi_mind_control_engine_test.exe` | **PASS** (Release) |
| Node melee S1 | **11/11 PASS** |
| Node WP9 medikit S1 + S3 | **11/11 PASS** |
| Node WP10 psi S1 + S3 (panic + MC) | **21/21 PASS** |
| `companion_melee_engine_test.exe` | **Not run** (per order) |
| Live mission / full harness | **Not run** |

---

## A3. Executable hashes and runtime deployment

| Artifact | SHA-256 |
|----------|---------|
| **Previous** `runtime/m0/bin/openxcom.exe` (pre-deploy) | `1f75c565e2f59f0909e4a79aa12ec54937a8585ff275fd59eb95aea4c322dad7` |
| **New** `build-s4j-rc/bin/Release/openxcom.exe` (verified) | `6606e49240511ba09abdddb7e7fb8471847cc6a577c64ac0e6063897e3897bbd` |
| **Deployed** `runtime/m0/bin/openxcom.exe` | `6606e49240511ba09abdddb7e7fb8471847cc6a577c64ac0e6063897e3897bbd` |
| Byte match build ↔ runtime | **Verified** via `deploy-openxcom.ps1` + manifest |

| Rollback copy | Path |
|---------------|------|
| Pre-S3-deploy backup | `runtime/m0/bin/openxcom.exe.backup-20261118-143331` (hash `1f75c565…`) |

**Pin update (local, uncommitted):** `VERIFIED_BUILD_SHA256` in `companion-canonical-runtime.cjs` set to `6606e492…` so deploy and launcher hash gate accept the new binary.

OpenXcom was **not running** at deploy time. Configuration, saves, relay settings, and tactical session files were **not** modified.

---

## A4. Gate defaults and Battle Mode test launch

| Flag | Normal production launch | Battle Mode test launcher |
|------|--------------------------|---------------------------|
| `OPENXCOM_COMPANION_COMMAND_EXECUTOR` | `1` via `Start-CompanionOpenXcom.ps1` | `1` (unchanged) |
| `OPENXCOM_COMPANION_MELEE_EXECUTION` | **Unset** (default **OFF**) | `1` **session-local only** |

**Tonight’s controlled test (do not run from this order):**

```powershell
& "E:\Open X-Com Companion\runtime\m0\Start-CompanionOpenXcom-MeleeBattleModeTest.ps1"
```

This script sets `OPENXCOM_COMPANION_MELEE_EXECUTION=1` only for its PowerShell session, delegates to the canonical launcher, then **clears** the variable when the launcher returns. It does not alter global Windows environment or default shortcuts.

**Acceptance steps:** See `ASTER-M1-MELEE-STUN-S3-COMPLETION-01.md` §7 (stun rod, adjacent visible hostile, `MELEE_ATTACK` → `EXECUTING` → `COMPLETED` with `melee_hit` and TU fields).

**Rollback procedure**

1. Stop OpenXcom normally.
2. Restore binary:  
   `Copy-Item "runtime\m0\bin\openxcom.exe.backup-20261118-143331" "runtime\m0\bin\openxcom.exe" -Force`
3. Set `VERIFIED_BUILD_SHA256` back to `1f75c565e2f59f0909e4a79aa12ec54937a8585ff275fd59eb95aea4c322dad7` in `companion-canonical-runtime.cjs`.
4. Never persist `OPENXCOM_COMPANION_MELEE_EXECUTION=1` in system/user environment.

---

## A5. Unverified live behaviors

- Full animated `UnitTurnBState` + `MeleeAttackBState` chain in live Battlescape
- `tu_spent` accounting vs in-game Stun menu baseline
- Orphaned `EXECUTING` melee after save/load
- Miss vs hit outcome on unconscious alien (next F6 only)
- `MELEE_EXECUTION_DISABLED` reject with zero TU mutation (live confirm)
- Turret / elevation edge rejects beyond Node advisory layer

---

## Commit / push

**Not performed** — owner live melee acceptance pending.