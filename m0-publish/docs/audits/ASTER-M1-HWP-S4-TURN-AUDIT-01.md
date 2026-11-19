# ASTER-M1-HWP-S4-TURN-AUDIT-01 — HWP turn relay (accepted audit)

**Status:** Accepted — S4-1a through S4-1d complete; checkpoint S4 committed (runtime pin `e4f6a4d9…`)  
**Date:** 2026-11-19  
**Scope:** Hull and independent turret rotation exposed via relay **without changing underlying gameplay**  
**Prerequisite:** HWP-S3B `HWP_MOVE` live; soldier `TURN_FACE` complete (WP-TURN 1a–1d)

---

## Owner decisions

| Question | Decision |
|----------|----------|
| Enforce `Options::strafe`? | **Yes** for turret-only turns — match native CTRL+right-click; relay must not silently enable strafe. |
| Native spot-abort difference? | **Yes for v1** — document; soldier `TURN_FACE` already uses synchronous execution without mid-turn spot-abort. |
| Command structure | **One** `HWP_TURN` with required **`turn_part`**: `"body"` \| `"turret"`. |
| Default turning | **No default** — explicit `turn_part` only (no accidental hull rotation). |

---

## Executive summary

| Topic | Finding |
|--------|---------|
| Hull turn (2×2) | Same as 1×1: **1 TU per octagonal step**; bearing from anchor `position`; **no tile movement** when turning in place. |
| Turret | **Independent** only when `turn_part: "turret"` (native strafe). Hull turn **couples** turret to hull in `BattleUnit::turn(false)`. |
| Primary tactic | **`turn_part: "turret"`** — aim without `HWP_MOVE`. |
| `TURN_FACE` reuse | Contract shape, TU advisory, sync relay lifecycle — **new type** `HWP_TURN` + HWP binding (do not extend `TURN_FACE` to HWP ids). |
| Today | `HWP_TURN` → engine `UNSUPPORTED_COMMAND_TYPE`; Node S4-1a adds parse/compose/validate only. |

---

## Implementation risk — partial turn / `abortTurn()`

**Correction (accepted):** `abortTurn()` does **not** guarantee atomic rollback of facing or TU already spent.

**Engine obligation (S4-1b+):**

1. **Preflight** full turn cost (steps × 1 TU) and reaction **reserve** before any `lookAt` / `turn` loop — mirror soldier `tryExecuteCompanionTurnFace` + `executeTurnFace`.
2. **REJECTED** commands must leave **no partial mutations** when preflight fails.
3. If execution cannot guarantee rollback on failure, terminal result must report **observed** `final_direction` / `final_turret_direction` and `tu_spent` truthfully (same honesty bar as soldier `TURN_FACE` preflight rejects).

Soldier path already preflights steps + `checkReservedTU` before the loop; HWP turn executor must copy that pattern for both body and turret axes.

---

## Native reference (unchanged gameplay)

| Mode | Native | Engine flag |
|------|--------|-------------|
| Hull | Right-click tile | `UnitTurnBState` `_turret == false` |
| Turret | CTRL+right-click (requires `Options::strafe`) | `_action.strafe` + `getTurretType() > -1` |

**2×2:** No special-case in `UnitTurnBState`; walk strafe remains size-1 only (irrelevant to turn-in-place).

**Snapshot:** `bodyFacing`, `turretFacing`, `capabilities.bodyTurn` / `capabilities.turretTurn` (`friendlyHwpObservationV1`).

**Cannon vs Laser:** `turretTypeId` 0 vs 2 — cosmetic; turn mechanics identical.

---

## `HWP_TURN` relay contract (Node S4-1a)

```json
{
  "schema_version": 1,
  "command_id": "hwp-turn-example",
  "command_type": "HWP_TURN",
  "actor_unit_id": 1000000,
  "turn_part": "turret",
  "target": { "x": 7, "y": 5, "z": 0 },
  "snapshot_sha256": "<64-hex>",
  "session_id": "<32-hex>",
  "turn": 1,
  "state_version": 42
}
```

| Field | Rule |
|-------|------|
| `turn_part` | **Required** `"body"` or `"turret"` |
| `target` | Bearing tile (same as `TURN_FACE`); ≠ actor horizontal position |
| Binding | `player_hwps`, `controlMode: "ai"`, `hwpTurnExecutionSupported: true` |
| Node | Map bounds only; reject `turret` when `capabilities.turretTurn !== true` |
| Mutual exclusion | `TURN_FACE` on HWP id; `HWP_TURN` on soldier id |

**Terminal result (S4-1c+, engine):** synchronous `COMPLETED` / `REJECTED`; `tu_spent`, `final_direction`, optional `final_turret_direction`; positions unchanged.

---

## Phased delivery

| Phase | Deliverable |
|-------|-------------|
| **S4-1a** | Node compose/parse/validate/hints + tests (**this acceptance**) |
| **S4-1b** | `CompanionHwpTurnExecutionCore` + preflight-before-mutation |
| **S4-1c** | Relay sync dispatch + result JSON + `hwpTurnRelayExecutionSupported()` gate |
| **S4-1d** | Engine/relay harnesses (Cannon + Laser) |
| **Next** | `HWP_FIRE` (owner: tanks that do more than drive) |

---

## Key sources

| Area | Files |
|------|--------|
| Turn TU / facing | `CompanionTuVisibilityCore.cpp`, `UnitTurnBState.cpp`, `BattleUnit::turn` |
| Soldier relay | `CompanionTurnFaceExecutionCore.cpp`, `tactical-command.cjs` (`TURN_FACE`) |
| HWP binding | `hwp-command-binding.cjs`, `HWP_MOVE` patterns in `command-binding.cjs` |
| Prior gap audit | `ASTER-M1-TURN-HWP-SCANNER-AUDIT-01.md` |

---

## S4-1a completion checklist

- [x] Audit persisted (this document)
- [x] `composeHwpTurnCommand`, `parseHwpTurnCommand`, `validateHwpTurnAgainstSnapshot`
- [x] `buildHwpTurnPlanningHint`
- [x] `hwpTurnExecutionSupported` on binding rows
- [x] `tactical-command-m1-hwp-s4-turn.test.cjs`
- [x] `TURN_FACE` / `HWP_MOVE` regression in same suite

## S4-1b completion checklist

- [x] `CompanionHwpTurnExecutionCore` — body + turret, preflight before mutation
- [x] `Options::strafe` required for turret turns
- [x] `companion_hwp_turn_engine_test` — Cannon (turretType 0) + Laser (2)
- [x] `hwpTurnExecutionSupported: false` in binding until S4-1c runtime gate (flipped in S4-1c)
- [x] Relay sync `HWP_TURN` in `CompanionCommandRuntime` (`COMPLETED` / `REJECTED`)
- [x] `hwpTurnRelayExecutionSupported()` **true** with Node `hwpTurnExecutionSupported` mirroring runtime
- [x] `companion_hwp_turn_relay_test` — body Cannon, turret Laser, insufficient TU, strafe off, human HWP
- [x] Regressions: `companion_hwp_move_relay_test`, `companion_turn_face_engine_test`, `companion_hwp_turn_engine_test`, `companion_tactical_hwp_authority_test`, Node S4/S3B/WP-TURN-1a (29/29)

**S4-1c verified locally** — Release live drill scripted in `ASTER-M1-HWP-S4-1D-LIVE-DEPLOY.md` (owner acceptance). **Next:** `HWP_FIRE` — see `ASTER-M1-HWP-S5-FIRE-AUDIT-01.md` (no implementation until audit accepted).