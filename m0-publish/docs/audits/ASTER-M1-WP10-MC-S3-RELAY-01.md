# ASTER-M1-WP10-MC-S3-RELAY-01

**Date:** 2026-11-15
**Scope:** Relay inbox dispatch + fair-play terminal results for `PSI_MIND_CONTROL`
**Stop:** Owner review before S4 live deployment. No commit/push, no production deploy.

## Verdict

S3 **complete** on the relay path: `PSI_MIND_CONTROL` parses and validates in `CompanionCommandCore`, dispatches through `CompanionCommandRuntime::tickCompanionCommand` to `BattlescapeGame::tryExecuteCompanionPsiMindControl`, and writes the same bounded terminal contract as panic (`COMPLETED` + `tu_spent`; no psychic outcome). Panic relay behavior unchanged.

## Changed files

| File | Why |
|------|-----|
| `engine/OpenXcom/src/Engine/CompanionCommandCore.{h,cpp}` | `PsiMindControlCommandParsed`, `parsePsiMindControlCommandJson`, `validatePsiMindControlCommand` |
| `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` | Inbox allow-list, `fillPsiMindControlValidationInput`, `buildPsiMindControlResultJson`, `rejectPsiMindControlCommand`, dispatch branch |
| `engine/OpenXcom/src/test/companion_command_test.cpp` | Core parse/validate unit tests |
| `engine/OpenXcom/src/test/companion_psi_panic_relay_e2e_harness.cpp` | MC inbox JSON helpers + relay scenarios (`runPsiMindControlRelayE2eSuite*`) |
| `companion/m0-publish/test/tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs` | Node production-path validation |

## Execution flow

1. Inbox `command_type` `PSI_MIND_CONTROL` (allow-list alongside `PSI_PANIC`).
2. `parsePsiMindControlCommandJson` → binding/authority fields (panic schema).
3. Journal + duplicate handling (MC-specific reject templates).
4. `fillPsiMindControlValidationInput` + `validatePsiMindControlCommand` (genuine hostile, visible, `BA_MINDCONTROL` TU preflight).
5. `tryExecuteCompanionPsiMindControl` — native `psiAttack()`, **no** `psychicSucceededOut` on wire.
6. Terminal `tactical-result.json`: `COMPLETED` + `tu_spent` on executed attempts (success or failed roll); `REJECTED` + `public_reason` on preflight/parse failures (**0 TU**).

## Acknowledgement contract

| Outcome | `status` | `tu_spent` | Psychic / faction leak |
|---------|----------|------------|------------------------|
| Preflight / parse reject | `REJECTED` | absent | `public_reason` only (generic) |
| Engine could not execute | `REJECTED` | absent | `PSI_MIND_CONTROL_APPLICATION_FAILED` + bounded reason |
| Attempt completed (any roll) | `COMPLETED` | authoritative | **No** success/failure, morale, or hidden stats |

Panic JSON shape is the reference; `command_type` is `PSI_MIND_CONTROL`.

## Ownership & fair-play (unchanged from S2b)

- MC aliens: not `isLiveRosterSoldier`; not added to `getCompanionTacticalAiSoldierIds()`.
- Node S3 rejects `xcom_controlled_hostile_unit` targets for follow-up psi commands.
- Native MC duration / faction restoration not altered.

## Test evidence (2026-11-15)

| Suite | Result |
|-------|--------|
| `companion_command_test.exe` (panic + MC parse/validate) | **exit 0** |
| `companion_psi_mind_control_engine_test.exe` (S2b executor) | **exit 0** |
| `companion_psi_panic_engine_test.exe` (regression) | **exit 0** |
| Node `tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs` | **4/4** |
| Node `tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs` | **3/3** |
| Node MC S1 + Panic S1 | unchanged green |

### Native relay harness note

`runPsiMindControlRelayE2eSuiteExtended()` (success / failed roll / insufficient TU inbox) is implemented beside panic harness helpers. **Not wired as a default exe gate** — post-MC FOV tick in the combined harness is unstable (panic S4 documents the same class of issue). Preflight reject path (`runMcRelayInsufficientTuRejected`) is available for future harness enablement. **S3 acceptance** rests on runtime C++ dispatch + `companion_command_test` + Node S3 + S2b executor suites.

## Remaining S4 / risks

1. Owner-authorized runtime deploy + optional native inbox E2E gate after harness tile/FOV stabilization.
2. Operator runbook: MC vs panic `command_type` and shared fair-play result semantics.
3. Live F6 + GitHub inbox validation on production binary (outside S3).
4. If extended harness is enabled: run `runPsiMindControlRelayE2eSuiteExtended()` and confirm `tu_spent` parity for success vs failed roll.
