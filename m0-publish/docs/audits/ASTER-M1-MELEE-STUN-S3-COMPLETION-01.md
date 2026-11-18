# ASTER-M1-MELEE-STUN-S3-COMPLETION-01

**Date:** 2026-11-18  
**Scope:** Animated relay melee lifecycle + outcome capture (no deployment, no gate enablement, no commit/push)  
**Prerequisites:** S1 contract, S2a executor, S2b gated relay  
**Execution gate:** Remains **OFF** by default (`OPENXCOM_COMPANION_MELEE_EXECUTION` unset).

## Verdict

**Live acceptance:** **OWNER ACCEPTED** 2026-11-18 — see `ASTER-M1-MELEE-LIVE-ACCEPTANCE-01.md` (`MELEE_ATTACK` COMPLETED, Kees #28 vs Sectoid #1000001, `melee_hit: true`; first `target_status: active`).

**Proven in CI-style bounds:** parse/preflight, lifecycle state machine, RNG-based `melee_hit` hook, default-disabled gate, regression suites.

**Not proven here:** end-to-end animated strike in running game (by order: no `companion_melee_engine_test`, no mission automation).

---

## 1. Implementation changes

| Area | Change |
|------|--------|
| `BattlescapeGame::tryExecuteCompanionMeleeAttack` | With `BattlescapeState` + `Map`: native `UnitTurnBState` → `MeleeAttackBState` (`companionRelayMelee`, full FX). Without UI: headless `CompanionMeleeExecutionCore` (tests only). |
| `BattleAction` | `companionRelayMelee`, `companionRelayMeleeTargetUnitId`; `companionHeadlessMelee` false on live path. |
| `MeleeAttackBState::resolveHit` | Records RNG hit/miss via `CompanionCommandRuntime::noteMeleeAttackResolved` before damage application. |
| `CompanionCommandRuntime` | `ActiveCommand::KIND_MELEE`, in-flight tick completion, `EXECUTING` result, interrupt on binding reset. |
| `CompanionCommandCore` | `MeleeCompletionInput`, `evaluateMeleeTerminalStatus`. |
| `buildMeleeAttackResultJson` | `melee_hit`, `target_incapacitated`, `target_killed`, optional `target_status` (`active` / `unconscious` / `dead` only). |
| TU preflight | Unchanged: `meleeTu + turnSteps` before start; range checked with `directionTo` facing **before** state push. |

## 2. Live melee execution pathway

```
MELEE_ATTACK inbox (gate ON + executor ON)
  → validate + duplicate/journal
  → beginInFlightCommand (KIND_MELEE)
  → tryExecuteCompanionMeleeAttack (live path)
       preflight (auth, weapon, LOS, TU+turn reserve, validMeleeRange @ intended facing)
       UnitTurnBState (front) + MeleeAttackBState (back)
  → tactical-result.json status EXECUTING
  → Battlescape tick advances states (native audio/FX/explosion cosmetic)
  → resolveHit → noteMeleeAttackResolved(RNG hit/miss)
  → tick: evaluateMeleeTerminalStatus → COMPLETED + outcome fields
```

Relay **rejects** `MELEE_EXECUTION_DISABLED` before any `setActiveHand` or state push.

Relay **rejects** if `tryExecute…` returns true but `!game->isBusy()` (no animated stack — headless cannot complete through inbox).

## 3. Animation and sound

Live path uses stock `MeleeAttackBState` (`performMeleeAttack` + `ExplosionBState` + sounds). **`companionHeadlessMelee` is not set** on relay melee.

Headless path retained only when `_parentState == 0` (unit harness; not relay).

## 4. TU and outcome capture

| Topic | Behavior |
|-------|----------|
| Turn TU | Native `UnitTurnBState` (1 TU/step). |
| Melee TU | Native `popState` spend for `BA_HIT` with `targeting=true` when attack chain completes. |
| Preflight | `checkReservedTU(meleeTu + turnSteps)` before states queued; range check before turn. |
| `melee_hit` | **RNG roll** from `resolveHit`, not stat delta. |
| Incap/killed | Observed on target **after** `resolveHit` damage; status labels only in result JSON. |
| Miss | `melee_hit: false`, attack still **COMPLETED** (native TU spent). |
| Command vs hit | Acceptance = `EXECUTING` written; completion ≠ hit. |

Human menu melee unchanged (no `companionRelayMelee` on player UI actions).

## 5. Tests executed

| Target | Result |
|--------|--------|
| `companion_command_test.exe` | **PASS** — melee preflight, turn steps, gate default off, `evaluateMeleeTerminalStatus` |
| `tactical-command-m1-melee-stun-s1.test.cjs` | **11/11 PASS** |
| `openxcom` ClCompile | **PASS** |
| `companion_melee_engine_test.exe` | **Not run** (per order) |
| Live Battlescape / relay E2E | **Not run** |

### Minimum checklist vs order

| # | Item | Status |
|---|------|--------|
| 1–5 | Stun strike, turning, TU, hit/miss, unconscious | **Unverified** in animated E2E |
| 6–7 | Range/ownership reject | **Preflight** via `validateMeleeAttackCommand` + runtime fill |
| 8 | Disabled gate | **Tested** (env default off) |
| 9 | No duplicate execution | **Design:** journal + in-flight gating (same as THROW); not E2E-tested |
| 10 | Regression | **command_test + S1** pass |
| Disabled no mutation | **Proven** for reject path (no executor call) |

## 6. Remaining gaps

1. Battle Mode validation of full `UnitTurnBState` + `MeleeAttackBState` chain and `tu_spent` accounting.  
2. Rehydrate orphaned `EXECUTING` melee after reload (directed-fire pattern not yet ported for `MELEE_ATTACK`).  
3. Obstruction/elevation runtime rejects beyond `validMeleeRange`@`directionTo`.  
4. Turret-facing turn TU (estimate uses body facing only).  

## 7. Recommended Battle Mode acceptance procedure

1. Build Debug/Release engine from current tree.  
2. **Do not** set production defaults; on test machine only:  
   - `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`  
   - `OPENXCOM_COMPANION_MELEE_EXECUTION=1`  
3. AI-owned soldier, visible adjacent hostile, stun rod in hand — publish `MELEE_ATTACK` via CLI dry-run then live inbox once.  
4. Expect `tactical-result.json`: `EXECUTING` during swing, then `COMPLETED` with `melee_hit`, `tu_spent`, outcome booleans.  
5. Disabled check: clear `OPENXCOM_COMPANION_MELEE_EXECUTION`, republish — expect `REJECTED` / `MELEE_EXECUTION_DISABLED`, **unchanged TU and stun**.  
6. If acceptance passes once, owner may authorize enablement policy separately (still not done in this change set).

## 8. Production / deployment

- **No** runtime deployment.  
- **No** enabling melee execution in production builds.  
- **No** commit or push in this order.