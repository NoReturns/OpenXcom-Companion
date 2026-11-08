# M1-WP2 — Tactical unit facing, condition, readiness

Optional fields on `tactical.units[]` for schema version **3+** (compatible with v4/v5 roots). Older snapshots omit these keys.

## Coordinate convention

Engine `BattleUnit` direction **0–7** matches `Pathfinding::directionToVector`: **0 = north (decreasing map Y)**, then clockwise through northeast … northwest. Exported `facing.vector` uses map deltas `{ dx, dy }` (not screen pixels).

## Friendly roster soldiers (`exportFriendlyTacticalDetails`)

| Field | Type | Meaning |
|-------|------|---------|
| `facing.direction` | int 0–7 | Engine facing at capture |
| `facing.label` | string | Cardinal/intercardinal label |
| `facing.vector.dx` | int −1..1 | Map X step for facing |
| `facing.vector.dy` | int −1..1 | Map Y step for facing |
| `facing.turning` | bool? | Present when `engineStatus` is `turning` |
| `condition.energy` | int ≥0 | Current stamina (UI energy) |
| `condition.maxEnergy` | int ≥0? | `getBaseStats()->stamina` when available |
| `condition.morale` | int ≥0 | Bravery/morale stat |
| `condition.stunLevel` | int ≥0 | Stun damage (not unconsciousness by itself) |
| `condition.alive` | bool | `engineStatus != dead` |
| `condition.conscious` | bool | Not unconscious/dead per engine status |
| `condition.engineStatus` | string | Engine `UnitStatus` id |
| `condition.engineStatusId` | int 0–10 | Numeric `UnitStatus` |
| `condition.floating` | bool | `BattleUnit::isFloating()` |
| `condition.movementType` | string | walk/fly/slide/float/sink |
| `condition.movementTypeId` | int 0–4 | `MovementType` enum |
| `readiness.summary` | string | Derived informational summary |
| `readiness.engineActingUnitAvailable` | bool | Engine: player soldier on map and not `isOut()` — **not** Companion command authorization |
| `readiness.observationNote` | string | Clarifies ownership/binding/executor checks remain authoritative |

Remote command acceptance tests must use **AI-owned** soldiers only. `engineActingUnitAvailable: true` does **not** imply the Companion may command that unit while human-controlled.

**Omitted** when facing invalid: collapsing, dead, or direction outside 0–7.

Live roster soldiers who are **unconscious or dead** remain in `units[]` (position + condition); `actionCosts` omitted when `isOut()`.

## Friendly HWPs (sparse shell, M1)

Friendly heavy weapons platforms are **not** geoscape roster soldiers: battlescape `id >= BattleUnit::MAX_SOLDIER_ID` (1_000_000) with `getGeoscapeSoldier() == 0`. M1 exports them in `tactical.units[]` for **situational awareness only**, using a fixed sparse contract — **not** an accidental omission.

| Allowed on `tactical.units[]` | Forbidden on friendly HWP rows (schema v5 rejects extras) |
|------------------------------|-----------------------------------------------------------|
| `id`, `faction`, `originalFaction`, `position` | `name`, `health`, `timeUnits`, `hands`, `inventory`, `actionCosts`, `condition`, `readiness`, `observedUnitType`, `displayLabel`, … |

**Engine:** `exportFriendlyTacticalDetails()` is false for HWPs; `appendUnit()` emits the shell only (`CompanionSnapshot.cpp`). **Node:** `validateUnit()` and pinned fixture `test/fixtures/friendly-hwp-sparse-v5.yaml`.

**Excluded from M1 command paths (by design):**

- `commandBinding.player_soldiers` — `isFriendlyRosterSoldier()` / `id < 1_000_000`
- Mandatory tactical equipment review — `buildTacticalEquipmentBrief()` skips non-roster friendlies
- Remote command authority — `isLiveCampaignPlayerSoldierUnit()` requires roster id + geoscape soldier link

**Deferred (post-M1, no command expansion required for sparse shell):** optional richer observation only (e.g. `observedUnitType` / `displayLabel`, `facing` / `kneeled` for awareness) without listing HWPs in binding or AI ownership.

## Visible non-friendly units

Only **`kneeled`** and **`facing`** (same shape as friendly). No health, TU, morale, stun, or inventory.

## Relay

`unitStateBrief` (schemaVersion 1) on the relay envelope lists exceptions (incapacitated, heuristics, `mind_controlled_roster_soldier`, `xcom_controlled_hostile_unit`) and `visibleHostileObservations` (engine-visible **genuine hostile** units only: `originalFaction` and `faction` both hostile, with `facing`). Neutral civilians (`2`/`2`) and mind-controlled roster soldiers stay in full `tactical.units[]` but are **not** listed as generic aliens in `visibleHostileObservations`; use `classifyCurrentHostileObservation()` for LOS vs hostile-target semantics.

AI consumers must read `unitStateBrief.exceptions` on every fresh F6 retrieval before tactical planning — see `lib/tactical-briefing-ai-workflow.cjs`, `lib/hostile-intelligence-consumer.cjs`, and repository `AGENTS.md`. Do not add a second relay summary for the same data.
