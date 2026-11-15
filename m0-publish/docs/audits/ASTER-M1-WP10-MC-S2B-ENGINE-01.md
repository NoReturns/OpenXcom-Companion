# ASTER-M1-WP10-MC-S2B-ENGINE-01

**Date:** 2026-11-15
**Scope:** Engine executor + snapshot `mindcontrol` export + focused harness tests
**Stop:** Owner review before S3 relay dispatch. No commit/push, no production deploy, no live commands.

## Verdict

S2b **complete** on the engine side: native `BA_MINDCONTROL` execution mirrors accepted panic plumbing; faction conversion and TU accounting are engine-authoritative; MC aliens remain outside Companion tactical command authority. **S3 relay dispatch not wired.**

## Changed files

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionPsiExecutionCore.{h,cpp}` | `executeMindControl` |
| `engine/OpenXcom/src/Battlescape/PsiAttackBState.{h,cpp}` | `companionExecuteMindControl`; shared preflight/TU path |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.{h,cpp}` | `tryExecuteCompanionPsiMindControl`; shared psi preflight helper |
| `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | Export `mindcontrol` actionCosts (`BA_MINDCONTROL`, id `mindcontrol`) |
| `engine/OpenXcom/src/test/companion_psi_mind_control_engine_test.cpp` | Focused executor harness |
| `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` | Snapshot export assertions |
| `engine/OpenXcom/src/CMakeLists.txt` | `companion_psi_mind_control_engine_test` target |

## Execution path

`BattlescapeGame::tryExecuteCompanionPsiMindControl` → shared panic authorization (AI-owned actor, held `BT_PSIAMP`, `psiSkill > 0`, genuine hostile target) → `CompanionPsiExecutionCore::executeMindControl` → `PsiAttackBState::companionExecuteMindControl` → native `psiAttack()` → single TU spend.

Psychic success/failure is visible only to engine-private test outputs (`psychicSucceededOut`); no relay JSON changes in S2b.

## Mind-control ownership (M1)

On successful native MC:

- `faction` becomes player; `originalFaction` stays hostile (genuine-hostile snapshot semantics).
- Converted units are **not** roster soldiers and are **not** inserted into `_companionTacticalAiSoldierIds`.
- Briefing `xcom_controlled_hostile_unit` behavior unchanged (Node S1 already rejects such targets for psychic commands).
- Native FOV (`calculateFOV`) and `allowPsionicCapture` mission-end rules unchanged (harness proves remaining hostiles block auto-capture end).

## Test evidence (2026-11-15, `build-isolated-m1-23e` Release)

| Suite | Result |
|-------|--------|
| `companion_psi_mind_control_engine_test.exe` | **exit 0** (9 scenarios) |
| `companion_psi_panic_engine_test.exe` | **exit 0** (regression) |
| `companion_medikit_engine_test.exe` | **exit 0** (regression) |
| `companion_snapshot_serialization_test.exe` | **exit 0** (`mindcontrol` export) |
| Node MC S1 + Panic S1 | **14/14** pass |

## S3 dependencies (not in S2b)

1. `CompanionCommandCore` — `PsiMindControlCommandParsed`, parse/validate JSON.
2. `CompanionCommandRuntime` — inbox dispatch, `buildPsiMindControlResultJson`, `fillPsiMindControlValidationInput` (panic mirror, no psychic leak).
3. Node `tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs` (optional).
4. Owner-authorized production deploy only after S3 + S4 gates.
