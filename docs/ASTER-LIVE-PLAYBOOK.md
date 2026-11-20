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
| 7 | **Compose** — one of **25** `command_type` values; unique `command_id` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`); no extra JSON keys (§ [Command schema](#command-schema)). |
| 8 | **Publish** `m0/tactical-command.json` only when inbox absent (GitHub connector or operator CLI on PC). |
| 9 | **RETRIEVE** — operator or **AUTO RETRIEVE** (battlescape timer; § [Relay lifecycle](#relay-lifecycle-send-retrieve-daemon)). |
| 10 | **Verify** terminal result; type-specific checks (MOVE / fire / melee / DROP § [Results](#terminal-results)). |
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
| `m0/rules-reference.json` | Optional agent-side rules metadata; **not** a replacement for the local rules file used by sidecar validation |

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

**Rules export:** **Ctrl+Shift+R** in Geoscape, Basescape, or Battlescape writes `local/m0/companion-rules-reference.json` beside the configured tactical snapshot. It is **not** F6 and does **not** automatically publish `m0/rules-reference.json`. For `GUIDED_LAUNCH`, the live sidecar reads the validated **local** reference and checks the current campaign identity before delivery. If absent/stale/mismatched, export again using the current campaign; do **not** invent a waypoint limit. The optional remote rules publication can help agent authoring, but does not replace local sidecar validation.

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

`runMandatoryTacticalEquipmentReview()` in [tactical-equipment-brief.cjs](../m0-publish/lib/tactical-equipment-brief.cjs). `runMandatoryBriefingPrelude()` in [tactical-briefing-ai-workflow.cjs](../m0-publish/lib/tactical-briefing-ai-workflow.cjs).

---

## Submitting orders

### GitHub connector (external agent)

1. Steps 1–5 of [operating procedure](#mandatory-agent-operating-procedure).
2. Write `m0/tactical-command.json` when inbox absent.
3. Operator RETRIEVE; poll until terminal result matches `command_id` + `session_id`.

### Local CLI (operator PC only)

`node m0-publish/publish-tactical-command-once.cjs --dry-run|--publish --path <draft>` (from companion repo root).

Prefer [command-binding.cjs](../m0-publish/lib/command-binding.cjs) composers — never hand-edit binding fields:

| Family | Composers |
|--------|-----------|
| Movement / posture | `composeMoveCommand`, `composeKneelCommand`, `composeStandCommand` |
| Fire / ordnance | `composeDirectedFireCommand`, `composePrimeCommand`, `composeThrowCommand`, `composeGuidedLaunchCommand` |
| Inventory | `composeReloadCommand`, `composeUnloadCommand`, `composeInventoryMoveCommand`, `composePickupCommand`, `composeDropCommand` |
| Medikit | `composeHealCommand`, `composeStimulantCommand`, `composePainKillerCommand` |
| Psionics | `composePsiPanicCommand`, `composePsiMindControlCommand` |
| Melee | `composeMeleeAttackCommand` |

Workflow: read `commandBinding` from fresh `m0/state.json` → `buildCommandBinding(tactical, snapshot_sha256)` if needed → compose → write draft → `publish-tactical-command-once.cjs --dry-run` then `--publish`.

**Runtime:** Canonical launcher `runtime/m0/Start-CompanionOpenXcom.ps1` sets `OPENXCOM_COMPANION_MELEE_EXECUTION=1` for the game process (process-local only). Without that env var the engine rejects `MELEE_ATTACK` with `MELEE_EXECUTION_DISABLED`.

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

### Guided launch (`GUIDED_LAUNCH`)

- Requires an AI-owned soldier, equipped/research-usable launcher, loaded compatible guided ammunition, sufficient TU, and a fresh snapshot binding. Verify `hands`, `inventory`, `actionCosts.hands.*.actions[]` (`id: "launch"`), and equipment IDs before authoring.
- Command fields: `active_hand` (`STR_LEFT_HAND` or `STR_RIGHT_HAND`) and **ordered** `waypoints: [{x,y,z}, ...]`. Each coordinate is an object of integer map coordinates, not an array. The count must fit the weapon/ammunition **ruleset** `waypoints` cap, not a guessed universal maximum. The current campaign's Blaster Launcher exported a cap of **9**, but other rulesets can differ.
- **Z is real.** Elevate early to clear friendly soldiers/obstacles, route horizontally, then descend to the terminal waypoint as appropriate. Confirm map depth, visible terrain, and nearby friendlies; a valid coordinate is **not** guaranteed clear flight. `?` terrain is unknown and targeting it is a tactical risk.
- A `COMPLETED` relay result confirms the engine performed the launch, **not** that the last waypoint was the exact impact tile or an alien died. Confirm impact/explosion through `perceptionLog` on a new snapshot and casualties only through fair-play observations or the eventual AAR. `eventLog` can emit `weapon_fired` entries for **each waypoint of a single missile**, so do not count those as multiple spent rounds.
- Firing consumes TU/ammunition without moving the soldier. A following `RELOAD` (if needed) uses the **live** `weapon_battle_item_id` and `ammo_battle_item_id`, and a fresh binding; never assume ammo automatically reloads.
- If sidecar reports missing/stale/campaign-mismatched rules, operator uses **Ctrl+Shift+R** in the current game to export `local/m0/companion-rules-reference.json`, then retries a **new command_id** after the rejected command is retired and a new snapshot is published. Do not bypass reference checks.

Mirror: [guided-launch-result-consumer.cjs](../m0-publish/lib/guided-launch-result-consumer.cjs); sidecar gate: [rules-reference-sidecar-consumer.cjs](../m0-publish/lib/rules-reference-sidecar-consumer.cjs).

### HWP (`HWP_MOVE`, `HWP_TURN`, `HWP_FIRE`, `HWP_GUIDED_LAUNCH`)

- **Actor:** AI-owned row in `commandBinding.player_hwps` (not `player_soldiers`). Snapshot `friendlyHwpObservationV1` supplies fixed weapon ids for fire/guided commands.
- **Owner live acceptance (2026-11-19 / 2026-11-20):** movement and turning; cannon and laser direct fire; Rocket Tank `HWP_FIRE`; Fusion Hovertank `HWP_GUIDED_LAUNCH` — terminal `COMPLETED` in live Battle Mode on promoted runtime.
- **`COMPLETED`** confirms relay execution and TU/ammo bookkeeping, not guaranteed kills. Refresh F6 before the next HWP command.

### DROP

Terminal `COMPLETED` may include `ground_placement`. Confirm scavenge via refreshed snapshot / `lastDropOutcomeBrief.verification_class` — not result status alone.

Mirror: [drop-result-ground-placement.cjs](../m0-publish/lib/drop-result-ground-placement.cjs).

### Medikit (`HEAL`, `STIMULANT`, `PAINKILLER`)

- **Actor:** AI-owned `player_soldiers` id with medikit in the declared `active_hand` (`STR_LEFT_HAND` \| `STR_RIGHT_HAND`). `medikit_battle_item_id` must match snapshot `hands` / `inventory` rows (dedupe across slots).
- **Target:** `target_unit_id` must be a **friendly roster soldier** (same export conventions as `player_soldiers`, including unconscious co-tile patients). Do not target hostiles, HWPs, or mind-controlled roster shells.
- **Engine parity:** At execution the engine resolves the **native medikit target** from actor position and facing (`resolveNativeMedikitTarget`). Requested `target_unit_id` must match that native id or the relay returns **`MEDIKIT_APPLICATION_FAILED`** (no charge/TU/wound mutation).
- **Co-tile** unconscious patients are the **certified live path** for `HEAL`. **Adjacent** facing-correct `HEAL` (often **`TURN_FACE`** then `HEAL`) is **UNVERIFIED** on live mission terrain — engine/harness evidence is inconclusive, not a confirmed production defect. Use fresh F6, correct facing, and fail-closed **`MEDIKIT_APPLICATION_FAILED`** until a live drill proves `COMPLETED`.
- **`HEAL` only:** `body_part` integer **0–5** (`UnitBodyPart` — head, torso, right arm, left arm, right leg, left leg). Other medikit types omit `body_part`.
- **`COMPLETED`:** expect `target_unit_id`, `tu_spent`, charge consumption; `HEAL` may include `target_revived` when applicable. **`REJECTED`** = binding/validation; **`MEDIKIT_APPLICATION_FAILED`** = native application refused after accept.

### Psionics (`PSI_PANIC`, `PSI_MIND_CONTROL`)

- **Actor:** AI-owned soldier with **Psi-Amp** in `active_hand`, non-zero psi skill, sufficient TU (see `actionCosts` / `hands.*.actions` for `panic` or `mindcontrol`).
- **Target:** **Genuine hostile** with **`confirmed_current_los`** at export (`tactical.units[]` + fair-play hostile rules — § [Status review](#mandatory-battlefield-status-review)). Do **not** target `player_soldiers`, neutrals, or visible non-hostiles. Hidden hostiles without current LOS → expect **`REJECTED`** / visibility failures.
- **`PSI_PANIC`:** engine panic attempt; terminal `COMPLETED` confirms execution, not guaranteed panic outcome — confirm via refreshed snapshot / `perceptionLog` psych events (historical UI only unless readiness confirms).
- **`PSI_MIND_CONTROL`:** live-certified on promoted runtime; `COMPLETED` confirms relay execution and TU spend — confirm faction/control on **next F6** (`tactical.units[]`, exceptions). Absent converted unit from `units[]` at export does not retroactively void a terminal `COMPLETED`.
- **`PSI_ATTACK_FAILED`** / non-`COMPLETED` — no mutation; use new `command_id` after fresh binding.

### Melee (`MELEE_ATTACK`)

- **Actor:** AI-owned `player_soldiers` id with **`BT_MELEE`** weapon (e.g. stun rod) in `active_hand`. `melee_weapon_battle_item_id` must match snapshot `hands` / `inventory`.
- **Target:** **Genuine hostile** with fair-play visibility (`target_unit_id` on a confirmed observation — same conventions as psi targeting). Adjacent/range geometry is validated in-engine (`BA_HIT`); Node may emit advisories only.
- **Execution:** async (`EXECUTING` during swing). Requires `OPENXCOM_COMPANION_MELEE_EXECUTION=1` on the runtime (canonical launcher sets this).
- **`COMPLETED`:** confirms native melee chain finished and TU spent — **not** guaranteed hit: read `melee_hit`, optional `target_status` (`active` / `unconscious` / `dead`), `tu_spent`, `target_incapacitated`, `target_killed`. A hit with `target_status: active` does **not** by itself prove unconsciousness; confirm stun/kill on a fresh F6.
- **`FAILED`:** idle battlefield with unresolved strike (e.g. reload mid-animation) — no second strike from relay; refresh binding before retry.
- **`MELEE_EXECUTION_DISABLED`:** gate off — zero mutation; enable via canonical launcher, not global Windows env.

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

### Parameter reference (25 types)

Roster soldiers use `player_soldiers` + `soldierControl` `ai`. HWP commands use `commandBinding.player_hwps` (schema v2), actor id **≥ 1_000_000**, `controlMode: ai` on the HWP row.

| `command_type` | Extra fields | Execution |
|----------------|--------------|-----------|
| `MOVE` | `destination`: `{x,y,z}` integers 0–255 | async |
| `KNEEL` | — | sync |
| `STAND` | — | sync |
| `TURN_FACE` | `target` `{x,y,z}` bearing (not same tile as actor) | sync |
| `SNAP_SHOT` | `target` `{x,y,z}`, `active_hand`: `STR_LEFT_HAND` \| `STR_RIGHT_HAND` | async |
| `AUTO_SHOT` | same as snap | async |
| `AIMED_SHOT` | same as snap | async |
| `GUIDED_LAUNCH` | `active_hand`, `waypoints`: ordered array of `{x,y,z}` integer objects; count within ruleset-defined weapon/ammo limit | async |
| `PRIME` | `active_hand`, `fuse_timer` 0–23 | sync |
| `THROW` | `target`, `active_hand` | async |
| `RELOAD` | `weapon_battle_item_id`, `ammo_battle_item_id` (distinct positive ints) | sync |
| `UNLOAD` | `weapon_battle_item_id`, `loaded_ammo_battle_item_id` (distinct) | sync |
| `INVENTORY_MOVE` | `item_battle_item_id`, `source_slot`, `destination_slot`, `destination_x`/`destination_y` 0–255; `source_x`/`source_y` optional **pair** | sync |
| `PICKUP` | `item_battle_item_id`, `ground_position`, `destination_slot`, `destination_x`/`destination_y` | sync |
| `DROP` | `item_battle_item_id`, `source_slot`, optional `source_x`/`source_y` **pair** | sync |
| `HEAL` | `target_unit_id`, `medikit_battle_item_id`, `active_hand`, `body_part` 0–5 | sync |
| `STIMULANT` | `target_unit_id`, `medikit_battle_item_id`, `active_hand` | sync |
| `PAINKILLER` | `target_unit_id`, `medikit_battle_item_id`, `active_hand` | sync |
| `PSI_PANIC` | `target_unit_id` (hostile), `psi_amp_battle_item_id`, `active_hand` | sync |
| `PSI_MIND_CONTROL` | `target_unit_id` (hostile), `psi_amp_battle_item_id`, `active_hand` | sync |
| `MELEE_ATTACK` | `target_unit_id` (hostile), `melee_weapon_battle_item_id`, `active_hand` | async |
| `HWP_MOVE` | `destination` `{x,y,z}` | async |
| `HWP_TURN` | `target` `{x,y,z}`, `turn_part`: `body` \| `turret` | sync |
| `HWP_FIRE` | `target` `{x,y,z}`, `fire_mode`: `snap` \| `aimed`, `weapon_battle_item_id` (fixed weapon id) | async |
| `HWP_GUIDED_LAUNCH` | `weapon_battle_item_id`, `waypoints`: ordered `{x,y,z}`[] | async |

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

**GUIDED_LAUNCH** — three map-specific waypoints, climb then descend. Replace the example with a route grounded in the **current** snapshot, not these sample coordinates:

```json
{
  "schema_version": 1,
  "command_id": "guided-example-001",
  "command_type": "GUIDED_LAUNCH",
  "actor_unit_id": 1,
  "active_hand": "STR_RIGHT_HAND",
  "waypoints": [
    { "x": 21, "y": 3, "z": 2 },
    { "x": 16, "y": 10, "z": 2 },
    { "x": 12, "y": 20, "z": 0 }
  ],
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

**HEAL** (co-tile unconscious patient; replace ids/binding from live `commandBinding`):

```json
{
  "schema_version": 1,
  "command_id": "heal-example-001",
  "command_type": "HEAL",
  "actor_unit_id": 1,
  "target_unit_id": 2,
  "medikit_battle_item_id": 700,
  "active_hand": "STR_RIGHT_HAND",
  "body_part": 1,
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

**STIMULANT** / **PAINKILLER** — same envelope as `HEAL` but `command_type` `STIMULANT` or `PAINKILLER` and **no** `body_part`.

**PSI_PANIC** / **PSI_MIND_CONTROL** (hostile `target_unit_id` e.g. alien id ≥ 1_000_000):

```json
{
  "schema_version": 1,
  "command_id": "psi-panic-example-001",
  "command_type": "PSI_PANIC",
  "actor_unit_id": 1,
  "target_unit_id": 1000000,
  "psi_amp_battle_item_id": 16,
  "active_hand": "STR_LEFT_HAND",
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

For mind control, set `"command_type": "PSI_MIND_CONTROL"` and a fresh `command_id`.

**MELEE_ATTACK** (adjacent visible hostile; stun rod or any wielded `BT_MELEE` item):

```json
{
  "schema_version": 1,
  "command_id": "melee-example-001",
  "command_type": "MELEE_ATTACK",
  "actor_unit_id": 28,
  "target_unit_id": 1000001,
  "melee_weapon_battle_item_id": 515,
  "active_hand": "STR_RIGHT_HAND",
  "snapshot_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "session_id": "a1b2c3d4e5f6789012345678abcdef01",
  "turn": 1,
  "state_version": 7
}
```

**Node compose (operator PC draft):**

```javascript
const {
  buildCommandBinding,
  composeHealCommand,
  composePsiPanicCommand,
  composePsiMindControlCommand,
  composeMeleeAttackCommand,
} = require('./m0-publish/lib/command-binding.cjs');
const binding = state.commandBinding; // from parsed m0/state.json
const heal = composeHealCommand(binding, {
  commandId: 'heal-live-001',
  actorUnitId: 1,
  targetUnitId: 2,
  medikitBattleItemId: 700,
  activeHand: 'STR_RIGHT_HAND',
  bodyPart: 1,
});
const panic = composePsiPanicCommand(binding, {
  commandId: 'panic-live-001',
  actorUnitId: 1,
  targetUnitId: 1000000,
  psiAmpBattleItemId: 16,
  activeHand: 'STR_LEFT_HAND',
});
const melee = composeMeleeAttackCommand(binding, {
  commandId: 'melee-live-001',
  actorUnitId: 28,
  targetUnitId: 1000001,
  meleeWeaponBattleItemId: 515,
  activeHand: 'STR_RIGHT_HAND',
});
```

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
| `GUIDED_LAUNCH` reference missing/stale | Operator exports Ctrl+Shift+R in current campaign, checks local reference and sidecar, then resends with new binding/id after rejection is retired |
| `MEDIKIT_APPLICATION_FAILED` | Native target mismatch, mis-aim, or unusable medikit — refresh F6; fix facing/position; new `command_id`; do not assume healing occurred |
| `PSI_ATTACK_FAILED` / psi `REJECTED` | LOS, TU, wrong target faction, or stale binding — refresh; pick `confirmed_current_los` hostile; new binding + id |
| `MELEE_EXECUTION_DISABLED` | Launch game via canonical launcher (melee gate off otherwise) |
| `MELEE_ATTACK_FAILED` / melee `FAILED` | Range, LOS, TU, or interrupted animation — refresh F6; new `command_id`; do not assume hit or stun |
| Stale `EXECUTING` melee after reload | Same session: monitor may `FAILED` idle orphan; cross-session: `INTERRUPTED` — refresh binding; never republish same id expecting a re-swing |
| Medikit adjacent `HEAL` | If native target does not resolve, use co-tile or operator UI — not a relay bypass |

---

## Communication

Concise intent in plain language. Human owns human soldiers and End Turn.

---

## Implementation pointers

| Topic | File |
|-------|------|
| Commands | [tactical-command.cjs](../m0-publish/lib/tactical-command.cjs) |
| Command composers | [command-binding.cjs](../m0-publish/lib/command-binding.cjs) |
| Publish CLI | [publish-tactical-command-once.cjs](../m0-publish/publish-tactical-command-once.cjs) |
| MOVE results | [move-result-consumer.cjs](../m0-publish/lib/move-result-consumer.cjs) |
| Guided-launch outcome | [guided-launch-result-consumer.cjs](../m0-publish/lib/guided-launch-result-consumer.cjs) |
| Rules reference sidecar gate | [rules-reference-sidecar-consumer.cjs](../m0-publish/lib/rules-reference-sidecar-consumer.cjs) |
| DROP placement | [drop-result-ground-placement.cjs](../m0-publish/lib/drop-result-ground-placement.cjs) |
| Soldier control | [soldier-control-relay.cjs](../m0-publish/lib/soldier-control-relay.cjs) |
| ASCII | [terrain-tactical-map.cjs](../m0-publish/lib/terrain-tactical-map.cjs) |
| Operator relay setup | [relay-github-setup.md](../m0-publish/docs/relay-github-setup.md) |

Index: [README.md](../README.md).

---

*M1: **20** types in `parseTacticalCommand` (includes `STAND`, `GUIDED_LAUNCH`, medikit `HEAL`/`STIMULANT`/`PAINKILLER`, psi `PSI_PANIC`/`PSI_MIND_CONTROL`, `MELEE_ATTACK`). Coverage audit: `m0-publish/docs/audits/ASTER-M1-TACTICAL-COMMAND-COVERAGE-AUDIT-01.md`.*
