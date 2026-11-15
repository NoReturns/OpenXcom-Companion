# ASTER-M1-WP10-PSI-AMP-S1-CONTRACT-01

**Date:** 2026-11-15
**Scope:** Node `PSI_PANIC` command contract and isolated dry-run validation only
**Stop:** Owner review before S2a engine executor and relay dispatch.

## Verdict

S1 **complete** on the Node side: parse, snapshot validation, composer, and focused tests for **`PSI_PANIC`**. No engine, runtime inbox execution, or `PSI_MIND_CONTROL` work. WP9 medikit modules were not modified except shared **`BT_PSIAMP`** export constant on `tactical-publish.cjs` (additive).

## Changed files

| File | Role |
|------|------|
| `companion/m0-publish/lib/tactical-command.cjs` | Parse, validate, `validateTacticalCommandAgainstSnapshot` dispatch |
| `companion/m0-publish/lib/command-binding.cjs` | `composePsiPanicCommand` |
| `companion/m0-publish/lib/tactical-publish.cjs` | `BT_PSIAMP = 9`; schema prep: `panic` action id, `BA_PANIC` (12) in `actionCosts` |
| `companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s1.test.cjs` | Contract tests |
| `companion/m0-publish/docs/audits/ASTER-M1-WP10-PSI-AMP-S1-CONTRACT-01.md` | This report |

## Command schema (schema_version 1)

Shared envelope: `command_id`, `command_type`, `actor_unit_id`, `snapshot_sha256`, `session_id`, `turn`, `state_version`.

```json
{
  "command_type": "PSI_PANIC",
  "actor_unit_id": 1,
  "target_unit_id": 1000042,
  "psi_amp_battle_item_id": 801,
  "active_hand": "STR_LEFT_HAND"
}
```

**Weapon policy (owner):** hand-held Psi-Amp only via `psi_amp_battle_item_id` + `active_hand` (no `getSpecialWeapon` path in S1).

## Validator behavior (summary)

| Check | Node (S1) | Engine (S2a) |
|-------|-----------|----------------|
| Binding / stale `state_version` | Hard reject | — |
| Actor friendly roster + command-applicable readiness | Hard reject | Authority + busy |
| `psiSkill > 0` | Hard reject **only when** `psiSkill` exported | Always |
| Hand `BT_PSIAMP` + battle item id | Hard reject | — |
| Target genuine hostile + `confirmed_current_los` | Hard reject | Visibility / faction / LOS |
| MC roster / MC alien / friendly target | Hard reject | — |
| Missing target / no facing | Hard reject | — |
| `panic` `actionCosts` / TU | Hard reject if exported unaffordable; **advisory if missing** | Authoritative |
| Psychic RNG / outcome | **Never simulated** | Authoritative |
| MC’d aliens commandable | N/A — not in scope | Remain non-`player_soldiers` |

Entry points:

- `parsePsiTacticalCommand` / `validatePsiTacticalCommandAgainstSnapshot`
- `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot` (dry-run CLI compatible)

**Not wired:** `CompanionCommandRuntime` dispatch, C++ parse/execute, relay success path.

## S2a export dependencies (documented)

Node S1 does **not** require these for dry-run acceptance; engine S2a should add where noted:

| Field | S1 behavior | S2a need |
|-------|-------------|----------|
| `psiSkill` on friendly roster | Advisory if absent; hard reject if `<= 0` | Export on roster soldiers |
| `actionCosts.hands.*.actions[]` with `id: "panic"` | Advisory if absent; TU gate if present | Export when hand holds `BT_PSIAMP` |
| `psychic_attack_succeeded` / `tu_spent` result | Out of S1 scope | Terminal result JSON |
| Visibility at execution vs export | Advisory note | Live `getVisible()` + targeting |

## Tests

```text
node --test companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s1.test.cjs
```

**7/7 pass** (2026-11-15).

Regression spot-check (WP9 untouched logic):

```text
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs
```

## Unresolved questions

1. Should compose-time optionally reject `target_unit_id` when owner passes tactical into a future helper (today compose is binding-only like medikit)?
2. When `psiSkill` export lands, should Node hard-reject `psiSkill === 0` before publish even if engine might still block (current: yes when field present)?
3. Export action id: confirm `"panic"` vs numeric `actionType: 14` only in snapshot (both allowed in tests; id is the validator key).

## Compatibility concerns

- **`parseTacticalCommand` now accepts `PSI_PANIC`:** `publish-tactical-command-once.cjs --dry-run` can validate psi drafts; **`--publish` would still fail at engine** until S2a+S3 — operators should not publish psi commands yet.
- **Circular import risk:** `tactical-command.cjs` imports `isCommandApplicableForBinding` from `command-binding.cjs`; binding does not import tactical-command (safe).
- **Fixtures with `psiSkill`:** Not valid in `loadAndValidateSnapshotFromText` until S2a adds the unit field; the zero-`psiSkill` test mutates the parsed tactical object after load.
