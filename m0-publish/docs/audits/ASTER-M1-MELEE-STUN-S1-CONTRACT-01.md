# ASTER-M1-MELEE-STUN-S1-CONTRACT-01

**Date:** 2026-11-18  
**Scope:** Node `MELEE_ATTACK` command contract only (no engine execution, no relay runtime wiring, no commit/push)  
**Reference:** [ASTER-M1-MELEE-STUN-AUDIT-01.md](./ASTER-M1-MELEE-STUN-AUDIT-01.md)  
**Stop:** Owner review before S2 engine executor and S3 relay dispatch.

## Verdict

S1 **complete** on the Node side: parse, snapshot validation, composer, production `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot` dispatch, and focused tests for **`MELEE_ATTACK`**. No C++ parser, `tryExecuteCompanionMelee*`, or inbox execution.

## Changed files

| File | Role |
|------|------|
| `companion/m0-publish/lib/tactical-command.cjs` | `MELEE_ATTACK` parse/validate, dispatch, exports |
| `companion/m0-publish/lib/command-binding.cjs` | `composeMeleeAttackCommand` |
| `companion/m0-publish/lib/tactical-publish.cjs` | Export `BT_MELEE` constant (additive; used by validators/tests) |
| `companion/m0-publish/test/tactical-command-m1-melee-stun-s1.test.cjs` | Contract tests |
| `companion/m0-publish/docs/audits/ASTER-M1-MELEE-STUN-S1-CONTRACT-01.md` | This report |

## Command schema (`schema_version: 1`)

Shared envelope: `command_id`, `command_type`, `actor_unit_id`, `snapshot_sha256`, `session_id`, `turn`, `state_version`.

```json
{
  "command_type": "MELEE_ATTACK",
  "actor_unit_id": 1,
  "target_unit_id": 1000042,
  "melee_weapon_battle_item_id": 515,
  "active_hand": "STR_RIGHT_HAND"
}
```

Generic for any `BT_MELEE` hand weapon (stun rod or mod melee); no `STR_STUN_ROD` hardcoding.

## Validator behavior (summary)

| Check | Node (S1) | Engine (S2) |
|-------|-----------|-------------|
| Binding / stale `state_version` | Hard reject | — |
| Actor friendly roster + command-applicable readiness | Hard reject | Authority + busy |
| `commandBinding.player_soldiers` (when binding passed in `options`) | Hard reject | Tactical AI / inbox policy |
| Hand `BT_MELEE` + `melee_weapon_battle_item_id` | Hard reject | Owner / slot |
| `melee` row in `actionCosts` when export present | Hard reject if missing row, unaffordable TU, or `usable: false` | Authoritative |
| `actionCosts` absent on actor | Advisory only | Authoritative |
| Target genuine hostile + `confirmed_current_los` | Hard reject (psi pattern) | `validMeleeRange` / visibility |
| MC roster / MC alien / friendly target | Hard reject | — |
| Adjacency / elevation / obstruction | **Advisory only** | `validMeleeRange`, `canTargetUnit` |
| Hit / miss / stun outcome | Never simulated | Authoritative |

Entry points:

- `parseMeleeAttackCommand` / `parseMeleeTacticalCommand` / `isMeleeTacticalCommandType`
- `validateMeleeAgainstSnapshot` / `validateMeleeTacticalCommandAgainstSnapshot`
- `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot` (dry-run CLI compatible)

**Not wired:** `CompanionCommandCore` parse/execute, `CompanionCommandRuntime` dispatch, `tactical-result.json` melee fields.

**Binding note:** `validateActorListedInPlayerSoldiers` runs when callers pass `options.commandBinding` (recommended for publish dry-runs). Snapshot-only validation still enforces roster + readiness via `validateMeleeActorEligibility`.

## Tests

```text
node --test companion/m0-publish/test/tactical-command-m1-melee-stun-s1.test.cjs
```

**11/11 pass** (2026-11-18).

Regression spot-check (unchanged suites):

```text
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s1.test.cjs
```

**8/8 + 7/7 pass** (same run).

## S2 blockers / contract notes for engine

1. **Publish now validates `MELEE_ATTACK` in Node** — `publish-tactical-command-once.cjs --dry-run` accepts drafts; **`--publish` will fail at engine** until S2a+S3 (same posture as psi/medikit before relay land).
2. **Terminal semantics** — melee is animated (`UnitTurnBState` + `MeleeAttackBState`); expect `ActiveCommand::KIND_MELEE` in-flight completion, not medikit-style instant `COMPLETED`.
3. **Result payload** — S1 does not define engine result JSON; audit recommends `melee_hit`, `tu_spent`, `target_status` after animation (S2b).
4. **`options.commandBinding`** — relay CLI should pass binding into `validateTacticalCommandAgainstSnapshot` for `player_soldiers` gate (S3 parity with cooperative autonomy).
5. **Fair-play** — reject strings stay generic (no alien type leakage); target policy reuses `validatePsiHostileTargetAgainstSnapshot`.
6. **TU** — Node reads exported `actionCosts.melee.tuCost`; never hardcodes stun rod 30% ruleset value.

## Operator caveat

Dry-run and validate paths recognize `MELEE_ATTACK`. Live inbox execution remains **unsupported** until engine work lands; do not treat successful Node validation as executable relay capability.

## Unresolved questions (owner)

1. Should runtime always require `options.commandBinding` for melee validate (strict) vs optional (current)?
2. Should sparse snapshots without `actionCosts` hard-reject before S2 export guarantees land (current: advisory)?
3. Confirm `MELEE_ATTACK` vs audit’s identical spelling for C++ `command_type` string parity in S2.

## Compatibility

- Additive dispatch only; medikit, psi, and firearm parsers untouched in regression tests.
- `tactical-command.cjs` continues importing `isCommandApplicableForBinding` from `command-binding.cjs` (no new circular import).

**Stop condition met:** S1 Node contract only — no C++, deployment, commit, or push.