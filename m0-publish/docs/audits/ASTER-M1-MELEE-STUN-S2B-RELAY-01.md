# ASTER-M1-MELEE-STUN-S2B-RELAY-01

**Date:** 2026-11-18  
**Scope:** Gated relay integration for `MELEE_ATTACK` (validation + dispatch prep; **no live strike execution by default**)  
**References:** S1 contract, S2a engine, S2a closeout audits  
**Stop:** No enabled live melee, deployment, commit, or push.

## Verdict

**READY for S3** (animated completion, optional enablement, engine harness verification).

**Relay path is wired** with parse → binding validation → **`MELEE_EXECUTION_DISABLED` rejection** before any `setActiveHand`, turn, or `tryExecuteCompanionMeleeAttack`. Native executor is **double-gated** (`OPENXCOM_COMPANION_MELEE_EXECUTION` must be exactly `1`).

---

## 1. Changed files

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` | `MELEE_ATTACK` inbox branch, `fillMeleeAttackValidationInput`, result JSON, journal/duplicate templates |
| `engine/OpenXcom/src/Engine/CompanionCommandRuntimeSupport.h/.cpp` | `shortestTurnStepsBetweenDirections` for TU preflight |
| `engine/OpenXcom/src/Engine/CompanionMeleeExecutionCore.cpp` | `estimateMeleeTurnSteps`; reserve `meleeTu + turnTu` before turn |
| `engine/OpenXcom/src/Engine/CompanionSoldierOwnershipCore.h/.cpp` | `isCompanionMeleeExecutionEnabledFromEnvironment()` |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` | Native gate at start of `tryExecuteCompanionMeleeAttack` |
| `engine/OpenXcom/src/test/companion_command_test.cpp` | Turn-step estimate + execution gate default-off tests |
| `companion/m0-publish/docs/audits/ASTER-M1-MELEE-STUN-S2B-RELAY-01.md` | This report |

## 2. Command call path

```
tactical-command.json (command_type: MELEE_ATTACK)
  → CompanionCommandRuntime (inbox tick)
       parseMeleeAttackCommandJson
       journal / duplicate inbox handling
       fillMeleeAttackValidationInput (live battle snapshot)
       validateMeleeAttackCommand
       [GATE] isCompanionMeleeExecutionEnabledFromEnvironment() → CMD_REJECTED MELEE_EXECUTION_DISABLED
       (only if OPENXCOM_COMPANION_MELEE_EXECUTION=1:)
         tryExecuteCompanionMeleeAttack → CompanionMeleeExecutionCore::executeMelee
       buildMeleeAttackResultJson → tactical-result.json
```

Unsupported-type list now includes `MELEE_ATTACK` (no longer `UNSUPPORTED_COMMAND_TYPE`).

## 3. Execution gate

| Layer | Mechanism | Default |
|-------|-----------|---------|
| Relay runtime | After validation passes, rejects with `MELEE_EXECUTION_DISABLED` and `CMD_REJECTED` — **no** `setActiveHand`, **no** executor call | **Off** |
| Native executor | `tryExecuteCompanionMeleeAttack` returns false if env not `1` | **Off** |
| Global executor | Still requires `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` for any inbox processing | Unchanged |

Rejected disabled commands are **never** `COMPLETED`.

**Enable strikes (operator, future):** set `OPENXCOM_COMPANION_MELEE_EXECUTION=1` in addition to the global command executor flag. Still subject to S2a closeout (harness / S3) before recommended for live play.

## 4. Validation and rejection behavior

Mirrors Psi-Amp / medikit:

- Binding: session, turn, snapshot SHA, state version, duplicate journal, authority / AI ownership  
- Equipment: `melee_weapon_battle_item_id`, hand, `BT_MELEE`, native `getMeleeWeapon()` match, usability  
- Target: resolved, genuine hostile, visible, actor `visibleUnits` LOS  
- TU: `insufficientTuForMelee` via `checkReservedTU(actor, meleeTu + turnSteps, true)`  

**Disabled path:** `MELEE_EXECUTION_DISABLED` with explicit public reason (mentions env var).

**Parse failures:** standard parser `rejectCode` (e.g. `INVALID_MELEE_WEAPON_INSTANCE`).

## 5. TU correctness

| Item | S2b change |
|------|------------|
| Turn + melee reserve | `shortestTurnStepsBetweenDirections` (0–4) + `getActionTUs(BA_HIT)` checked together in relay fill and in `executeMelee` before turning |
| Orphan turn TU | Reduced vs S2a; still possible if turn starts and later native reject occurs mid-execution — **documented for S3** |
| Turret facing | TU estimate uses body `getDirection()` only (stock XCOM1 player melee context) |

Normal player menu melee unchanged.

## 6. Outcome / lifecycle (S3 prep)

`buildMeleeAttackResultJson` supports:

| Field | When |
|-------|------|
| `status` | `rejected` / `completed` / (future) `executing` |
| `melee_hit`, `target_incapacitated`, `target_killed` | Only on `completed` after real execution |

**Recommendation:** S3 should either (a) keep synchronous `companionExecuteMelee` and add `CMD_EXECUTING` only if needed, or (b) push `UnitTurnBState` + `MeleeAttackBState` for FX parity. Synchronous path remains appropriate for instant relay completion; state stack needed for animation and optional sounds without orphan `ExplosionBState`.

Hit booleans come from executor outputs (stun/health delta), not fabricated.

## 7. Tests performed

| Target | Result |
|--------|--------|
| `companion_command_test.exe` | **PASS** (melee preflight, turn steps, gate default off) |
| `tactical-command-m1-melee-stun-s1.test.cjs` | **11/11 PASS** |
| `openxcom` ClCompile (runtime + melee core) | **PASS** |
| `companion_melee_engine_test.exe` | **Not run** (per order) |

Runtime gate end-to-end (inbox → result file) not exercised in this stage without relay harness; logic mirrors Psi-Amp ordering with gate inserted **before** mutation.

## 8. S3 requirements

1. Pass bounded engine harness or relay integration test with gate on/off cases.  
2. Decide sync vs animated completion; split cosmetic vs damage flags.  
3. Optional `CMD_EXECUTING` + session interrupt template for `MELEE_ATTACK`.  
4. Node publish path / CLI dry-run already S1-complete; wire operator docs for dual env flags.  
5. Do not enable `OPENXCOM_COMPANION_MELEE_EXECUTION` in production builds until closeout conditions met.

## 9. Verdict for S3

**READY** to implement animated completion and controlled enablement; **not ready** for operator-facing live strikes without harness verification and explicit env enablement policy.