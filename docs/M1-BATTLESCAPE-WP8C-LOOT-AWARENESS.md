# M1 Battlescape WP8C — Battlefield loot awareness (read-only)

**Date:** 2026-11-06  
**Scope:** Fair-play **memory** of **player-legitimate** ground observations and **conservative** cues when a hostile dies in sight — **informational only**. **No** change to **`PICKUP`/`DROP`** authority; **no** map-wide hidden inventory. **No** remote pickup.

## 1. Relationship to WP8B4 (`groundInventory`)

- **`units[].groundInventory`** remains the **only** snapshot source for **actionable** **`PICKUP`** targets (actor tile, exact `battleItemId`).
- **`groundItems`** and **`perceptionLog`** entries described here are **hints** for planning and discussion. They **must not** be used to build **`PICKUP`** JSON without a **fresh** F6 export showing the item on **`actor.groundInventory`**.

## 2. Snapshot: `groundItems` (session memory)

Engine export root field **`groundItems`** (schema v4+):

| Field | Role |
|-------|------|
| `schemaVersion` | **`1`** |
| `sessionId` | Same family as `eventLog.sessionId` (synced at export). |
| `memoryNote` | Fixed reminder: off-LOS replays last **in-LOS** observation; undiscovered / hidden tiles are not scanned. |
| `droppedCount` | Observations evicted when the **per-session cap** is exceeded (deterministic order). |
| `observations[]` | Tile-oriented cues. |

Each observation:

| Field | Values / rules |
|-------|----------------|
| `position` | `{ x, y, z }` |
| `observationStatus` | **`CONFIRMED_IN_LOS`** — tile currently has `Tile::getVisible() > 0` and passes export filters. **`REMEMBERED_OFF_LOS`** — last remembered snapshot from when the tile was in LOS; **not** a claim about current engine ground state. |
| `items[]` | Bounded per tile; at most one “primary” row may expose `itemType` when research allows; other stack rows use `additional_ground_item` / `concealedOnTile` so UI sprite stacking does not leak hidden identities. |

**Fair-play inputs**

- **Body discovered** (`tile->isDiscovered(2)`) — do not emit for undiscovered areas.
- **Line of sight** — `tile->getVisible() > 0` means **at least one player-faction unit currently sees the tile** (engine convention for this export path). Memory refresh only runs for tiles that pass discovery + LOS when updating `_remembered`.

**Cap:** **64** observations per tactical session (sorted by `(z, y, x)`); overflow increments `droppedCount` and drops **highest-address** tiles first (deterministic).

**Save/load:** `CompanionGroundItemMemory` is **not** serialized in vanilla saves; restoring a tactical save **clears** ground-item memory (same session as other non-persisted Companion logs). A **new** F6 in the continued mission rebuilds memory from ongoing play.

## 3. Perception: `hostile_casualty_tile_observed`

When a **hostile** unit **finishes dying** (`UnitDieBState` path, not debug / pre-battle), the engine may append a **`perceptionLog`** event:

| Field | Value |
|-------|--------|
| `type` | **`hostile_casualty_tile_observed`** |
| `perceptionChannel` | **`seen`** (or **`seen_and_heard`** if combined with audible channel in resolver) |
| `confidence` | **`possible_ground_equipment`** — unit had a carried inventory (`hasInventory()` was true), so drops **may** follow vanilla rules. **`alien_casualty_tile`** — no carried inventory at death (e.g. fixed gear / no drops); **does not** promise loot. |
| `positionKnown` | **`true`** only if **`resolveSpatialObservation`** reports the death tile visible to a live player soldier (same helper family as other WP6 events). |
| `position` | Death tile `{ x, y, z }` when `positionKnown`. |

**Explicitly omitted:** `subjectUnitId` — avoids tying the cue to hidden alien identity in exports.

**Not a substitute for `groundItems`:** If drops exist **and** the tile remains in player LOS, **`groundItems`** lists categorized rows; the perception event only marks **that tile had a visible hostile casualty** and a **possible** equipment interest.

## 4. Concepts kept separate

| Concept | Mechanism |
|---------|-----------|
| Terrain **discovered** | `terrain` / tile discovery flags — “we have mapped this” ≠ “we see it now.” |
| **Current LOS** to a tile | `Tile::getVisible()` for ground export; perception spatial helpers for events. |
| **Authoritative ground on actor tile** | **`units[].groundInventory`** |
| **Historical / off-LOS memory** | **`groundItems`** with `REMEMBERED_OFF_LOS`, **`perceptionLog`** |

## 5. Mind control / hostile faction

Recording uses **player-legitimate** visibility (friendly observers, not MC-alien vision). No bypass of fair-play rules from hostile-controlled perception.

## 6. Deferred / unsupported

- **ENGINE VERIFIED (this milestone):** Unit tests cover **`tryRecordHostileDeathObserved`** and Node validates the new perception type.
- **LIVE VERIFIED:** Not run (operator away). Full battlescape UI parity (sprites vs. data) is deferred.
- **No** automatic inference that a specific weapon type exists from death alone — only **`possible_ground_equipment`** when inventory existed.
