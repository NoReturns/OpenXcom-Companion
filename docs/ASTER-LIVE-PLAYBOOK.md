# Open X-Com Companion — Live Playbook (M1)

**Audience:** An external agent (e.g. ChatGPT with GitHub connector) acting as a **co-op player**. Not for Cursor/engine development — see [AGENTS.md](../../AGENTS.md) for that.

**Authority:** Operator authorization, active tactical session, **engine AI ownership**, and engine validation. This file does not grant control of human-owned soldiers.

---

## NEW AGENT: START HERE

1. **What this is:** Read tactics from a **private GitHub relay**, issue **one** validated remote command per inbox slot, verify `m0/tactical-result.json`, repeat.
2. **Get access:** Operator provides relay **repository** and **branch**; use your **existing GitHub connection** to read/write `m0/*` on that repo.
3. **Read state:** `m0/state.json` on that branch. Copy **`commandBinding`** fields verbatim for every command.
4. **Know the map:** Use `terrainMapBrief` / optional `terrainFullAsciiBattlefield` — not invented tiles. See [ASCII terrain](#ascii-terrain-and-maps).
5. **Pick actors:** `commandBinding.player_soldiers` = player roster **eligible for binding** only. **AI vs human** is **not** on GitHub — operator must confirm which ids are AI-owned before you publish (see [§ Soldier ownership](#soldier-ownership-ai-vs-human)).
6. **Commands:** **13** supported `command_type` values — full JSON in [§ Command examples](#command-examples-valid-json). `END_TURN` is **not** supported.
7. **Publish only when [one active command](#one-active-command) rules pass** — inbox absent, prior order terminal, fresh binding ready.
8. **Execute:** Operator **RETRIEVE** or **AUTO RETRIEVE**. Poll terminal result; read refreshed `m0/state.json` before the next publish.

---

## First-time handoff (operator → agent)

| You need | Source |
|----------|--------|
| Relay repo + branch | Operator message |
| GitHub access to that repo | Your existing connector (operator confirms it is wired) |
| Tactical state + `commandBinding` | `m0/state.json` |
| Which soldier ids are **AI** | **Operator statement** and/or in-game assign UI — **not** in relay JSON today |
| Map + units | Same `m0/state.json` (`terrainMapBrief`, `tactical.units`, etc.) |
| Legal command shapes | This playbook § [Command examples](#command-examples-valid-json) |

After handoff, run the [mandatory status review](#mandatory-battlefield-status-review) on every fresh `m0/state.json`.

---

## Soldier ownership (AI vs human)

| Source | On GitHub? | Role |
|--------|------------|------|
| `commandBinding.player_soldiers` | **Yes** | Live player soldiers at export: id, position, TU, kneel — **not** AI/human mode |
| `commandBinding.ownership_note` | **Yes** | States remote JSON cannot assign AI; owner sets control locally |
| `companion-soldier-control.json` | **No** (local beside snapshot path) | Engine-published mirror of assignments; sidecar/engine use at retrieve time |
| Tactical save `companion.assignments` | **No** (YAML on game PC) | Canonical in-battle ownership |

**For you:** Treat `player_soldiers` as “these ids exist and pass binding,” **not** “safe to command.” Publishing for a human-owned soldier yields engine **`NOT_AI_CONTROLLED`** or **`HUMAN_OVERRIDE`**.

**Trustworthy AI list:** Operator explicitly lists AI soldier ids (and session/battle if ambiguous), re-confirms after reclaim or new mission, and you treat **`REJECTED`** with those codes as a roster/ownership mismatch until they confirm again.

---

## Relay layout (GitHub)

| Path | Purpose |
|------|---------|
| `m0/state.json` | Snapshot + `commandBinding`, `unitStateBrief`, terrain fields |
| `m0/tactical-command.json` | Single-command inbox (absent = empty) |
| `m0/tactical-result.json` | Latest execution result |
| `m0/terrain-query.json` / `m0/terrain-query-result.json` | Optional bounded geometry query |

Never commit tokens or `relay.local.json`.

---

## Operational prerequisites (operator PC)

- **`OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`** — remote commands are **rejected** when the engine executor is off (`EXECUTOR_DISABLED`).
- **Normal launcher** (`runtime/m0/Start-CompanionOpenXcom.ps1` or equivalent) starts the Node relay services — do not start duplicate sidecars during play.

## Division of labour

| Actor | Does |
|-------|------|
| **Operator** | Launcher; in-game AI assign; **SEND** (F6); **RETRIEVE**; **END TURN**; optional AUTO RETRIEVE |
| **Local relay (Node)** | Validates inbox, delivers commands, publishes results (launcher-started) |
| **You** | Read GitHub; publish only under [one active command](#one-active-command); correlate results |

Local-only: `local/m0/tactical-live.yaml`, `companion-soldier-control.json`, sidecar journals.

---

## One active command

Before **every** publish:

1. **`m0/tactical-command.json` must be absent** (empty inbox). If it exists → **stop**; do not overwrite.
2. **Prior submission resolved:** read `m0/tactical-result.json`. If you already published this turn, the file must show your last `command_id` with a **terminal** `status`: `COMPLETED`, `FAILED`, `REJECTED`, or `INTERRUPTED`.
3. **`ACCEPTED` or `EXECUTING` are not terminal** — wait for RETRIEVE / refreshed result; do **not** publish again.
4. **Ambiguous prior result** (wrong/missing `command_id`, mismatched `session_id`, non-terminal status, or unsure which command finished) → **hard stop**; ask operator to RETRIEVE or clarify; do not chain orders.
5. **Fresh binding for the next order:** re-read `m0/state.json` and copy a new `commandBinding` (`snapshot_sha256`, `session_id`, `turn`, `state_version`). If state did not advance after a terminal result, request operator **SEND (F6)** — never reuse stale binding fields because the previous command “looked” successful.

## Operational loop

```
READ m0/state.json → status review → one-active-command checks → publish
→ RETRIEVE → terminal result → fresh state/binding → repeat
```

**Binding (every command):** all four binding fields from **current** `commandBinding` after step 5 above.

---

## Mandatory battlefield status review

1. `unitStateBrief.exceptions` first.
2. `perceptionLog` psych `*_observed` = historical only.
3. Confirmed vs heuristic morale/panic/MC per [AGENTS.md](../../AGENTS.md) / `tactical-briefing-ai-workflow.cjs`.
4. Actors ⊆ `commandBinding.player_soldiers` **and** operator-confirmed AI set.
5. Hostile fair-play: `units[]` + `facing`; `perceptionLog` / `last_seen` not live tracking.

---

## How to submit orders

### GitHub connector (ChatGPT)

1. Read `m0/state.json`; status review; complete [one active command](#one-active-command) checks.
2. Compose command; unique `command_id` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`).
3. `create_file` `m0/tactical-command.json` only when inbox absent.
4. Operator RETRIEVE; poll until **terminal** result matches your `command_id` and `session_id`.

### Local CLI (operator PC only)

`node companion/m0-publish/publish-tactical-command-once.cjs --dry-run|--publish --path <draft>`

---

## Results

| Status | Terminal? |
|--------|-----------|
| `REJECTED` | Yes |
| `ACCEPTED`, `EXECUTING` | No — wait |
| `COMPLETED`, `INTERRUPTED`, `FAILED` | Yes |

Match `command_id` and `session_id`. MOVE may include `final_position`, `remaining_tu`, `destination_reached`.

---

## ASCII terrain and maps

### Three presentations (do not mix semantics)

| Kind | Where | Use |
|------|--------|-----|
| **A. Edge-interleaved** | `terrainMapBrief.mapText` | Human-readable crop around focus soldier; `north_edges` + `floor_row` lines |
| **B. Tactical composite** | `terrainFullAsciiBattlefield.levels[].channels.tactical` (or P0 `layers.tactical`) | Single char per cell: walls/floors/doors condensed |
| **C. Diagnostic layers** | Same object: `visibility`, `floor`, `edgeNorth`, `edgeWest` (+ derived `edgeSouth`/`edgeEast` in P0 view) | Inspect visibility vs structure separately |

**Coordinates:** Cell `(x,y,z)`. String index **x** = column left→right; string row index **y** = row top→bottom (`y=0` is north/top). `terrainMapBrief.window` gives crop `x0..x1`, `y0..y1` absolute.

### Glyphs on diagnostic layers (`DEFAULT_LEGEND`)

**Visibility:** `?` undiscovered · `:` off-LOS discovered · `.` in LOS.

**Floor (only layer that encodes grav-lift floors):** `?` undiscovered · `o` open · `x` blocked · `O` UFO interior · `A` air · `:` generic off-LOS floor (non-grav) · **`G`** grav-lift in current LOS · **`g`** grav-lift discovered off-LOS (`floorGlyph` / `structureMeta.floorGravLift`).

**edgeNorth / edgeWest:** ` ` none · `.` no wall emitted · `W` impassable wall · `p` passable structural edge · `D`/`d` door closed/open (in LOS) · `U` door off-LOS state unknown · `:` off-LOS wall · `?` undiscovered.

### Tactical composite-only glyphs (`tacticalCellGlyph`)

These appear in **B** (`tactical`, `tacticalWithUnits`), not as separate legend keys in `DEFAULT_LEGEND`:

| Glyph | Meaning |
|-------|---------|
| **`w`** | Impassable wall on a cardinal edge of this cell (composite from edge `W`) |
| **`d` / `D`** | Open / closed door priority over floor |
| **`U`** | Door off-LOS unknown |
| **`o`, `x`, `A`, `:`, `?`** | Composite rules — see grav note below |
| **`G`** | In-LOS grav-lift floor (when not masked by doors/walls) |
| **`:`** | Off-LOS discovered cell — **replaces floor `g`** (and most non-wall floors) because `tacticalCellGlyph` returns `:` when visibility is off-LOS |
| **`@` `H` `N` `M`** | Unit overlay in `tacticalWithUnits` only |

**Floor layer `.`:** On **C** floor channel only — discovered body, in LOS, no floor body glyph (`floorGlyph`).

### Renderer fixture: 3×2 map, z=0 (from `terrain-tactical-map` tests)

Discovered tiles at `(0,0)…(1,1)`; `(x=2)` undiscovered; unit id **1** at **`(1,1,0)`**; north wall on `(0,0)`; west wall on `(1,0)`.

**C — visibility** (row `y`):

```
y0: ..?
y1: ..?
```

**C — floor:**

```
y0: oo?
y1: oo?
```

**C — edgeNorth / edgeWest:**

```
y0 edgeNorth: W.?
y0 edgeWest:  .W?
```

**B — tactical composite:**

```
y0: ww?
y1: oo?
```

**B — tacticalWithUnits:**

```
y0: ww?
y1: o@?    ← '@' at (1,1)
```

**A — interleaved rows** (`terrainMapBrief` style):

```
n  y0  ---   ???
    y0   o |o ??  
n  y1        ???
    y1   o  @ ??  
```

Read **`o |o`**: open cell `(0,0)`, wall between, open `(1,0)`. **`@`** at `(1,1)`.

### Two-level grav-lift fixture (renderer-generated)

4×4×2; grav floor at **`(1,1,0)`** in LOS (`G`), same `(x,y)` on **z=1** off LOS (`g`); ordinary floors elsewhere.

**Floor channel z=0** (row strings): positions align with map width 4; grav at index x=1, y=1:

```
???? 
?Go? 
????
????
```

**C — floor z=1** (same cell `(1,1)` is **`g`** on the floor channel):

```
???? 
?g?? 
????
????
```

**B — tactical z=0** at `(1,1)`: **`G`** (in LOS). **B — tactical z=1** at `(1,1)`: **`:`** — not `g` (off-LOS visibility wins in `tacticalCellGlyph`).

**A — edge-interleaved** floor cells use `interleavedFloorCenter`: off-LOS centers render as **`:`** (or `o`/`x`/`A`/`?`), **not** `G`/`g` — use **C floor** or hints for grav identity.

**Vertical links:** `terrainFullAsciiBattlefield.hints.gravLiftStructures` (when present) + **C floor** `G`/`g` on each level — do not read grav from tactical **`:`** alone or from interleaved floor rows.

### Fair-play (movement vs map)

- `?` ≠ empty. `o` ≠ guaranteed MOVE path. Visibility ≠ walkability. `w` in composite ≠ full edge diagnostics — use **C** when ambiguious.
- Off-LOS `U` doors: state unknown. No smoke/fire/damage in ASCII export.

Optional: `m0/terrain-query.json` with `snapshot_id`, `center`, `radius` or `rectangle`.

---

## Tactical interpretation

| Need | Relay field |
|------|-------------|
| Roster positions, TU | `commandBinding.player_soldiers`, `tactical.units` |
| AI ownership | **Operator** + local control file — not relay |
| Weapon / TU costs | `tactical.units[].actionCosts`, `hands`, `inventory` |
| Item ids for reload/inventory | `battleItemId` on snapshot rows — replace example ids |

---

## In-game relay

**SEND (F6)** → fresh `m0/state.json`. **RETRIEVE** → one command execution. **AUTO RETRIEVE** default **30s** when enabled. One command per retrieve transaction.

---

## Command inventory (13 types)

Authoritative: `parseTacticalCommand` in `companion/m0-publish/lib/tactical-command.cjs` and engine whitelist in `CompanionCommandRuntime.cpp`.

| # | `command_type` | Notes |
|---|----------------|--------|
| 1 | `MOVE` | async |
| 2 | `KNEEL` | sync |
| 3 | `STAND` | sync |
| 4 | `SNAP_SHOT` | async |
| 5 | `AUTO_SHOT` | async |
| 6 | `AIMED_SHOT` | async |
| 7 | `PRIME` | sync; `fuse_timer` 0–23 |
| 8 | `THROW` | async |
| 9 | `RELOAD` | sync |
| 10 | `UNLOAD` | sync |
| 11 | `INVENTORY_MOVE` | engine-heavy legality |
| 12 | `PICKUP` | sync |
| 13 | `DROP` | sync |

Not supported: `END_TURN`, unknown `command_type` strings, extra JSON keys on any command.

---

## Command examples (valid JSON)

**Replace on every live order:**

| Field | Source |
|-------|--------|
| `snapshot_sha256`, `session_id`, `turn`, `state_version` | Current `commandBinding` |
| `actor_unit_id` | Listed in `player_soldiers` **and** operator AI list |
| `destination` / `target` / `ground_position` | Legal coords within `commandBinding.map` + fair play |
| `*_battle_item_id` | Matching `battleItemId` on actor snapshot rows |

Examples below use **dummy** binding hashes and **parse-valid** shapes (`JSON.parse` + `parseTacticalCommand` verified). **`ba7816bf…`** is a test digest, not your live SHA.

### Shared binding fields (copy from live `commandBinding`)

| Field | Format | Example placeholder in § below |
|-------|--------|--------------------------------|
| `snapshot_sha256` | 64 lowercase hex | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| `session_id` | 32 lowercase hex | `a1b2c3d4e5f6789012345678abcdef01` |
| `turn` | integer ≥ 1 | `1` |
| `state_version` | integer ≥ 0 (= `eventLog.latestSeq` at export) | `7` |

Replace placeholders with the **current** export; the example digest is for parser shape only.

### 1. MOVE

```json
{
  "schema_version": 1,
  "command_id": "move-example-001",
  "command_type": "MOVE",
  "actor_unit_id": 1,
  "destination": { "x": 2, "y": 3, "z": 0 },
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 2. KNEEL

```json
{
  "schema_version": 1,
  "command_id": "kneel-example-001",
  "command_type": "KNEEL",
  "actor_unit_id": 1,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 3. STAND

```json
{
  "schema_version": 1,
  "command_id": "stand-example-001",
  "command_type": "STAND",
  "actor_unit_id": 1,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 4. SNAP_SHOT

```json
{
  "schema_version": 1,
  "command_id": "snap-example-001",
  "command_type": "SNAP_SHOT",
  "actor_unit_id": 1,
  "active_hand": "STR_RIGHT_HAND",
  "target": { "x": 4, "y": 4, "z": 0 },
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 5. AUTO_SHOT

```json
{
  "schema_version": 1,
  "command_id": "auto-example-001",
  "command_type": "AUTO_SHOT",
  "actor_unit_id": 1,
  "active_hand": "STR_RIGHT_HAND",
  "target": { "x": 4, "y": 4, "z": 0 },
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 6. AIMED_SHOT

```json
{
  "schema_version": 1,
  "command_id": "aimed-example-001",
  "command_type": "AIMED_SHOT",
  "actor_unit_id": 1,
  "active_hand": "STR_RIGHT_HAND",
  "target": { "x": 4, "y": 4, "z": 0 },
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 7. PRIME

```json
{
  "schema_version": 1,
  "command_id": "prime-example-001",
  "command_type": "PRIME",
  "actor_unit_id": 1,
  "active_hand": "STR_LEFT_HAND",
  "fuse_timer": 3,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 8. THROW

```json
{
  "schema_version": 1,
  "command_id": "throw-example-001",
  "command_type": "THROW",
  "actor_unit_id": 1,
  "active_hand": "STR_LEFT_HAND",
  "target": { "x": 5, "y": 5, "z": 0 },
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 9. RELOAD

```json
{
  "schema_version": 1,
  "command_id": "reload-example-001",
  "command_type": "RELOAD",
  "actor_unit_id": 1,
  "weapon_battle_item_id": 100,
  "ammo_battle_item_id": 102,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 10. UNLOAD

```json
{
  "schema_version": 1,
  "command_id": "unload-example-001",
  "command_type": "UNLOAD",
  "actor_unit_id": 1,
  "weapon_battle_item_id": 100,
  "loaded_ammo_battle_item_id": 101,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 11. INVENTORY_MOVE

```json
{
  "schema_version": 1,
  "command_id": "inv-move-example-001",
  "command_type": "INVENTORY_MOVE",
  "actor_unit_id": 1,
  "item_battle_item_id": 300,
  "source_slot": "STR_BELT",
  "destination_slot": "STR_RIGHT_HAND",
  "destination_x": 0,
  "destination_y": 0,
  "source_x": 0,
  "source_y": 0,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 12. PICKUP

```json
{
  "schema_version": 1,
  "command_id": "pickup-example-001",
  "command_type": "PICKUP",
  "actor_unit_id": 1,
  "item_battle_item_id": 900,
  "ground_position": { "x": 1, "y": 1, "z": 0 },
  "destination_slot": "STR_RIGHT_HAND",
  "destination_x": 0,
  "destination_y": 0,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

### 13. DROP

```json
{
  "schema_version": 1,
  "command_id": "drop-example-001",
  "command_type": "DROP",
  "actor_unit_id": 1,
  "item_battle_item_id": 300,
  "source_slot": "STR_BELT",
  "source_x": 0,
  "source_y": 0,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

**Carried slots:** `STR_RIGHT_HAND`, `STR_LEFT_HAND`, `STR_BELT`, `STR_BACK_PACK`, `STR_RIGHT_SHOULDER`, `STR_LEFT_SHOULDER`, `STR_RIGHT_LEG`, `STR_LEFT_LEG`. Hands use grid `0,0` for PICKUP destination.

---

## Recovery

| Situation | Action |
|-----------|--------|
| Inbox exists | Do not overwrite ([one active command](#one-active-command)) |
| Prior result `ACCEPTED` / `EXECUTING` | Wait — not terminal |
| Ambiguous / stale result | Hard stop; operator RETRIEVE or clarify |
| No fresh `commandBinding` after terminal | Request **SEND (F6)** |
| `NOT_AI_CONTROLLED` | Operator confirms AI ids / re-assigns |
| `STALE_*` | Operator SEND; re-read binding |
| `INTERRUPTED` MOVE | Use `final_position`; replan |
| `no_new_orders` | Inbox empty — not failure |
| `EXECUTOR_DISABLED` | Operator enables executor + launcher stack |

---

## Communication

Concise intent in plain language. Human owns human soldiers and End Turn.

---

## Implementation pointers

| Topic | File |
|-------|------|
| Commands | `m0-publish/lib/tactical-command.cjs` |
| ASCII | `m0-publish/lib/terrain-tactical-map.cjs` |
| Operator relay setup (not agent onboarding) | `m0-publish/docs/relay-github-setup.md` |

Companion repo index: [README.md](../README.md) → this playbook.

---

*M1 pipeline: **13** command types in `parseTacticalCommand` (includes STAND). Stale: `M1-battlescape-capability-audit.md` (MOVE/KNEEL/SNAP only).*
