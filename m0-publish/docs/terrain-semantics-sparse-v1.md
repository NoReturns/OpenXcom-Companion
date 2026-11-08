# Terrain semantics transport — `sparse-v1` (M1-WP1)

Compact sidecar for MapData-derived categories on **discovered** tile parts only.
Pairs with `packed-v1` geometry or verbose `terrain.tiles[]`.

## YAML envelope

```yaml
terrain:
  semantics:
    encoding: sparse-v1
    recordCount: <u32>
    data: "<canonical base64>"
```

Optional on v5 `terrain`. Omitted when no classified parts are present.

## Category ids (uint8)

| Id | Name |
|----|------|
| 0 | UNKNOWN (never emitted) |
| 1 | ORDINARY |
| 2 | ORDINARY_IMPASSABLE |
| 3 | UFO_STRUCTURE |
| 4 | UFO_INTERIOR |
| 5 | UFO_DOOR |
| 6 | ORDINARY_DOOR |
| 7 | ENTRANCE |
| 8 | GRAV_LIFT |
| 9 | XCOM_CRAFT |
| 10 | XCOM_BASE_MODULE |

## Binary blob

Magic `OXTS`, format version `1`, 3 reserved bytes, `recordCount` u32 LE, then records sorted **z, y, x**.

Each record: `x, y, z, partFlags`, then one byte per set bit in `partFlags`:

- bit0 body
- bit1 west
- bit2 north

Max record length 7 bytes. Parser must consume the buffer exactly.

## Fairness

Semantics are captured only for discovered parts, using the same live `Tile` state as geometry.
Off-LOS categories follow `terrain.memoryNote` (live engine state, not historical memory).
