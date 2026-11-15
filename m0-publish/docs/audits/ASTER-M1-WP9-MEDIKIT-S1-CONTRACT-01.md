# ASTER-M1-WP9-MEDIKIT-S1-CONTRACT-01

**Date:** 2026-11-15
**Scope:** Node command contract only (no engine execution, no relay wiring)
**Stop:** Owner review before S2 engine + relay integration.

## Verdict

S1 **complete** on the Node side: parse, snapshot validation, composers, and focused tests for **`HEAL`**, **`STIMULANT`**, and **`PAINKILLER`**. Medikit commands are **not** registered in `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot`, so publish/relay paths that use those entry points still reject medikit types until S2.

## Changed files

| File | Role |
|------|------|
| `companion/m0-publish/lib/tactical-command.cjs` | Parsers, validators, exports |
| `companion/m0-publish/lib/command-binding.cjs` | `composeHealCommand`, `composeStimulantCommand`, `composePainKillerCommand` |
| `companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs` | Contract tests |
| `companion/m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-S1-CONTRACT-01.md` | This report |

## Command schemas (schema_version 1)

Shared envelope: `command_id`, `command_type`, `actor_unit_id`, `snapshot_sha256`, `session_id`, `turn`, `state_version`.

### STIMULANT / PAINKILLER

```json
{
  "command_type": "STIMULANT",
  "actor_unit_id": 1,
  "target_unit_id": 2,
  "medikit_battle_item_id": 701,
  "active_hand": "STR_RIGHT_HAND"
}
```

(`PAINKILLER` identical except `command_type`.)

### HEAL

Adds **`body_part`**: integer **0–5** (production `UnitBodyPart`).

## Validator behavior (summary)

| Check | Engine-authoritative later | Node (S1) |
|-------|---------------------------|-----------|
| Binding/session/turn/state_version | — | Hard reject |
| Actor player faction | — | Hard reject |
| `active_hand` + `medikit_battle_item_id` in hand | — | Hard reject; `BT_MEDIKIT`; optional `slot` match |
| Target `target_unit_id` | Geometry/range | Hard reject if not in snapshot or not **friendly roster soldier** (no hostile intel in errors) |
| Charge pool | — | Hard reject when `medikitCharges` exported and depleted; advisory if charges missing |
| TU (`actionCosts` `use`) | — | Hard reject when exported and not affordable/usable; advisory if row missing |
| Target geometry / carried body | — | Advisory only |
| HEAL on unwounded `body_part` | May waste charge | **Advisory** (`heal_no_fatal_wound_on_part`), not hard reject |
| Composer `player_soldiers` | Relay ownership | Hard reject at compose time |

Entry points:

- `parseMedikitTacticalCommand` / `validateMedikitTacticalCommandAgainstSnapshot`
- Per-type: `parseHealCommand`, `validateHealAgainstSnapshot`, etc.

**Not wired:** `parseTacticalCommand`, `validateTacticalCommandAgainstSnapshot`, `relay-tactical-command-publish` (still call `parseTacticalCommand` → `unsupported command_type` for medikit).

## Tests

```text
node --test test/tactical-command-m1-wp9-medikit-s1.test.cjs
```

8/8 pass (2026-11-15).

## Limitations / readiness for S2

1. **No engine** `tryExecuteCompanionMedikit*` or `CompanionCommandRuntime` dispatch.
2. **No relay execution path** — must extend `parseTacticalCommand` + watcher/runtime together in S2.
3. **Target legality** (melee range, unconscious same-tile) remains engine-only; Node advisories do not reject valid-looking geometry mistakes.
4. **AI ownership** enforced at compose via `player_soldiers`; sidecar soldier-control parity at execution unchanged from other commands.

## S2 acceptance hints

- Wire medikit types into relay parse/dispatch only when engine executor lands.
- Terminal `tactical-result.json` for one atomic application.
- Preserve S1 advisory fields in planning hints or result metadata where useful.