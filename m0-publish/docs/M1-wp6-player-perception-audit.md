# M1-WP6 — Player-perceivable event intelligence

**Date:** 2026-11-05  
**Scope:** Bounded `perceptionLog` on tactical snapshots (schema v4+), engine hooks, Node validation, automated fairness tests.

## Verified engine perception sources

| Player cue | Engine source | Companion hook |
|------------|---------------|----------------|
| Gunfire audio | `ProjectileFlyBState::createNewProjectile` fire `Sound::play` | `tryRecordGunfireObserved` after shot created |
| Bullet / hit impact | `ExplosionBState::init` (non-area hit branch) | `tryRecordImpactObserved` |
| Explosion audio / visible blast | `ExplosionBState::init` (area branch) | `tryRecordExplosionObservedOrHeard` |
| Door open audio | `UnitWalkBState`, `UnitTurnBState` door sounds | `tryRecordDoorSoundHeard` |
| Hostile briefly visible | `TileEngine::calculateFOV`, reaction visibility | `noteHostileVisibility` |
| Hostile lost at turn boundary | `SavedBattleGame` pre-FOV hide | `recordHostileLastSeenBeforeTurnReset` |

**Not used for bearing:** `Map::getSoundAngle` — stereo pan from camera, not a map compass bearing. Compass labels are computed only when a friendly observer has LOS to a **known** tile (`TileEngine::getDirectionTo`).

**Existing command log unchanged:** `eventLog` still records deliberate player `weapon_fired` only; `state_version` remains `eventLog.latestSeq`.

## Implemented event types

| type | When emitted | Coordinates |
|------|----------------|-------------|
| `gunfire_observed` | Projectile fire sound | Only if shooter visible or origin tile in friendly LOS |
| `impact_observed` | Non-area hit explosion state | Only if impact tile in friendly LOS |
| `explosion_observed_or_heard` | Area explosion state | Tile center when in LOS; else audio-only |
| `door_sound_heard` | Door open sound | In LOS: `seen_and_heard` + tile; off-screen: `heard` only (Node rejects `heard` + coordinates) |
| `unit_last_seen` | Hostile first sighted or turn-end memory | Last observed tile (not subsequent hidden movement) |

## Example YAML fragment

```yaml
perceptionLog:
  sessionId: a1b2c3d4e5f6789012345678abcdef01
  oldestSeq: 1
  latestSeq: 2
  droppedCount: 0
  events:
    - seq: 1
      type: gunfire_observed
      turn: 2
      perceptionChannel: heard
      confidence: audio_only
      positionKnown: false
    - seq: 2
      type: unit_last_seen
      turn: 2
      perceptionChannel: seen
      confidence: sighted
      positionKnown: true
      position: [12, 8, 0]
      subjectUnitId: 1000001
      observerUnitId: 3
      compassDirection: northeast
```

## Unsupported (documented)

| Proposed cue | Reason |
|--------------|--------|
| Projectile trajectory polyline | Simulation knows path; UI does not expose full trajectory (WP7 adds **direction-only** `projectile_direction_observed`, not polylines) |
| Unidentified sound → alien type | No engine UI mapping |
| Hidden shooter map coordinates from pan | `getSoundAngle` is speaker balance, not tactical bearing |
| Enemy destination after leaving LOS | Only last-seen tile at observation time |
| Footsteps / ambient movement | Not tied to fair visibility gates in export policy |
| UFO layout / inventory / medikit | Out of WP6 scope |

## Fairness validation (automated)

- `companion_perception_log_test` — hidden gunfire omits coordinates; audio-only spatial; visibility transitions; RNG untouched
- `companion-perception-log-m1-wp6.test.cjs` — schema rejects coordinate leak on `heard`; compass requires `positionKnown`
- Existing WP1–WP5 command / event / relay tests unchanged (`state_version` still event-log-only)

## Snapshot integration

- Separate bounded `perceptionLog` (256 events) with same session id as `eventLog`
- Exported on all v4/v5 snapshots; optional in Node parser for backward compatibility
- 256 KiB cap / v4 terrain fallback unchanged

## Remaining live acceptance

- Owner gameplay confirmation during alien turn → F6 (events survive turn transition)
- Stereo-only gunfire vs visible shooter cases in real missions
- No production mutation required for automated sign-off

## Completion verdict

**WP6 complete for automated verification** — engine perception hooks, snapshot export, Node validation, and fairness tests implemented. **Owner live gameplay acceptance remains deferred.**
