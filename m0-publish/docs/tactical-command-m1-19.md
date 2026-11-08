# Tactical MOVE command and terrain query (M1-19)

## Relay files (separate from M0 ping)

| File | Direction | Purpose |
|------|-----------|---------|
| `m0/command.json` | In | **Unchanged** — ping proof only (`schema_version: 1`, `action: ping`, 3 keys). |
| `m0/result.json` | Out | **Unchanged** — ping worker results. |
| `m0/tactical-command.json` | In | Authorized MOVE commands (`schema_version: 1`). |
| `m0/tactical-result.json` | Out | Command lifecycle (`ACCEPTED` → `EXECUTING` → terminal). |
| `m0/terrain-query.json` | In | Bounded terrain query request. |
| `m0/terrain-query-result.json` | Out | Query response from validated snapshot. |

## MOVE command (`m0/tactical-command.json`)

```json
{
  "schema_version": 1,
  "command_id": "move-2026-001",
  "command_type": "MOVE",
  "actor_unit_id": 1,
  "destination": { "x": 12, "y": 8, "z": 0 },
  "snapshot_sha256": "<64 hex sha256 of on-disk tactical YAML bytes>",
  "session_id": "<32 hex battle session id>",
  "turn": 1,
  "state_version": 1
}
```

`destination` must be a JSON **object** with integer fields `x`, `y`, and `z`. Do **not** use a three-element array (e.g. `[45, 37, 0]`); the sidecar and engine both reject that shape.

`state_version` must equal `eventLog.latestSeq` from the same tactical export as `snapshot_sha256`.

Engine validates `snapshot_sha256` against the last exported tactical YAML (same binding as F6 briefing). Sidecar validates against loaded snapshot bytes and `eventLog.sessionId`.

Relay publishers attach **`commandBinding`** to `m0/state.json` (outside hashed `tactical` JSON used for `snapshot_id`) with verified `snapshot_sha256`, `state_version` (`eventLog.latestSeq`), `session_id`, `turn`, map bounds, and player soldier ids/positions for remote MOVE authoring.

## Result lifecycle

Statuses: `REJECTED`, `ACCEPTED`, `EXECUTING`, `COMPLETED`, `INTERRUPTED`, `FAILED`.

Terminal payloads may include: `final_position`, `remaining_tu`, `kneeled`, `destination_reached`, `public_reason`, `snapshot_sha256` (post-move export when available).

**COMPLETED** MOVE: actor on commanded destination (x,y,z); `destination_reached` should be **true**. **INTERRUPTED** / **FAILED**: use `final_position` for replan. Agent verification: `move-result-consumer.cjs` and `ASTER-LIVE-PLAYBOOK.md` (MOVE mandatory verification).

## Soldier ownership (local only)

File beside tactical snapshot: `companion-soldier-control.json`

```json
{
  "schema_version": 1,
  "session_id": "<must match battle session>",
  "assignments": {
    "1": "ai",
    "2": "human"
  }
}
```

Default: **human** for all soldiers. Remote commands cannot assign AI control. Revoke by setting `"human"`.

## Engine executor gate

MOVE execution is **disabled** unless environment variable `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` is set (owner live test only).

Requires `OPENXCOM_COMPANION_SNAPSHOT_PATH` (same as F6 briefing).

## ChatGPT / AI access path

1. Human publishes tactical snapshot + briefing via existing F6 → sidecar → relay pipeline.
2. AI reads relay tactical payload (`snapshot_id`, terrain, units).
3. AI writes `m0/terrain-query.json`; sidecar worker validates `snapshot_id`, runs `executeTerrainQuery`, publishes `m0/terrain-query-result.json` (same pattern as briefing watcher — **no new web server**).
4. Human assigns soldier to AI in local `companion-soldier-control.json`.
5. AI writes `m0/tactical-command.json`; engine (when executor enabled) consumes local copy under snapshot directory **`tactical-command.json`**, writes **`tactical-result.json`**.

Local engine files mirror relay names under the snapshot directory (`local/m0/`).

## Terrain query request

```json
{
  "snapshot_id": "<computeSnapshotId hex>",
  "center": { "x": 10, "y": 10, "z": 0 },
  "radius": 8,
  "zMin": 0,
  "zMax": 1
}
```

Or `rectangle` instead of `radius`. Max radius 12; max response 8 KiB.
