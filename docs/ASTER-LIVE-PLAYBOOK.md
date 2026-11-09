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

## Two relay lifecycles (daemon vs AUTO RETRIEVE)

M1 uses **two independent mechanisms**. Do not treat AUTO RETRIEVE as a replacement for the launcher-started Node daemon.

| | **Node on-demand daemon** (`companion-on-demand-relay-daemon.cjs`) | **In-game AUTO RETRIEVE** (battlescape HUD) |
|--|---------------------------------------------------------------------|---------------------------------------------|
| Scope | **Launcher / game session** — survives Geoscape and mission transitions until game exit | **Battlescape only** — inactive on Geoscape |
| Started by | `Start-CompanionOpenXcom.ps1` play session + daemon startup | Operator toggles in mission |
| Default | Running while the canonical game session is active (stops on play-session shutdown) | **OFF** at each battlescape entry; interval **30s** when enabled |
| Role | Polls local on-demand request; runs GitHub SEND/RETRIEVE **transactions** when the engine enqueues them | Schedules **in-engine RETRIEVE** attempts on a timer when ON |
| Publishes commands? | **No** — agents publish `m0/tactical-command.json`; daemon delivers inbox + publishes results | **No** — only triggers RETRIEVE; still one command per transaction |
| Requires | Game process + play-session lease | Running relay daemon **and** battlescape UI |

Session command gates (`one active command`, stale binding archive on F6, quarantine on launch) are unchanged. P0 **test-supervisor** daemon lifecycle fixes apply to **Node test harnesses** only, not production AUTO RETRIEVE behavior.

Detail: [f6-relay-lifecycle-m1-25c.md](../m0-publish/docs/f6-relay-lifecycle-m1-25c.md#issue-2-node-daemon-vs-auto-retrieve).

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
READ m0/state.json → status review → equipment review → one-active-command checks → publish
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

## Mandatory tactical equipment review

**Before terrain planning or MOVE/shot proposals**, inspect `tactical.units` for every friendly roster soldier (including **human-owned** for awareness):

| Source | Meaning |
|--------|---------|
| `hands` | Equipped / in-hand (weapons, held grenades, primed explosives) |
| `inventory` | Belt/backpack |
| `groundInventory` | Items on the actor’s tile (not personal carry) |
| `groundItems` | Map observations of abandoned gear (separate counts) |

Note grenades (standard, smoke, proximity), high explosives, medikit charges, loaded weapons vs spare ammo, primed vs unprimed. **Do not assume usability** from export alone — TU, ownership, and command support still gate orders. Human-owned soldiers are **not** Companion command actors even when listed in binding.

**Friendly HWPs** (`tactical.units[]` with `id >= 1_000_000`): M1 exports **position + faction shell only** — no hands/inventory. They are **not** in `commandBinding.player_soldiers`; skip them in equipment review. See `m0-publish/docs/M1-wp2-unit-state-schema.md`.

Programmatic mirror: `runMandatoryTacticalEquipmentReview()` / `runMandatoryBriefingPrelude()` in `companion/m0-publish/lib/tactical-briefing-ai-workflow.cjs` (derived from existing snapshot data only).

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

Match `command_id` and `session_id` on every terminal result.

### MOVE — mandatory verification (before the next order)

Engine contract (authoritative):

| Status | Meaning |
|--------|---------|
| `COMPLETED` | Walk finished with the actor on the **commanded destination** tile: same **x, y, z** as the MOVE `destination`. Payload should include `destination_reached: true` and `final_position` equal to that destination. |
| `INTERRUPTED` | Partial progress, reaction fire, hostile spot, TU stop, or authority loss. **`final_position` is the stop tile** — not the destination. |
| `FAILED` | No successful terminal walk (e.g. stuck at start, actor down). May still include `final_position`. |

**Tactical success** for a MOVE is **not** `status == COMPLETED` alone. Require all of:

1. `status` is `COMPLETED`
2. `final_position` matches the published command `destination` (including **z**)
3. `destination_reached` is `true` when the field is present (legacy results without it: trust matching `final_position` only)

If `COMPLETED` disagrees with `final_position` or `destination_reached`, treat the move as **not** successful, read refreshed `m0/state.json` (or request **SEND**), and replan.

`FAILED` or `INTERRUPTED` with `destination_reached: true` can occur — **`status` wins**; do not treat the move as successful.

Optional MOVE fields: `starting_position`, `remaining_tu`, `kneeled`, `movement_stop_reason`, `public_reason`, `snapshot_sha256` (post-move export when available).

**Relay presentation (derived):** Sidecar notifications and `lastMoveOutcomeBrief` may add `terminal_message`, `move_interruption_cause`, and position summaries. These are **presentation only** — `m0/tactical-result.json` stays authoritative.

#### `movement_stop_reason` (engine-confirmed when present)

| Value | Meaning |
|--------|---------|
| `hostile_spotted` | Walk halted because a new hostile contact was recorded during movement. |
| `reaction_fire` | Walk halted because reaction-fire **sequence** started — **not** confirmed hit, damage, or kill. |
| `path_blocked` | Next step blocked (unit/door/obstruction). |
| `proximity_grenade` | Proximity grenade triggered during movement. |
| `insufficient_time_units` / `insufficient_energy` | TU or stamina exhausted during the walk. |
| `actor_incapacitated` | Actor down or removed from play. |
| `authority_lost` | Soldier no longer AI-controlled. |
| `movement_incomplete` | Partial progress without a more specific engine token. |
| `no_progress` | Failed without advancing. |
| *(absent on INTERRUPTED/FAILED)* | **Cause not confirmed** — do not invent hostile sighting or reaction damage from coordinates alone. |

**Presentation:** `movement_incomplete` / `no_progress` may appear in operator messages with their engine labels, but `interruption_cause_confirmed` is **false** — generic outcomes, not confirmed tactical events (unlike `hostile_spotted`, `reaction_fire`, etc.).

#### Requested vs actual position

- **Requested** = published MOVE command `destination` (when the delivered command is known).
- **Stopped / final** = `final_position` on the terminal result — sole replan anchor after `INTERRUPTED` or `FAILED`.
- Never treat “short of destination” as proof of *why* the walk stopped unless `movement_stop_reason` (or matching `public_reason`) says so.

#### After an interrupted MOVE

1. Run `runMandatoryPostCommandPrelude({ result, command })`.
2. When `requires_fresh_binding` / `requires_fresh_binding_before_next_publish` is true: refresh binding (**SEND** or post-command `m0/state.json` when published) before the next remote command.
3. Replan from **`final_position`**, new `command_id`, updated binding — do **not** auto-continue the prior destination.
4. `reaction_fire` means exposure interrupted the walk; read refreshed unit rows and `perceptionLog` for **observed** damage — the result alone does not prove injury.

#### When fresh tactical state is required

| Situation | Fresh binding / state |
|-----------|------------------------|
| Verified `COMPLETED` on commanded tile | Refresh binding before chaining; post-command state may suffice. |
| `INTERRUPTED` / `FAILED` / unverified `COMPLETED` | **Required** before treating positions or threats as current. |
| `REJECTED` (never executed) | Fix validation/binding; fresh snapshot only if binding stale — not every reject implies F6. |
| `EXECUTING` / `ACCEPTED` | Wait — not terminal. |

Programmatic messages: `buildMoveTerminalMessage`, `enrichMoveResultNotification` in `move-result-consumer.cjs`.

### Pre-MOVE exposure and reaction fire (advisory)

Before publishing MOVE (after status, equipment, and hostile-intelligence review):

- **KNOWN THREAT** — current LOS hostiles in `tactical.units[]` (`confirmed_current_los` per fair-play consumer).
- **POSSIBLE THREAT** — plausible exposure without live LOS proof (open ground, off-LOS approaches).
- **UNKNOWN EXPOSURE** — unseen tiles/enemies; not automatically safe.

Rules: do not use `last_seen` as live positions; neutrals are not hostile targets; reaction fire may occur **during** the walk (no new command until terminal); prefer staged MOVEs when exposure matters; weigh **campaign/mission context** (not only min casualties or mission score) before accepting exposure — high-risk MOVEs remain valid when strategically justified (AI-owned soldiers only). See `move-exposure-policy.cjs` for the full checklist.

After interrupt: `runMandatoryPostCommandPrelude`, fresh binding when required, replan from `final_position`, re-read contacts — do not blindly repeat the same destination.

Full checklist: `getMoveExposurePolicyMarkdown()` in `companion/m0-publish/lib/move-exposure-policy.cjs` (embedded in `getAiBriefingInstructionsMarkdown()`).

### MOVE replan (especially ramps, doors, grav lifts)

| Outcome | Action |
|---------|--------|
| Verified success | Refresh binding; then publish the next command with a new `command_id`. |
| `INTERRUPTED` / `FAILED` | Replan from **`final_position`**, not the original destination. New binding + new `command_id`. |
| Short of destination near **ramp / stairs / Skyranger deck / grav lift** | Stage **short** MOVEs: foot tile → ramp/stair → correct **z** (ground ↔ deck varies by mission — confirm from `final_position`, not map lore). Confirm each step’s `final_position` before chaining. |
| Wrong **z** on destination | Command a destination with the intended **z**; do not assume same `(x,y)` implies the right level. |

Fair-play: use floor **`G`** / **`g`** and `terrainFullAsciiBattlefield.hints.gravLiftStructures` for **planning** only (`pathfindingGuaranteed: false` on vertical links). ASCII does not guarantee walkability — engine results and refreshed unit positions are authoritative.

**Mandatory workflow (not optional):** After terminal MOVE, run `runMandatoryPostCommandPrelude({ result, command })`. **`readyForNextCommand` / `mayContinuePriorMovePlan`** = safe to **chain the same movement plan** (verified COMPLETED on x/y/z). When **false**, do **not** auto-continue the prior destination — but **`mayPublishAfterFreshBinding`** is still **true** after any terminal MOVE: refresh binding (SEND or post-command `m0/state.json`), then publish a **new** `command_id` from replanned `final_position` (especially actual **z** after interrupted ramp/stair moves). Derived `lastMoveOutcomeBrief` on state is guidance only; `m0/tactical-result.json` stays authoritative.

Programmatic mirror: `companion/m0-publish/lib/move-result-consumer.cjs` (`classifyMoveTerminalOutcome`, `buildMoveOutcomeBrief`).

### Directed fire — result verification

Applies to `SNAP_SHOT`, `AUTO_SHOT`, and `AIMED_SHOT`. Engine `m0/tactical-result.json` remains authoritative; relay notifications may add a derived `message` (presentation only).

Before replanning or publishing the next order:

1. Confirm a **terminal** result for your `command_id` and `session_id`.
2. Read `status` and `public_reason`; use refreshed `m0/state.json` (or operator **SEND**) for observed combat consequences — not result status alone.

| Status | Meaning |
|--------|---------|
| `REJECTED` | Command **did not execute** (validation, preflight, or start failed). |
| `EXECUTING` / `ACCEPTED` | Not terminal — wait for RETRIEVE. |
| `COMPLETED` | At least one **projectile launched** — **not** a confirmed hit, damage, or kill. For `AUTO_SHOT`, completion may follow the first projectile while burst animation continues. |
| `FAILED` | Execution began but did **not** reach successful fire completion (e.g. no projectile when idle). Does **not** imply zero TU expenditure. |
| `INTERRUPTED` | Fire stopped short (e.g. authority loss). |

**Line of fire (two paths):**

- **Preflight** engine reject: `REJECTED` with `public_reason` *No line of fire to visible target.* — rejected **before** execution.
- **Post-accept** engine abort: `FAILED` with `public_reason` `STR_NO_LINE_OF_FIRE`.

Do not infer ammunition consumption or TU deltas from `status` alone; use `remaining_tu` on the result and refreshed unit rows when planning the next order.

Ignore `destination_reached` on fire results (shared JSON shape with MOVE).

Programmatic mirror: `companion/m0-publish/lib/fire-result-consumer.cjs` (`buildFireTerminalMessage`, `buildFireOutcomeBrief`).

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

### `tacticalMapWindowV2` — multi-Z coverage (P1D)

Relay field `tacticalMapWindowV2` ships **24×24** layer rows (max **32 KiB** JSON). `levelSelection.includedLevels` is **observational geometry only** — not a path guarantee. `verticalTransitions` and floor **`G`/`g`** use `pathfindingGuaranteed: false`; **engine MOVE / `Pathfinding::calculate`** decides legal movement.

**Grav column (three levels):** When the focus window contains a **discovered** same-`(x,y)` grav-lift **floor** on focus **Z** and both adjacent **Z** (`structureMeta.floorGravLift`), relay default publish (`maxExtraLevels: 1`) may include **all three** levels (`gravColumnInWindow: true`). An explicit **`maxExtraLevels: 0`** keeps **focus Z only** even when a triple column exists. Undiscovered cells (`?`) never create links. Open-air **`A`** neighbors do not imply vertical connectivity.

**Omitted levels:** See `levelSelection.omittedLevels` and `onDemandLevels`. Pull them with **`m0/terrain-query.json`**: set `zMin` / `zMax` to the missing **Z** band, use `profile: compact`, and match relay `snapshot_id` / sidecar YAML binding (P0A).

**Compact elevation (`b.e`):** In terrain-query schema v2 **compact** cells, stair/ramp slope uses exported terrain level in **`b.e`** (verbose uses `body.elev`). v2 layer rows **do not** include numeric `elev`; use query or packed YAML for slope planning — still not a movement guarantee.

**Craft / Skyranger:** Interior deck **Z** is mission-dependent (`_craftZ` at generation). **Never assume cabin `z=1`**; read unit `position[2]`, v2 focus `z`, and confirm with staged MOVE `final_position`.

### Fair-play (movement vs map)

- `?` ≠ empty. `o` ≠ guaranteed MOVE path. Visibility ≠ walkability. `w` in composite ≠ full edge diagnostics — use **C** when ambiguious.
- Off-LOS `U` doors: state unknown. No smoke/fire/damage in ASCII export.

Optional: `m0/terrain-query.json` with `snapshot_id`, `center`, `radius` or `rectangle`, and `zMin`/`zMax` when v2 omitted a level.

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

**SEND (F6)** → fresh `m0/state.json`. **RETRIEVE** → one command execution (handled by the **Node daemon** transaction path). **AUTO RETRIEVE** is an optional battlescape timer that fires RETRIEVE when **AUTO:ON** (default **off** each mission; **30s** interval when on, reset on battlescape entry). AUTO does not publish commands or replace the daemon. One command per retrieve transaction.

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

**Directed-fire commands** (`SNAP_SHOT`, `AUTO_SHOT`, `AIMED_SHOT`, and grenade `THROW`) require **`active_hand`**: `STR_LEFT_HAND` or `STR_RIGHT_HAND` only. Prefer `composeSnapShotCommand`, `composeAutoShotCommand`, `composeAimedShotCommand`, and `composeThrowCommand` in `command-binding.cjs` so the field is never omitted.

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
| `INTERRUPTED` / `FAILED` MOVE | Replan from `final_position`; verify `destination_reached` + tile match before treating `COMPLETED` as success |
| `COMPLETED` MOVE but wrong tile / flag | Hard stop — refresh state (SEND or post-command binding); staged ramp/grav MOVE |
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
| MOVE result verification | `m0-publish/lib/move-result-consumer.cjs` |
| ASCII | `m0-publish/lib/terrain-tactical-map.cjs` |
| Operator relay setup (not agent onboarding) | `m0-publish/docs/relay-github-setup.md` |

Companion repo index: [README.md](../README.md) → this playbook.

---

*M1 pipeline: **13** command types in `parseTacticalCommand` (includes STAND). Stale: `M1-battlescape-capability-audit.md` (MOVE/KNEEL/SNAP only).*
