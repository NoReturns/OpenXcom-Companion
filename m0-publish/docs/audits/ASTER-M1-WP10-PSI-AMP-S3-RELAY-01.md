# ASTER-M1-WP10-PSI-AMP-S3-RELAY-01

**Status:** S3 complete (relay dispatch + fair-play results + focused tests). **Await owner review** before S4 live deployment. No commit/push, no `PSI_MIND_CONTROL`, no production runtime deploy.

## Summary

`PSI_PANIC` is integrated on the existing tactical command inbox path: `CompanionCommandCore` parse/validate → `CompanionCommandRuntime::tickCompanionCommand` → `BattlescapeGame::tryExecuteCompanionPsiPanic`. Native psychic resolution and TU rules remain engine-authoritative. Terminal `tactical-result.json` reports **COMPLETED** with `tu_spent` for executed attempts (including failed psychic rolls) and **REJECTED** with generic `public_reason` when the engine does not execute.

## Changed files

| Area | Files |
|------|--------|
| Command core | `engine/OpenXcom/src/Engine/CompanionCommandCore.{h,cpp}` — `PsiPanicCommandParsed`, `PsiPanicValidationInput`, `parsePsiPanicCommandJson`, `validatePsiPanicCommand` |
| Runtime | `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` — inbox dispatch, `buildPsiPanicResultJson`, `rejectPsiPanicCommand`, `fillPsiPanicValidationInput` |
| Tests | `engine/OpenXcom/src/test/companion_psi_panic_relay_e2e_harness.cpp`, `companion_psi_panic_engine_test.cpp`, `companion_command_test.cpp`, `companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs` |
| Docs | `companion/m0-publish/docs/audits/ASTER-M1-WP10-PSI-AMP-S1-CONTRACT-01.md` (`BA_PANIC` **12** correction) |

WP9 medikit modules unchanged except shared runtime helpers extended for a new command template (no medikit logic changes).

## Public `tactical-result.json` contract — `PSI_PANIC`

### COMPLETED

```json
{
  "schema_version": 1,
  "command_id": "psi-panic-01",
  "command_type": "PSI_PANIC",
  "status": "COMPLETED",
  "session_id": "<hex>",
  "turn": 1,
  "actor_unit_id": 1,
  "psi_amp_battle_item_id": 801,
  "active_hand": "STR_LEFT_HAND",
  "target_unit_id": 100042,
  "starting_position": { "x": 1, "y": 1, "z": 0 },
  "final_position": { "x": 1, "y": 1, "z": 0 },
  "remaining_tu": 35,
  "kneeled": false,
  "tu_spent": 25,
  "snapshot_sha256": "<post-command export hash>",
  "inbox_sha256": "<digest>",
  "completed_at": "engine-local"
}
```

- **No** `psychicSucceeded`, morale delta, alien `psiSkill` / `psiStrength`, or roll outcome fields.
- Failed psychic rolls still emit **COMPLETED** with authoritative `tu_spent`.

### REJECTED

Same header fields where parse succeeded; includes `public_reason` (binding, hand, TU, visibility, prohibited target, or `PSI_PANIC_APPLICATION_FAILED` with generic engine text). No hidden alien psychic statistics.

## Fair-play verification

- Result builder only emits schema fields above; relay E2E asserts result JSON contains no `psychic`, `morale`, `psiStrength`, or `succeeded` substrings.
- Executor invoked with `psychicSucceededOut = nullptr` on the relay path.
- Node/S1 validation still requires `classifyCurrentHostileObservation` **confirmed_current_los**; engine re-checks visibility/faction at execute time.
- Successful completion calls `CompanionRelayPublicationFreshnessCore::noteTacticalBattleMutation()` (same as medikit terminal).

## Example commands

**Inbox (minimal):**

```json
{
  "schema_version": 1,
  "command_id": "wp10-relay-panic-ok",
  "command_type": "PSI_PANIC",
  "actor_unit_id": 1,
  "target_unit_id": 100042,
  "psi_amp_battle_item_id": 801,
  "active_hand": "STR_LEFT_HAND",
  "snapshot_sha256": "<64-hex>",
  "session_id": "<32-hex>",
  "turn": 1,
  "state_version": 14
}
```

## Focused test evidence

| Suite | Result |
|-------|--------|
| `companion_psi_panic_engine_test` (executor + relay harness) | PASS |
| `companion_command_test` (parse/validate psi) | PASS (with existing command suite) |
| `companion_medikit_engine_test` | PASS (regression) |
| Node WP10 S1 | 7/7 |
| Node WP9 medikit S1 | 8/8 |
| Node WP10 S3 relay | 3/3 |

Relay harness cases: success COMPLETED + `tu_spent`; failed roll COMPLETED + TU; insufficient TU / wrong hand / stale binding / hidden hostile REJECTED; no psychic leakage in results.

## Remaining S4 deployment dependencies

1. Operator publish path already supports dry-run for `PSI_PANIC`; live F6 + GitHub inbox still requires owner-authorized deployment (not in S3).
2. Optional: dedicated Node S4 E2E wrapper like WP9 `tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs`.
3. Operator runbook update for panic result semantics (COMPLETED vs psychic success).

## Constraints honored

No `PSI_MIND_CONTROL`, no native psychic formula changes, no WP9 medikit behavior edits, no commit/push, no live mission automation.
