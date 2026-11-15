# ASTER-M1-WP10-MC-S1-CONTRACT-01

**Date:** 2026-11-15
**Scope:** Node `PSI_MIND_CONTROL` command contract and isolated dry-run validation only
**Stop:** Owner review before S2b engine executor and relay dispatch.

## Verdict

S1 **complete** on the Node side: parse, snapshot validation, composer, and focused tests for **`PSI_MIND_CONTROL`**. Reuses the accepted WP10 Psi-Amp envelope (`psi_amp_battle_item_id`, `active_hand`, `target_unit_id`) and shared actor/skill/hand validators with **`PSI_PANIC`**. No engine, runtime inbox execution, or relay dispatch. WP9 medikit and WP10 panic behavior unchanged.

## Changed files

| File | Role |
|------|------|
| `companion/m0-publish/lib/tactical-command.cjs` | Parse, validate, `validateTacticalCommandAgainstSnapshot` dispatch |
| `companion/m0-publish/lib/command-binding.cjs` | `composePsiMindControlCommand` |
| `companion/m0-publish/lib/tactical-publish.cjs` | Additive `mindcontrol` action id, `BA_MINDCONTROL` (11) in schema |
| `companion/m0-publish/test/tactical-command-m1-wp10-psi-mind-control-s1.test.cjs` | Contract tests |
| `companion/m0-publish/docs/audits/ASTER-M1-WP10-MC-S1-CONTRACT-01.md` | This report |

## Command schema (schema_version 1)

Same envelope as panic; only `command_type` differs:

```json
{
  "command_type": "PSI_MIND_CONTROL",
  "actor_unit_id": 1,
  "target_unit_id": 1000043,
  "psi_amp_battle_item_id": 802,
  "active_hand": "STR_LEFT_HAND"
}
```

## Validator behavior (summary)

| Check | Node (S1) | Engine (S2b) |
|-------|-----------|----------------|
| Binding / stale `state_version` | Hard reject | — |
| Actor friendly roster + command-applicable readiness | Hard reject | Authority + busy |
| `psiSkill > 0` | Hard reject **only when** `psiSkill` exported | Always |
| Hand `BT_PSIAMP` + battle item id | Hard reject | — |
| Target genuine hostile + `confirmed_current_los` | Hard reject | Visibility / faction / LOS |
| MC roster / MC alien (`xcom_controlled_hostile_unit`) / friendly target | Hard reject | — |
| Missing target / no facing | Hard reject | — |
| `mindcontrol` `actionCosts` / TU | Hard reject if exported unaffordable; **advisory if missing** | Authoritative |
| Psychic RNG / MC success | **Never simulated or exported** | Authoritative |
| Post-MC faction / commandability | Planning hint only | MC aliens **not** in `player_soldiers` (M1) |

Entry points:

- `parsePsiTacticalCommand` / `validatePsiTacticalCommandAgainstSnapshot`
- `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot` (dry-run CLI compatible)

**Not wired:** `CompanionCommandRuntime` dispatch, C++ parse/execute, relay success path, `psychic_attack_succeeded` in results (same fair-play rule as panic).

## S2b engine integration notes

1. **Executor:** `BattlescapeGame::tryExecuteCompanionPsiMindControl` → `CompanionPsiExecutionCore::executeMindControl` (mirror panic; native `psiAttack()` with `BA_MINDCONTROL`).
2. **TU:** `getActionTUs(BA_MINDCONTROL, psiAmp)`; spent on attempted attacks per OpenXcom rules (engine tests should prove fail-roll still debits TU).
3. **Snapshot export:** `actionCosts.hands.*.actions[]` with `id: "mindcontrol"`, `actionType: 11`.
4. **Relay terminal result:** `COMPLETED` + `tu_spent` only — **no** `psychic_attack_succeeded`, faction flip, or MC commandability flags in public JSON.
5. **Post-success briefing:** `xcom_controlled_hostile_unit` in `unitStateBrief.exceptions`; target drops from `visibleHostileObservations` / `confirmed_current_los` eligibility for future panic/MC commands.
6. **Command core:** `parsePsiMindControlCommandJson`, `validatePsiMindControlCommand`, runtime branch parallel to panic (S3).

## Tests

```text
node --test companion/m0-publish/test/tactical-command-m1-wp10-psi-mind-control-s1.test.cjs
node --test companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s1.test.cjs
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs
```

Regression: panic and medikit S1 suites must remain green after MC S1.

## Unresolved questions (carry forward from panic audit)

1. Hand-held psi amp only vs `getSpecialWeapon(BT_PSIAMP)` fallback.
2. Confirm engine blocks MC commands against already-MC’d aliens even if snapshot timing races (Node rejects `xcom_controlled_hostile_unit` at export).
