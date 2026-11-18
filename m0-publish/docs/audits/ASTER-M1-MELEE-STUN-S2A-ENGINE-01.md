# ASTER-M1-MELEE-STUN-S2A-ENGINE-01

**Date:** 2026-11-18  
**Scope:** Native C++ `MELEE_ATTACK` parsing, validation core, and headless `BA_HIT` execution (no GitHub relay, no commit/push)  
**References:** [ASTER-M1-MELEE-STUN-AUDIT-01.md](./ASTER-M1-MELEE-STUN-AUDIT-01.md), [ASTER-M1-MELEE-STUN-S1-CONTRACT-01.md](./ASTER-M1-MELEE-STUN-S1-CONTRACT-01.md)  
**Stop:** Owner review before S2b relay binding and S3 animated completion.

## Verdict

S2a **engine path implemented**: JSON parse + snapshot-oriented preflight mirror in `CompanionCommandCore`, runtime authorization and native melee execution via `BattlescapeGame::tryExecuteCompanionMeleeAttack` → `CompanionMeleeExecutionCore::executeMelee` → `MeleeAttackBState::companionExecuteMelee` (`performMeleeAttack` + `resolveHit`, no custom damage math). **Relay runtime not wired** (`CompanionCommandRuntime` unchanged).

## Changed files

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionCommandCore.h/.cpp` | `parseMeleeAttackCommandJson`, `validateMeleeAttackCommand`, structs |
| `engine/OpenXcom/src/Engine/CompanionMeleeExecutionCore.h/.cpp` | Turn + range + TU gate; delegate to melee BState |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.h/.cpp` | `tryExecuteCompanionMeleeAttack`, `BattleAction::companionHeadlessMelee` |
| `engine/OpenXcom/src/Battlescape/MeleeAttackBState.h/.cpp` | `companionExecuteMelee`; headless-safe `performMeleeAttack` / hit sound |
| `engine/OpenXcom/src/CMakeLists.txt` | `CompanionMeleeExecutionCore.cpp`, `companion_melee_engine_test` target |
| `engine/OpenXcom/src/test/companion_melee_engine_test.cpp` | Battlescape executor harness |
| `engine/OpenXcom/src/test/companion_command_test.cpp` | Parse + preflight regression cases |
| `companion/m0-publish/docs/audits/ASTER-M1-MELEE-STUN-S2A-ENGINE-01.md` | This report |

## Native call path

```
MELEE_ATTACK JSON
  → CompanionCommandCore::parseMeleeAttackCommandJson (relay preflight / tests)
  → CompanionCommandCore::validateMeleeAttackCommand (binding + snapshot fields; tests)

Runtime (harness / future S2b):
  → BattlescapeGame::tryExecuteCompanionMeleeAttack(actor, item, hand, targetUnitId, …)
       auth (companionMedikitActorAuthorized pattern)
       BT_MELEE, owner, hand slot, native getMeleeWeapon() ID match
       genuine hostile + visible + actor visible-units LOS
       battle not busy
  → CompanionMeleeExecutionCore::executeMelee
       TU reserve for BA_HIT
       turn toward target (1 TU/step, bounded; snap facing if headless stall)
       TileEngine::validMeleeRange
       MeleeAttackBState::companionExecuteMelee
         performMeleeAttack (cosmetic; headless skips map/sound)
         resolveHit (RNG melee accuracy → TileEngine::hit — stock stun/damage)
         spendTimeUnits(melee TU) once
```

Live UI path (today): same `resolveHit` pipeline as menu melee; S3 may instead push `UnitTurnBState` + `MeleeAttackBState` for animation instead of `companionExecuteMelee`.

## TU charging

| Phase | Behavior |
|-------|----------|
| Turning | Up to 8 steps × 1 TU via `spendTimeUnits(1)` + `BattleUnit::turn`, mirroring `UnitTurnBState::think`. If animation state never clears (no `BattlescapeState`/map), facing is forced with `lookAt(dir, true)` after the cap so harness cannot spin forever. |
| Melee strike | Single `spendTimeUnits(action.TU)` in `companionExecuteMelee` after `resolveHit`, with `action.TU = getActionTUs(BA_HIT, weapon)`. Matches menu **non-target** upfront spend (`handleNonTargetAction`), not projectile deferred targeting. |
| Double charge | Prevented: no `MeleeAttackBState` state stack push in headless path; menu alien double-melee branch in `think()` is not entered. |

## Turning and range validation

- **Turn:** `lookAt(target)` then stepped `turn()`; FOV recalc when `TileEngine` present.
- **Range:** `TileEngine::validMeleeRange(actor pos, direction, actor, target, &meleeDest)` before strike; reject `"Target is not in melee range."`
- **Weapon:** Requested `BattleItem` must equal `actor->getMeleeWeapon()` native selection (stun rod vs knife resolution stays in OpenXcom).

## Outcome capture

`ExecutionOutcome` / executor out-parameters (no hidden HP in public relay — harness only):

| Signal | Meaning |
|--------|---------|
| `false` from `tryExecute…` | Rejected before strike (preflight / TU / range / auth) |
| `true`, `meleeHit == false` | Strike attempted; `resolveHit` missed (stun/health unchanged) |
| `true`, `meleeHit == true` | Post-strike stun or health changed |
| `targetUnconscious` | `STATUS_UNCONSCIOUS` or stun ≥ health |
| `targetKilled` | `STATUS_DEAD` or health ≤ 0 |

Hit is **not** inferred from animation (headless skips `ExplosionBState`). S3 must map these to `tactical-result.json` without exporting undisclosed stats.

## Tests

| Target | Status |
|--------|--------|
| `companion_command_test.exe` | **Pass** (includes melee parse + authorized / insufficient TU / hidden target preflight) |
| `companion_melee_engine_test.exe` | **Built** (Debug, isolated tree). Harness fixes applied for (1) unbounded `STATUS_TURNING` loop, (2) null `Map` in headless `performMeleeAttack`. **Owner run once** after rebuild link: `build-isolated-m1-23e\bin\Debug\companion_melee_engine_test.exe` |

Harness cases implemented: stun rod hit, left-hand knife, wrong hand, out of range, low TU, unauthorized actor, hidden hostile, miss seed; preflight cases in `companion_command_test`.

### Checklist vs specification (honest gap list)

| # | Topic | Harness / core |
|---|--------|----------------|
| 1–2 | Stun rod, either hand | Yes |
| 3 | Wrong weapon ID / hand | Hand yes; weapon ID mismatch via `getMeleeWeapon()` in runtime |
| 4–6 | TU, auth, hidden | Yes |
| 7–9 | Range, obstruction, elevation | Range yes; obstruction/elevation fixtures **not yet** |
| 10 | Turning behavior | Stepped turn + forced snap fallback; no assertion on final direction |
| 11 | TU once | Partial (total TU out); dedicated double-spend guard **not yet** |
| 12–14 | Unconscious / hit-no-KO / miss | Stun path + miss seed; explicit non-incap hit **not yet** |
| 15 | Busy / stale | Preflight via `validateMeleeAttackCommand`; runtime `isBusy()` not isolated in harness |

Node S1: **unchanged** (26/26 contract suite unchanged this stage).

## Known limitations

- **Headless vs live:** `companionHeadlessMelee` skips explosion push and map-dependent audio/cache; live S3 should use UI state stack or keep headless for instant relay completion.
- **`companionExecuteMelee` overwrites `action.weapon` with `getMeleeWeapon()`** after hand validation — intentional native parity.
- **Reaction melee:** Stock comments in `MeleeAttackBState::think()` keep player reaction melee disabled; not enabled here.
- **Fair play:** Runtime uses actor `visibleUnits` + `getVisible()`; matches S1 LOS contract; no stun/HP in command results.

## Required S2b / S3 work

| Stage | Work |
|-------|------|
| **S2b** | Wire `CompanionCommandRuntime` dispatch for `MELEE_ATTACK`; resolve actor/item/target from snapshot binding; call `tryExecuteCompanionMeleeAttack`; dry-run/publish CLI unchanged. |
| **S3** | `ActiveCommand::KIND_MELEE` lifecycle (accepted → executing → completed); optional animated `UnitTurnBState` + `MeleeAttackBState` instead of instant headless; `tactical-result.json` fields (`melee_hit`, `target_incapacitated`, reject codes); extend harness for obstruction, elevation, busy battle, weapon ID mismatch, TU double-charge guard. |
| **Harness** | Consider lightweight `Map` stub via `setCompanionProjectileHarnessMap` if full UI parity tests need cache/sound paths. |

## Build note

Regenerate isolated tree when CMake changes:  
`cmake -S engine/OpenXcom -B build-isolated-m1-23e -G "Visual Studio 17 2022" -A Win32`  
then MSBuild `companion_melee_engine_test` / `companion_command_test` (incremental target builds per AGENTS.md).