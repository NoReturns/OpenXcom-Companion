# ASTER-M1-WP-TURN-1A — Node contract (`TURN_FACE`)

**Date:** 2026-11-19  
**Scope:** Roster soldiers only; Node parse / validate / compose; **no engine or relay runtime changes**.

---

## Implementation summary

| Artifact | Location |
|----------|----------|
| Parse + validate | `companion/m0-publish/lib/tactical-command.cjs` |
| Compose | `companion/m0-publish/lib/command-binding.cjs` → `composeTurnFaceCommand` |
| TU advisory | `companion/m0-publish/lib/tu-composite-advisory.cjs` → `buildTurnFacePlanningHint` |
| Tests | `companion/m0-publish/test/tactical-command-m1-wp-turn-1a.test.cjs` |

**Command envelope (schema v1):**

```json
{
  "schema_version": 1,
  "command_id": "turn-face-example",
  "command_type": "TURN_FACE",
  "actor_unit_id": 1,
  "target": { "x": 2, "y": 3, "z": 0 },
  "snapshot_sha256": "<64-hex>",
  "session_id": "<32-hex>",
  "turn": 1,
  "state_version": 42
}
```

`target` is the **map tile used as the facing bearing** (native right-click turn), not a movement destination.

**Validation rules (Node):**

- Standard binding freshness (`snapshot_sha256`, `session_id`, `turn`, `state_version`).
- Actor: friendly roster soldier, `isCommandApplicableForBinding`, optionally listed in `commandBinding.player_soldiers` when `options.commandBinding` is supplied.
- `target` within `tactical.map` width/height/depth.
- `target` must **not** equal actor `position` (same-tile facing undefined in Node).
- **No** LOS, visibility, or terrain checks (fair-play).
- Non-authoritative `planningHint` via `buildTurnFacePlanningHint` (1 TU/step estimate when `facing` exported).

**Production dispatch:** `parseTacticalCommand` and `validateTacticalCommandAgainstSnapshot` accept `TURN_FACE` for CLI dry-run / publish validation. Downstream engine relay (WP-TURN-1b/1c/1d) is **out of scope** for this package.

**Traceability:** Implements [ASTER-M1-TACTICAL-COMPLETION-AUDIT-01](./ASTER-M1-TACTICAL-COMPLETION-AUDIT-01.md) §7.4 (soldier `TURN_FACE` only).

---

## Test results (owner re-verification 2026-11-19)

| Suite | Result |
|-------|--------|
| `tactical-command-m1-wp-turn-1a.test.cjs` | **11/11 PASS** |
| `tactical-command-m1-24b.test.cjs` (KNEEL unchanged) | **PASS** |
| `tactical-composite-tu-m1.test.cjs` | **PASS** |

Focused 1a cases covered: valid facing + advisory, stale `state_version`, OOB target, same-tile target, actor not in `player_soldiers`, non-roster/HWP `actor_unit_id`, dispatcher wiring, KNEEL regression.

---

## Files changed

- `companion/m0-publish/lib/tactical-command.cjs`
- `companion/m0-publish/lib/command-binding.cjs`
- `companion/m0-publish/lib/tu-composite-advisory.cjs`
- `companion/m0-publish/test/tactical-command-m1-wp-turn-1a.test.cjs` (new)
- `companion/m0-publish/docs/audits/ASTER-M1-WP-TURN-1A-NODE-CONTRACT-01.md` (this report)

---

## Contract ambiguities (owner decision)

| Topic | WP-1a choice | Notes |
|-------|--------------|-------|
| **Field name `target` vs `destination`** | `target` | Aligns with directed fire / melee bearing; avoids MOVE confusion. |
| **Same tile as actor** | **Hard reject** in Node + compose | Engine `lookAt` on self-tile is undefined; alternative: advisory-only. |
| **Elevated bearing (`target.z` ≠ actor `z`)** | Allowed in bounds | Engine authoritative; no Node elevation check. |
| **`player_soldiers` gate** | Only when `options.commandBinding` passed | Matches `MELEE_ATTACK`; relay CLI should pass binding on publish (documented MELEE S1 gap). |
| **`strafe_turret` / HWP** | **Excluded** | Per completion audit; not in schema. |
| **Door open on turn-to-tile** | Not modeled | Native `UnitTurnBState` may open doors when `BA_NONE`; noted in planning hint. |
| **Publish before engine** | **Historical** | At 1a land-time, engine lacked dispatch; later WPs added execution (not part of 1a). |

---

## Status

**WP-TURN-1a — COMPLETE** (Node contract only). No further 1a work required unless contract changes.

STOP — owner review.