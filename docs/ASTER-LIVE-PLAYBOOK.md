# Open X-Com Companion — Live Playbook (M1)

**Audience:** An external agent (e.g. ChatGPT with GitHub connector) acting as a **co-op player**. Engine/Cursor development: [AGENTS.md](../AGENTS.md).

**Authority:** Operator authorization, active tactical session, **engine AI ownership**, and engine validation. This file does not grant control of human-owned soldiers.

---

## Mandatory agent operating procedure

Repeat after every terminal `m0/tactical-result.json`:

| Step | Action |
|------|--------|
| 1 | **Read** `m0/state.json` on the relay branch (operator provides repo + branch). |
| 2 | **Status review** — `unitStateBrief.exceptions` first; psych `perceptionLog` `*_observed` = historical only; fair-play hostiles (§ [Status review](#mandatory-battlefield-status-review)). |
| 3 | **Equipment review** — friendly roster soldiers: `hands`, `inventory`, `groundInventory`, `groundItems` (§ [Equipment](#mandatory-tactical-equipment-review)). |
| 4 | **Authority** — actor ∈ `commandBinding.player_soldiers` **and** `soldierControl` `controlMode: ai` when `availability === "available"` (else operator AI list). No human-owned, MC roster, or off-binding ids (§ [Ownership](#soldier-ownership-ai-vs-human)). |
| 5 | **One active command** — empty inbox; prior result terminal for your `command_id` + `session_id`; fresh four binding fields (§ [One active command](#one-active-command)). |
| 6 | **Plan** — terrain from export only; advisory MOVE exposure before publish (§ [MOVE](#move-publish-verify-replan)). |
| 7 | **Compose** — one of **13** `command_type` values; unique `command_id` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`); no extra JSON keys (§ [Command schema](#command-schema)). |
| 8 | **Publish** `m0/tactical-command.json` only when inbox absent (GitHub connector or operator CLI on PC). |
| 9 | **RETRIEVE** — operator or **AUTO RETRIEVE** (battlescape timer; § [Relay lifecycle](#relay-lifecycle-send-retrieve-daemon)). |
| 10 | **Verify** terminal result; type-specific checks (MOVE / fire / DROP § [Results](#terminal-results)). |
| 11 | **Refresh** binding from post-command `m0/state.json` or operator **SEND (F6)** before the next publish. |

**Operator only:** launcher, in-game AI assign, **SEND**, **RETRIEVE**, **END TURN**. **`END_TURN` is not a supported remote command.**

**First handoff:** relay repo/branch; GitHub access; read `m0/state.json` for `commandBinding`, `soldierControl`, terrain, units; legal shapes in § [Command schema](#command-schema).

---

## Soldier ownership (AI vs human)

| Source | On GitHub? | Role |
|--------|------------|------|
| `commandBinding.player_soldiers` | **Yes** | Binding-eligible soldiers: id, position, kneel, command TU (`timeUnits` or `null` + `timeUnitsApplicability`) — **not** AI/human mode |
| `soldierControl` (on `m0/state.json`) | **Yes** | F6 mirror: `availability`, `soldiers[]`.`controlMode` (`ai` \| `human`). **Authoritative for remote agents** when `availability === "available"` and session/binding checks passed |
| `commandBinding.ownership_note` | **Yes** | Relay cannot **assign** control; prefer `soldierControl` for mode |
| `companion-soldier-control.json` | **No** (local beside snapshot) | Sidecar source mirrored into `soldierControl` |
| Tactical save `companion.assignments` | **No** | In-engine canonical ownership |

**Publish only** for `controlMode: ai`. Human mode → `NOT_AI_CONTROLLED` / `HUMAN_OVERRIDE`.

**When `soldierControl.availability` ≠ `available`:** stop; get operator AI id list. Treat ownership `REJECTED` as mismatch until fixed.

`player_soldiers` with `timeUnits: null` and `timeUnitsApplicability: not_command_applicable` — listed for identity/position only (e.g. unconscious). Use `engineReportedTimeUnits` / `tactical.units` for detail.

---

## GitHub relay layout

| Path | Purpose |
|------|---------|
| `m0/state.json` | Snapshot + `commandBinding`, `soldierControl`, `unitStateBrief`, terrain |
| `m0/tactical-command.json` | Single-command inbox (**absent** = empty) |
| `m0/tactical-result.json` | Latest execution result |
| `m0/terrain-query.json` / `m0/terrain-query-result.json` | Optional bounded geometry query |

Never commit tokens or `relay.local.json`.

**Prerequisites (operator PC):** `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` or remote commands get `EXECUTOR_DISABLED`. Normal launcher (`runtime/m0/Start-CompanionOpenXcom.ps1`) starts Node relay services — no duplicate sidecars during play.

---

<a id="two-relay-lifecycles-daemon-vs-auto-retrieve"></a>

## Relay lifecycle (SEND, RETRIEVE, daemon)

Two **independent** mechanisms — AUTO RETRIEVE does **not** replace the Node daemon.

| | **Node on-demand daemon** | **In-game AUTO RETRIEVE** |
|--|---------------------------|---------------------------|
| Scope | Session until game exit | **Battlescape only** |
| Started by | Companion launcher play session | Operator HUD toggle (default **OFF** each mission; **30s** when ON) |
| Role | GitHub SEND/RETRIEVE **transactions** | Schedules in-engine RETRIEVE only |
| Publishes commands? | **No** | **No** |

**SEND (F6)** → fresh `m0/state.json`. **RETRIEVE** → one command execution per transaction. One command per retrieve; session gates unchanged.

Detail: [f6-relay-lifecycle-m1-25c.md](../m0-publish/docs/f6-relay-lifecycle-m1-25c.md#issue-2-node-daemon-vs-auto-retrieve).

### HUD and relay semantics (UI only)

| Topic | Trust |
|--------|-------|
| **SEND highlight (gold)** | Local unpublished mutations since last confirmed GitHub SEND — not command success |
| **Retrieve labels** | `last_retrieve_*` (latest retrieve attempt) vs `last_command_id` / `last_command_status` (last **engine-terminal** command) vs SEND gold — **three independent facts** |
| **`Order completed`** | Last recorded command status is terminal `COMPLETED` — not “latest retrieve succeeded” |
| **`missionType` / `missionClass`** | `missionType` = battlescape deployment id; `missionClass` = derived category. UFO craft type ≠ terror deployment — do not conflate |
| **Casualty attribution** | `perceptionLog` events do **not** form authoritative killer→victim graph |
| **TU reserve vs reaction** | Reserve affects movement affordability; reaction fire during enemy move uses engine snap/melee rules — reserve does **not** pick aimed/auto reactions |
| **MOVE `reaction_fire`** | Walk stopped because reaction sequence **committed** — not guaranteed hit/kill. Confirm via `perceptionLog` `reaction_attack_executed` on later export |

---

## One active command

Before **every** publish:

1. **`m0/tactical-command.json` absent** — if present → **stop**; do not overwrite.
2. **Prior submission resolved:** `m0/tactical-result.json` shows your last `command_id` with terminal `status`: `COMPLETED`, `FAILED`, `REJECTED`, or `INTERRUPTED`.
3. **`ACCEPTED` / `EXECUTING` are not terminal** — wait; do not publish again.
4. **Ambiguous prior result** (wrong/missing `command_id`, `session_id` mismatch, non-terminal, unsure which finished) → **hard stop**; operator RETRIEVE or clarify.
5. **Fresh binding:** re-read `m0/state.json`; copy `snapshot_sha256`, `session_id`, `turn`, `state_version`. If state did not advance after terminal success, request **SEND (F6)** — never reuse stale binding.

---

## Mandatory battlefield status review

On every fresh `m0/state.json` **before** terrain or orders:

1. `unitStateBrief.exceptions` first.
2. `perceptionLog` psych `*_observed` = historical UI only.
3. **Confirmed:** readiness `panicking`/`berserk`; `mind_controlled_roster_soldier`; `xcom_controlled_hostile_unit`. **Heuristic only:** `low_morale_heuristic`, `low_energy_heuristic` — never call these active panic.
4. **Command actors:** ⊆ `commandBinding.player_soldiers` **and** AI ownership (above). MC roster soldiers are threats, not command actors unless explicitly listed (they are not).
5. **Hostile fair-play:** `tactical.units[]` with **`facing`** = current engine-visible LOS at export. Use `classifyCurrentHostileObservation()` — only `confirmed_current_los` is a genuine alien target. `perceptionLog` / `last_seen` = historical; absent from `units[]` = no live position. Do not merge `perceptionLog` across `sessionId`.

Programmatic mirror: `getAiBriefingInstructionsMarkdown()` in [tactical-briefing-ai-workflow.cjs](../m0-publish/lib/tactical-briefing-ai-workflow.cjs); hostile rules in [hostile-intelligence-consumer.cjs](../m0-publish/lib/hostile-intelligence-consumer.cjs).

---

## Mandatory tactical equipment review

Before terrain / MOVE / shots, inspect `tactical.units` for **every friendly roster soldier** (include human-owned for awareness only):

| Source | Meaning |
|--------|---------|
| `hands` | Equipped / in-hand |
| `inventory` | Belt/backpack |
| `groundInventory` | On actor tile |
| `groundItems` | Map observations of abandoned gear |

Classify grenades, explosives, medikits, firearms, ammo; dedupe `battleItemId` across hands/inventory. Export does not prove command usability — TU, ownership, and engine legality still gate orders.

**Friendly HWPs** (`id >= 1_000_000`): position + faction shell only — not in `player_soldiers`; skip equipment. See [M1-wp2-unit-state-schema.md](../m0-publish/docs/M1-wp2-unit-state-schema.md).

`runMandatoryTacticalEquipmentReview()` / `runMandatoryBriefingPrelude()` in [tactical-equipment-brief.cjs](../m0-publish/lib/tactical-equipment-brief.cjs).

---

## Submitting orders

### GitHub connector (external agent)

1. Steps 1–5 of [operating procedure](#mandatory-agent-operating-procedure).
2. Write `m0/tactical-command.json` when inbox absent.
3. Operator RETRIEVE; poll until terminal result matches `command_id` + `session_id`.

### Local CLI (operator PC only)

`node m0-publish/publish-tactical-command-once.cjs --dry-run|--publish --path <draft>` (from companion repo root).

Prefer `composeMoveCommand`, `composeKneelCommand`, `composeDirectedFireCommand`, etc. in [command-binding.cjs](../m0-publish/lib/command-binding.cjs) — never hand-edit binding fields.

---

## Terminal results

| Status | Terminal? |
|--------|-----------|
| `REJECTED` | Yes |
| `ACCEPTED`, `EXECUTING` | No — wait |
| `COMPLETED`, `INTERRUPTED`, `FAILED` | Yes |

Match `command_id` and `session_id` on every terminal result.

---

## MOVE: publish, verify, replan

### Before publish (advisory)

- **KNOWN THREAT** — `confirmed_current_los` hostiles in `tactical.units[]`.
- **POSSIBLE / UNKNOWN** — open ground, off-LOS approaches, unseen tiles.
- Reaction fire may interrupt walks; no chained publish until terminal. High-risk MOVEs remain valid when strategically justified (**AI-owned only**). Full checklist: `getMoveExposurePolicyMarkdown()` in [move-exposure-policy.cjs](../m0-publish/lib/move-exposure-policy.cjs).

### After terminal MOVE (mandatory)

| Status | Meaning |
|--------|---------|
| `COMPLETED` | Actor on commanded **destination** (x,y,z); prefer `destination_reached: true` |
| `INTERRUPTED` | Partial progress — **`final_position`** is stop tile, not destination |
| `FAILED` | No successful terminal walk |

**Tactical success** requires: terminal `COMPLETED` **and** `final_position` matches command `destination` (including **z**) **and** `destination_reached: true` when present. If `COMPLETED` disagrees with position/flag → not successful — refresh state and replan. **`status` wins** over `destination_reached: true` on `INTERRUPTED`/`FAILED`.

**`movement_stop_reason` (when present):**

| Value | Meaning |
|--------|---------|
| `hostile_spotted` | New hostile contact during walk |
| `reaction_fire` | Reaction **committed** — not guaranteed damage |
| `path_blocked`, `proximity_grenade`, `insufficient_time_units`, `insufficient_energy`, `actor_incapacitated`, `authority_lost` | As labeled |
| `movement_incomplete`, `no_progress` | Partial/generic — `interruption_cause_confirmed` false |
| *(absent)* | Do not invent cause from coordinates alone |

- **Requested** = command `destination`. **Replan anchor** = `final_position` after `INTERRUPTED`/`FAILED`.
- Run `runMandatoryPostCommandPrelude({ result, command })`. When `requires_fresh_binding` → SEND or post-command state before next publish. New `command_id`; do not auto-continue same destination after interrupt.
- Staged MOVEs on ramps/doors/grav lifts: confirm each step’s `final_position` and **z** — do not assume Skyranger deck level.
- `readyForNextCommand` / `mayContinuePriorMovePlan` = safe to **chain same movement plan** only after verified COMPLETED on commanded tile.

Mirror: [move-result-consumer.cjs](../m0-publish/lib/move-result-consumer.cjs).

### Directed fire (`SNAP_SHOT`, `AUTO_SHOT`, `AIMED_SHOT`)

| Status | Meaning |
|--------|---------|
| `REJECTED` | Did not execute |
| `COMPLETED` | At least one projectile launched — **not** confirmed hit/kill (`AUTO_SHOT` may complete after first projectile) |
| `FAILED` | Started but no successful fire completion — may still spend TU |
| `INTERRUPTED` | Stopped short (e.g. authority loss) |

**Line of fire:** preflight `REJECTED` *No line of fire to visible target* vs post-accept `FAILED` `STR_NO_LINE_OF_FIRE`. Ignore `destination_reached` on fire results.

Mirror: [fire-result-consumer.cjs](../m0-publish/lib/fire-result-consumer.cjs).

### DROP

Terminal `COMPLETED` may include `ground_placement`. Confirm scavenge via refreshed snapshot / `lastDropOutcomeBrief.verification_class` — not result status alone.

Mirror: [drop-result-ground-placement.cjs](../m0-publish/lib/drop-result-ground-placement.cjs).

---

## ASCII terrain and maps

### Three presentations (do not mix)

| Kind | Where | Use |
|------|--------|-----|
| **A. Edge-interleaved** | `terrainMapBrief.mapText` | Human crop around focus |
| **B. Tactical composite** | `terrainFullAsciiBattlefield.levels[].channels.tactical` | Walls/floors/doors condensed |
| **C. Diagnostic layers** | `visibility`, `floor`, `edgeNorth`, `edgeWest` | Separate visibility vs structure |

**Coordinates:** `(x,y,z)`. String column = **x**; row index = **y** (`y=0` north/top). `terrainMapBrief.window` = absolute crop bounds.

### Glyphs (`DEFAULT_LEGEND`)

**Visibility:** `?` undiscovered · `:` off-LOS discovered · `.` in LOS.

**Floor:** `?` · `o` open · `x` blocked · `O` UFO interior · `A` air · `:` generic off-LOS · **`G`** grav-lift in LOS · **`g`** grav off-LOS.

**Edges:** ` ` none · `.` no wall · `W` wall · `p` passable · `D`/`d` door · `U` door unknown off-LOS · `:` wall off-LOS · `?` undiscovered.

**Composite-only (B):** `w` wall · `d`/`D`/`U` doors · **`:`** off-LOS (masks floor `g`) · `@` `H` `N` `M` in `tacticalWithUnits`. **Grav:** use floor **C** `G`/`g` or `hints.gravLiftStructures` — not composite `:` alone. Interleaved **A** floor centers use `:` for off-LOS — not `G`/`g`.

### `tacticalMapWindowV2`

24×24 rows (max 32 KiB). `levelSelection.includedLevels` = observational only (`pathfindingGuaranteed: false` on vertical links). Grav column may include three Z when discovered same `(x,y)`. Omitted Z → `m0/terrain-query.json` with `zMin`/`zMax`, `profile: compact`, matching `snapshot_id`. Compact cells use `b.e` for slope. **Craft deck Z is mission-dependent** — confirm via unit `position[2]` and staged MOVE `final_position`, never lore.

### Fair-play

`?` ≠ empty · `o` ≠ guaranteed path · visibility ≠ walkability · no smoke/fire in ASCII export.

Fixture reference: renderer tests in [terrain-tactical-map.cjs](../m0-publish/lib/terrain-tactical-map.cjs).

---

## Tactical interpretation

| Need | Field |
|------|-------|
| Positions, TU | `commandBinding.player_soldiers`, `tactical.units` |
| AI ownership | `soldierControl` or operator |
| Weapon / TU costs | `tactical.units[].actionCosts`, `hands`, `inventory` |
| Item ids | `battleItemId` on snapshot rows — replace all example ids |

`state_version` = `eventLog.latestSeq` at export; advances on **deliberate player weapon fire** only — always pair with **`snapshot_sha256`**. Stale positions after terminal → SEND or post-command binding.

---

## Command schema

**Authoritative parser:** `parseTacticalCommand` in [tactical-command.cjs](../m0-publish/lib/tactical-command.cjs). Engine whitelist: `CompanionCommandRuntime.cpp`.

**Not supported:** `END_TURN`, unknown types, **any extra JSON key**.

### Shared envelope (every command)

Copy **`snapshot_sha256`**, **`session_id`**, **`turn`**, **`state_version`** from current `commandBinding`. Replace live values — placeholder digest below is test-only (`ba7816bf…`).

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

For other types: swap `command_type` / `command_id`, remove `destination` when absent, add fields from the table only — no other keys.

### Parameter reference (13 types)

| `command_type` | Extra fields | Execution |
|----------------|--------------|-----------|
| `MOVE` | `destination`: `{x,y,z}` integers 0–255 | async |
| `KNEEL` | — | sync |
| `STAND` | — | sync |
| `SNAP_SHOT` | `target` `{x,y,z}`, `active_hand`: `STR_LEFT_HAND` \| `STR_RIGHT_HAND` | async |
| `AUTO_SHOT` | same as snap | async |
| `AIMED_SHOT` | same as snap | async |
| `PRIME` | `active_hand`, `fuse_timer` 0–23 | sync |
| `THROW` | `target`, `active_hand` | async |
| `RELOAD` | `weapon_battle_item_id`, `ammo_battle_item_id` (distinct positive ints) | sync |
| `UNLOAD` | `weapon_battle_item_id`, `loaded_ammo_battle_item_id` (distinct) | sync |
| `INVENTORY_MOVE` | `item_battle_item_id`, `source_slot`, `destination_slot`, `destination_x`/`destination_y` 0–255; `source_x`/`source_y` optional **pair** | sync |
| `PICKUP` | `item_battle_item_id`, `ground_position`, `destination_slot`, `destination_x`/`destination_y` | sync |
| `DROP` | `item_battle_item_id`, `source_slot`, optional `source_x`/`source_y` **pair** | sync |

**Carried slots:** `STR_RIGHT_HAND`, `STR_LEFT_HAND`, `STR_BELT`, `STR_BACK_PACK`, `STR_RIGHT_SHOULDER`, `STR_LEFT_SHOULDER`, `STR_RIGHT_LEG`, `STR_LEFT_LEG`. Hands use grid `0,0` for PICKUP destination.

### Worked examples

**KNEEL** / **STAND** / **DROP** / **UNLOAD**: envelope shape with binding fields only plus table columns (no `destination`).

**SNAP_SHOT** (`AUTO_SHOT` / `AIMED_SHOT` / `THROW`: same `target` + `active_hand` pattern):

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

**PRIME** — add `"active_hand": "STR_LEFT_HAND", "fuse_timer": 3`.

**RELOAD:**

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

**INVENTORY_MOVE** — `UNLOAD` follows same id pattern with `loaded_ammo_battle_item_id`; **KNEEL**/**STAND**/**DROP** use envelope only plus table fields.

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

**PICKUP** — add `ground_position`, `destination_slot`, `destination_x`/`destination_y` per table (hands → `0,0`).

---

## Recovery

| Situation | Action |
|-----------|--------|
| Inbox exists | Do not overwrite |
| `ACCEPTED` / `EXECUTING` | Wait |
| Ambiguous / stale result | Hard stop; RETRIEVE or clarify |
| No fresh binding after terminal | **SEND (F6)** |
| `NOT_AI_CONTROLLED` | Fix `soldierControl`; operator re-assigns AI |
| `soldierControl` unavailable | Operator confirms AI ids |
| `relay_export_shrink` | Payload trimmed — do not invent map/events; SEND or `terrain-query` |
| `STALE_*` | SEND; re-read binding |
| Bad / unverified MOVE `COMPLETED` | Refresh; staged ramp/grav MOVE |
| `no_new_orders` | Empty inbox — not failure |
| `EXECUTOR_DISABLED` | Enable executor + launcher stack |

---

## Communication

Concise intent in plain language. Human owns human soldiers and End Turn.

---

## Implementation pointers

| Topic | File |
|-------|------|
| Commands | [tactical-command.cjs](../m0-publish/lib/tactical-command.cjs) |
| MOVE results | [move-result-consumer.cjs](../m0-publish/lib/move-result-consumer.cjs) |
| DROP placement | [drop-result-ground-placement.cjs](../m0-publish/lib/drop-result-ground-placement.cjs) |
| Soldier control | [soldier-control-relay.cjs](../m0-publish/lib/soldier-control-relay.cjs) |
| ASCII | [terrain-tactical-map.cjs](../m0-publish/lib/terrain-tactical-map.cjs) |
| Operator relay setup | [relay-github-setup.md](../m0-publish/docs/relay-github-setup.md) |

Index: [README.md](../README.md).

---

*M1: **13** types in `parseTacticalCommand` (includes `STAND`). Stale scope doc: `M1-battlescape-capability-audit.md` (MOVE/KNEEL/SNAP only).*
