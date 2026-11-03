# Packed terrain transport — `packed-v1` (M1-17M)

Lossless binary encoding for schema v5 `terrain`, semantically equivalent to verbose
`terrain.tiles[]` as produced by `CompanionSnapshotTerrain.cpp` and validated by
`tactical-publish.cjs`. Transport only; not an AI briefing by itself.

## YAML envelope (future; not required by Node decoder)

```yaml
terrain:
  memoryNote: "<unchanged>"
  encoding: packed-v1
  recordCount: <u32>
  data: "<strict canonical base64, no line breaks>"
```

Verbose `tiles` and `packed-v1` are mutually exclusive when publish validation is extended.

## Binary blob layout

All multi-byte integers are **little-endian**. No padding between records.

### Header (18 bytes)

| Offset | Size | Field | Rule |
|--------|------|--------|------|
| 0 | 4 | magic | ASCII `OXT1` |
| 4 | 1 | formatVersion | `1` |
| 5 | 1 | flags | **0** (bits1–7 reserved) |
| 6 | 2 | headerReserved | **0** |
| 8 | 2 | mapWidth | u16; must equal root `map.width` |
| 10 | 2 | mapHeight | u16; must equal root `map.height` |
| 12 | 1 | mapDepth | u8; must equal root `map.depth` |
| 13 | 1 | blobReserved | **0** |
| 14 | 4 | recordCount | u32; must equal `terrain.recordCount` |

### Tile record (variable length)

One record per tile with any discovery bit set (`disc` in `1..7`). Order: **z**, then **y**, then **x** (strictly non-decreasing sort key). Duplicate positions are forbidden.

#### Fixed prefix (5 bytes)

| Byte | Field | Rule |
|------|--------|------|
| 0 | x | u8, `0 .. mapWidth-1` |
| 1 | y | u8, `0 .. mapHeight-1` |
| 2 | z | u8, `0 .. mapDepth-1` |
| 3 | disc | u8, bitmask: west=`1`, north=`2`, body=`4` |
| 4 | tileFlags | see below |

**tileFlags**

| Bit | Name | Meaning |
|-----|------|---------|
| 0 | inLos | `1` when `Tile::getVisible() > 0` |
| 1 | westSection | West wall section bytes follow |
| 2 | northSection | North wall section bytes follow |
| 3–7 | — | **Must be 0** |

**Section presence vs discovery**

- Body section is present **iff** `(disc & 4) !== 0` (required whenever body is discovered).
- West section is present **iff** `tileFlags & 2`; when set, `(disc & 1)` **must** be set.
- North section is present **iff** `tileFlags & 4`; when set, `(disc & 2)` **must** be set.
- `(disc & 1)` with west section clear: valid (discovered west edge, no emittable geometry).
- Wall sections must not appear without their discovery bit (reject).

#### Body section (only when `disc & 4`)

**bodyFlags** u8, then optional fields in order:

| Bit | Name |
|-----|------|
| 0 | AIR — void air (`air` + `noFloor`, no elev/walk bytes) |
| 1 | NO_FLOOR — when AIR=0, exported `noFloor` |
| 2 | HAS_WALK_F — u8 `walkF` follows |
| 3 | HAS_WALK_O — u8 `walkO` follows |
| 4 | BLOCK_SIGHT_F — only valid with HAS_WALK_F |
| 5 | BLOCK_SIGHT_O — only valid with HAS_WALK_O |
| 6–7 | **Must be 0** |

After **bodyFlags**:

1. If **AIR=0**: **elev** as **i8** (signed). Valid range **−128..127** (matches MCD `T_Level` as `signed char` in `MapDataSet.cpp`; tile elevation is `min(floor, object)` in `Tile::getTerrainLevel()`).
2. If **HAS_WALK_F**: u8 `walkF` (`0..255`, `255` = impassable).
3. If **HAS_WALK_O**: u8 `walkO`.

**AIR=1:** NO_FLOOR bit must be **1**; no elev/walk bytes.

#### West wall section (only when `tileFlags & 2`)

| Bytes | Field |
|-------|--------|
| 1 | walk u8 |
| 1 | wallFlags: bit0 `blockSight`; bits1–7 **0** |

#### North wall section (only when `tileFlags & 4`)

Same 2-byte layout as west.

### Record size bounds

| Component | Min | Max |
|-----------|-----|-----|
| Prefix | 5 | 5 |
| Body (if `disc&4`) | 1 (air) | 4 (bodyFlags + elev + walkF + walkO) |
| West (if flag) | 2 | 2 |
| North (if flag) | 2 | 2 |
| **Per-record total** | **5** | **13** |

**Maximum blob size:** `18 + recordCount × 13` bytes. Parser must consume the buffer exactly; trailing bytes or truncation reject the blob.

### Elevation encoding

**i8** is lossless for all MCD-authored terrain levels. Values outside **−128..127** cannot appear in valid records (single-byte read); decoder rejects reserved **bodyFlags** / **tileFlags** / header reserved fields rather than truncating.

## Worst-case size projections (heavy 13-byte records)

| Map | Cells (max records) | Raw blob | Base64 `data` (approx.) |
|-----|---------------------|----------|-------------------------|
| 50×50×4 | 10,000 | 130,018 B (~127 KiB) | ~173,360 B |
| 60×60×2 | 7,200 | 93,618 B (~91 KiB) | ~124,824 B |
| 60×60×4 | 14,400 | 187,218 B (~183 KiB) | ~249,624 B |

Add ~10–12 KiB non-terrain v5 YAML for total cap checks against **262,144** bytes UTF-8.

Discovered-tile counts are usually far below grid volume; projections above are **full-grid theoretical maxima**.

## Base64

Decoder accepts only **canonical** RFC 4648 base64: alphabet `A–Z a–z 0–9 + /`, padding `=` only as required, **no** whitespace. SHA-256 binding remains over final YAML UTF-8 bytes (unchanged).

Node publish validation caps `terrain.data` string length at the canonical base64 size of a **worst-case blob for the snapshot map volume** (`base64EncodedLength(18 + width×height×depth×13)`). The overall snapshot must still fit the **262144**-byte UTF-8 input cap.

## Decoded logical shape

Records decode to the same fields as verbose tiles: `p`, `disc`, `inLos`, optional `body`, `west`, `north`. No occupancy, units, smoke, or hidden geometry fields.
