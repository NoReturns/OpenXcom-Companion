# M1-WP7 — Observed projectile direction

**Scope:** `projectile_direction_observed` on bounded `perceptionLog` (schema v4+), engine render-aligned sampling, Node validation, automated fairness tests.

## Player-visible rendering evidence

OpenXcom draws ballistic projectiles only inside `Map::drawTerrain()` when:

1. `_projectileInFOV` — player turn **or** projectile map tile has friendly `Tile::getVisible()` (see `Map::draw()`).
2. Terrain is actually drawn (not the hidden-movement placeholder).
3. Each bullet particle is blitted only when `TileEngine::isVoxelVisible(voxelPos)` passes (same check as sprite draw).

Companion sampling runs **only** on code paths that blit a non-throw projectile voxel (`Map.cpp`, immediately before bullet `blitNShade`). This matches what the player can see, not simulation-only trajectory points.

**Limitation:** Sampling is tied to draw frames, after camera follow logic in the same `drawTerrain()` pass. We do not infer direction from off-screen or hidden-movement frames. Unit-test core additionally models viewport and FOV gates for regression (`shouldAcceptProjectileDirectionSample`).

## Event schema

```yaml
perceptionLog:
  events:
    - seq: 12
      type: projectile_direction_observed
      turn: 2
      perceptionChannel: seen
      confidence: trajectory_observed  # or trajectory_unavailable
      positionKnown: true
      position: [1, 1, 0]              # reference tile (first visible or midpoint)
      travelDirection: northwest
      incomingBearing: southeast
```

- **No** `subjectUnitId` (shooter identity is not inferred).
- **No** audio-only direction (must be `perceptionChannel: seen`).
- Throws and launchers are excluded at observation start.

## Bearing calculation

- Ordered visible **map tile** samples are collected during render-eligible frames.
- With **two or more distinct** tiles: `travelDirection` = compass bearing from first → last sample; `incomingBearing` = opposite bearing (where fire appeared to originate relative to travel).
- With **one** sample: event is emitted with `confidence: trajectory_unavailable` and a reference tile only.
- With **zero** samples: no event (fully invisible projectile).

Uses the same 8-way compass labels as unit facing (`CompanionSnapshotUnitStateCore::directionLabel` / `TileEngine::getDirectionTo` math).

## Fairness policy

| Rule | Enforcement |
|------|-------------|
| No bearing from sound | `perceptionChannel` must be `seen`; Node rejects heard + coordinates |
| No hidden shooter coordinates | No `subjectUnitId`; position is visible segment reference only |
| No hidden segment inference | Direction from observed samples only |
| No merge of independent shots | Dedupe key `projectile_direction_observed:{turn}:{flightId}` per projectile flight |
| No duplicate F6 spam | Session dedupe keys retained until ring eviction |

## Automated verification

- C++: `companion_perception_log_test` (direction math + sample gates)
- Node: `companion-perception-log-m1-wp7.test.cjs`

**Owner live gameplay acceptance remains deferred** (same as WP6).
