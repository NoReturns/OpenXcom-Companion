# M1 Battlescape Capability Audit

**Date:** 2026-11-05  
**Scope:** Read-only review of local OpenXcom Companion engine fork, F6 tactical YAML export, command executor, Node relay/sidecar, ruleset usage in export, and automated tests.  
**Out of scope:** No code changes, builds, runtime, network, or mutation of production journals/saves/command files.

**Status legend**

| Label | Meaning |
|-------|---------|
| **SUPPORTED** | Full engine behavior exists; Companion observes and/or commands it with tested plumbing |
| **PARTIAL** | Engine supports; Companion exposes or commands only a subset |
| **MISSING** | No Companion observation or command path |
| **UNVERIFIED** | Implemented in code/tests but not confirmed in owner live GitHub + engine sessions |

---

## Executive summary

OpenXcom’s battlescape is **fully playable** in the stock engine sense (terrain, AI, inventory, psionics, mission end, HWPs, etc.). The Companion **intentionally** publishes a **bounded, fairness-aware** tactical YAML (schema v4/v5, **256 KiB cap**) and accepts **three** remote command types when `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`: **MOVE**, **KNEEL**, **SNAP_SHOT**.

Observation is strong for **player-turn geometry (with documented off-LOS caveats)**, **visible/hostile unit shells**, **live roster soldiers’ loadouts and affordances**, and **weapon-fire event log**. It is weak or absent for **morale/stun/facing**, **ground items**, **mission metadata**, **reaction/reservation/end-turn**, **most item categories as commands**, and **full ruleset catalogs**.

Commands are **heavily gated** (`snapshot_sha256`, `session_id`, `turn`, `state_version` = `eventLog.latestSeq`, AI ownership, player turn, not busy). Relay **commandBinding** on `m0/state.json` supports remote authoring but **live GitHub end-to-end** for MOVE is documented as **NOT VERIFIED**; local engine files show at least one **SNAP_SHOT** in **EXECUTING** (non-terminal) state—treat as **operator activity**, not a completed audit proof.

---

## Architecture map (sources of truth)

| Layer | Primary files | Role |
|-------|---------------|------|
| Snapshot export | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp`, `CompanionSnapshotTerrain*.cpp`, `CompanionSnapshotExportCore.cpp` | F6 + idle player-turn export to `OPENXCOM_COMPANION_SNAPSHOT_PATH` |
| Snapshot validation / relay JSON | `companion/m0-publish/lib/tactical-publish.cjs`, `terrain-brief.cjs` | Parse YAML → canonical `snapshot_id`; `terrainBrief`, `commandBinding` |
| On-demand publish | `CompanionBriefingRequest.cpp`, `companion-on-demand-relay*.cjs` | F6 → briefing request → GitHub tactical payload |
| Commands | `CompanionCommandCore.cpp`, `CompanionCommandRuntime.cpp`, `CompanionCommandJournalCore.cpp` | Local `tactical-command.json` → `tactical-result.json` |
| Relay delivery | `command-relay-watcher.cjs`, `terrain-query-relay-watcher.cjs` | Mirror GitHub command/query → snapshot directory |
| Authority | `CompanionTacticalAuthorityCore.cpp`, `CompanionSoldierOwnershipCore.cpp`, `companion-soldier-control.json` | AI vs human; stale relay JSON vs campaign |
| Tests | `companion_command_test.cpp`, `companion_snapshot_*_test.cpp`, `tactical-command-m1-*.test.cjs`, `command-relay-watcher.test.cjs` | Binding, terrain fairness, relay |

**Export triggers**

- **F6:** `CompanionBriefingRequest.cpp` → `CompanionSnapshot::tryExport` + marker/briefing files.
- **Idle player turn:** `BattlescapeGame.cpp` (~1171–1173) exports when no pending battle states, player side, not falling, not debug.
- **Post-command terminal:** `CompanionCommandRuntime.cpp` → `snapshotSha256ForTerminalCommandResult` may re-export before result binding.

**Export gates (snapshot omitted if any fail):** `OPENXCOM_COMPANION_SNAPSHOT_PATH` set; not debug; player turn; not `unitsFalling` (`CompanionSnapshot.cpp`).

---

## Payload metrics (production snapshot sample)

Read-only stat on `local/m0/tactical-live.yaml` (not modified):

| Metric | Value |
|--------|--------|
| On-disk size | **~100 KiB** (102,535 bytes) |
| Cap | **256 KiB** (`CompanionSnapshotTerrain::SNAPSHOT_MAX_BYTES`, `tactical-publish.cjs` `MAX_INPUT_BYTES`) |
| Schema | **v5** with `terrain.encoding: packed-v1`, **9,446** tile records |
| Map | 50×50×4 |
| Fallback | If v5 exceeds cap → **schema v4 without terrain** (`CompanionSnapshotExportCore::resolveSnapshotForSizeCap`) |

**Reduction opportunities (without losing core tactical value)**

- Omit or summarize **actionCosts** for non-AI soldiers if only AI-controlled units receive commands (today exported for all friendly roster soldiers).
- **Terrain:** already sparse (discovered only); further cap via regional export + **terrain-query** (already on-demand).
- **Event log:** capped at 256 events in sidecar validation; engine ring buffer may drop (`droppedCount`).
- **Hostile detail:** already minimal (id/faction/position only unless visible + not full friendly export).

---

## Data classification

| Class | Examples | Companion today |
|-------|----------|-----------------|
| **Static rules (one-time)** | `RuleItem` types, slot defs, damage, research gates | **MISSING** as dedicated catalog; only **itemType strings** appearing in snapshot |
| **Per F6 / idle snapshot** | turn, side, map size, units, terrain blob, eventLog, actionCosts | **SUPPORTED** (with v4 fallback) |
| **On-demand** | `terrain-query.json` → 8 KiB max response (`terrain-query.cjs`) | **SUPPORTED** (sidecar; snapshot_id bound) |
| **Local-only (not remote-assignable)** | `companion-soldier-control.json`, tactical save ownership YAML | **PARTIAL** — engine publishes JSON; AI assign via UI/save, not remote command |

---

## Capability matrix

### 1. Terrain, visibility, fog, LOS, doors, elevation, destruction, hazards, UFO maps

| Capability | Engine | Player UI | Companion export | Companion command | Live-tested | Notes / priority |
|------------|--------|-----------|-------------------|-------------------|-------------|------------------|
| Undiscovered fog | `Tile::isDiscovered` | Black fog | **SUPPORTED** — tiles with `disc==0` omitted | — | Automated | No leak in terrain blob |
| Discovered off-LOS geometry | Live `Tile` state | Map memory (no separate DB) | **PARTIAL** — exported with `memoryNote`; `inLos` on records | — | Automated + policy doc | Fair-play caveat: doors/damage off-LOS may appear before re-observation (`terrain-fairness-m1-19.md`) |
| Current LOS | `Tile::getVisible` | Lit tiles | **SUPPORTED** — `inLos` in packed decode / `terrainBrief` | — | Automated | |
| Walk costs / elevation | `Tile::getTUCost`, `getTerrainLevel` | Path preview | **PARTIAL** — `walkF/walkO`, `elev`, `noFloor`, `air` | MOVE only (pathfinding in engine) | MOVE: automated; live GitHub **UNVERIFIED** | UFO door TU uses `Tile::getTUCost` (M1-19 fix) |
| Sight blocking | `MapData` block flags | LOS shading | **PARTIAL** — `blockSightF/O`, wall `blockSight` | — | Automated | |
| Destructible terrain / fire / smoke | Engine full | Visual | **MISSING** in export | **MISSING** | — | **P2** if needed for AI planning |
| Doors (open/closed state) | Engine | Interaction | **PARTIAL** — implied via walk costs/state, not explicit door flag | **MISSING** | — | **P2** explicit door bit if off-LOS disputes matter |
| Mission map / UFO layout identity | `SavedBattleGame` mission type | Briefing | **MISSING** in snapshot | — | — | **P1** non-spoiler mission **class** only (e.g. crash vs terror) |
| Bounded local geometry query | — | — | **SUPPORTED** — `executeTerrainQuery` | — | Automated | Radius ≤12, response ≤8 KiB |

**Key symbols:** `CompanionSnapshotTerrainCapture.cpp` (`captureTileRecord`, `discoveryMask`); `CompanionSnapshotTerrain.cpp` (`MEMORY_NOTE`, `appendTerrain`).

---

### 2. Unit states, stats, injuries, morale, stun, facing, movement, flying, kneeling, factions

| Capability | Engine | Companion export | Companion command | Live-tested | Status |
|------------|--------|-------------------|-------------------|-------------|--------|
| Position | Full | **SUPPORTED** all included units | MOVE dest / SNAP target | SNAP local **UNVERIFIED** terminal | |
| Health | Full | **PARTIAL** — friendly roster soldiers only | — | — | |
| TU | Full | **PARTIAL** — same | Implicit in actionCosts | — | |
| Morale / stun / energy | Full | **MISSING** | **MISSING** | — | **P2** |
| Facing | Full | **MISSING** | **MISSING** | — | **P3** |
| Flying / falling | Full | **MISSING** explicit; export blocked while falling | Rejected `UNITS_FALLING` | Automated | |
| Kneeling | Full | **SUPPORTED** `kneeled` + posture TU in `actionCosts` | **KNEEL** | Automated; live **UNVERIFIED** | |
| Faction / mind control | Full | **PARTIAL** — `faction`, `originalFaction`; hostiles only if `getVisible()` | Actor must be live player soldier | Automated | Hidden units omitted entirely |
| Friendly non-roster units (e.g. some HWP/civilian edge cases) | Full | **PARTIAL** — position/faction shell if visible | **MISSING** actor validation | — | |

**Key symbols:** `shouldIncludeUnit`, `exportFriendlyTacticalDetails`, `isPublishableLivePlayerSoldier` in `CompanionSnapshot.cpp`; validation in `CompanionCommandCore.cpp`.

---

### 3. Inventory, items, ammo, equipment, ground items

| Capability | Engine | Companion export | Companion command | Status |
|------------|--------|-------------------|-------------------|--------|
| Hand slots | Full | **SUPPORTED** `hands.right/left`, `activeHand` | SNAP_SHOT uses `active_hand` | **SUPPORTED** observe |
| Body inventory | Full | **PARTIAL** — up to **24** non-hand entries, slot id + itemType + battleType | No transfer/reload commands | **PARTIAL** |
| Loaded ammo / empty flag | Full | **SUPPORTED** on firearms | SNAP validates ammo | **PARTIAL** |
| Grenade primed | Full | **SUPPORTED** `primed` | No PRIME/THROW commands | **PARTIAL** observe |
| actionCosts (snap/aimed/auto/launch/throw/prime/melee) | Full | **SUPPORTED** per hand with `usable`, `tuCost` | Only **snap** executed | **PARTIAL** |
| Ground items | Full | **MISSING** | **MISSING** | **P2** |
| Full ruleset item defs / mod stats | `Mod::getItem` | **MISSING** catalog | — | **P1** static **reference bundle** (types referenced in snapshot only) |

**Key symbols:** `appendInventoryEntries`, `appendHandActionCosts` (`CompanionSnapshot.cpp`); `validateSnapShotCommand` (`CompanionCommandCore.cpp`).

---

### 4. Tactical actions (movement, fire modes, throw, prime, melee, heal, psi, launchers, reaction, end turn)

| Engine action (representative) | Export affordance | Command | Test coverage |
|-------------------------------|-------------------|---------|---------------|
| Walk / run path | TU costs implicit via move | **MOVE** | `companion_command_test.cpp`, relay tests |
| Kneel / stand | posture costs + KNEEL | **KNEEL** | Core + `command-relay-watcher.test.cjs` |
| Snap shot | `actionCosts` + event log | **SNAP_SHOT** | Core + M1-32A schema tests |
| Aimed / auto / burst | In `actionCosts` only | **MISSING** | — |
| Launch / blaster | In `actionCosts` if waypoints | **MISSING** | **P2** |
| Throw / prime | In `actionCosts` | **MISSING** | **P2** |
| Melee | In `actionCosts` | **MISSING** | **P3** |
| Medikit / heal | Engine (`MedikitState`) | **MISSING** | **P3** |
| Psionics | `BattlescapeGame::psiButtonAction` | **MISSING** | **P3** |
| Reaction fire | `TileEngine::tryReaction` (not human order) | **MISSING** | N/A by design |
| TU reserve / snap reserve | UI (`BattlescapeState`) | **MISSING** | **P3** |
| End turn / abort | `finishBattle` | **MISSING** | **P3** — high risk if ever added |

**Command lifecycle:** `REJECTED` → `ACCEPTED` → `EXECUTING` → `COMPLETED` | `INTERRUPTED` | `FAILED` (`CompanionCommandCore.h`). Stale binding codes: `STALE_SNAPSHOT`, `STALE_SESSION`, `STALE_TURN`, `STALE_STATE_VERSION`, `NOT_AI_CONTROLLED`, `HUMAN_OVERRIDE`, etc.

**Key symbols:** `CompanionCommandRuntime::tick`; `ActiveCommand::KIND_MOVE` | `KIND_SNAP_SHOT` (KNEEL is synchronous, no KIND).

---

### 5. Tanks / HWPs / multi-tile units

| Topic | Engine | Companion | Status |
|-------|--------|-----------|--------|
| Multi-tile units | Supported | Visible units export **position** (typically anchor tile) | **PARTIAL** — no footprint/size |
| HWP as non-soldier | Supported | Unless visible hostile shell, **no** friendly detail unless live roster soldier | **MISSING** command actor |
| Vehicle weapons | Supported | Same as item actionCosts if soldier/HWP treated as friendly detailed unit | **UNVERIFIED** for HWP |
| Ownership | Engine | Campaign/tactical YAML + control JSON | **PARTIAL** — see §7 |

**Priority:** **P2** if HWP AI control is a product goal (actor model + export stats).

---

### 6. Mission lifecycle, civilians, extraction, victory, special rules, Cydonia

| Topic | Engine | Companion export | Companion command | Disclosure risk |
|-------|--------|------------------|-------------------|-----------------|
| Mission type / objectives | `SavedBattleGame` `_missionType`, objectives | **MISSING** | **MISSING** | Low if added as enum only |
| Civilians | Units in battle | **PARTIAL** — visible neutrals as faction shell | **MISSING** | |
| Extraction zones / abort | `finishBattle(abort)` | **MISSING** | **MISSING** | |
| Victory / loss | Engine | **MISSING** | **MISSING** | |
| Turn / side | Full | **SUPPORTED** `turn`, `side`, `selectedUnitId` | Binding fields | |
| Cydonia / endgame maps | Engine | Same as generic terrain (no story filter) | — | **MEDIUM** — publishing full terrain + unit positions on Cydonia is equivalent to any late-game mission; **no extra Companion redaction**. Mitigation: operator policy + optional mission-tag redaction (**P1** governance, not code today) |

---

### 7. Ruleset / modded items

| Need | Engine | Companion |
|------|--------|-----------|
| Active mod item definitions | Loaded in `Mod.cpp` / `RuleItem` | **Not exported** as corpus |
| Items in play | `BattleItem` | **itemType** + **battleType** int (0–11 validated in sidecar) |
| Research gates | `SavedGame::isResearched` | Reflected in `actionCosts.usable` only |
| Modded mechanics | Full engine | **PARTIAL** — only if reflected in snapshot fields above |

**Recommendation:** One-time **rules reference** JSON (types referenced in campaign + common equipment) via separate tooling—not F6 payload—**P1**.

---

## Companion vs engine feature confusion (explicit)

| Feature | Engine works? | Companion remote control? |
|---------|---------------|---------------------------|
| Player walks in UI | Yes | Only via **MOVE** + AI assignment |
| Snap shot in UI | Yes | Only via **SNAP_SHOT** |
| Aimed/auto fire | Yes | **No command** (export shows costs only) |
| Reaction shots | Yes | **Not commandable** (and not exported) |
| F6 snapshot | Yes | **Observation** only; not a command |
| GitHub `m0/tactical-command.json` | N/A | **Meaningless** until sidecar writes local inbox + executor enabled |

---

## Relay, ownership, session risks

| Risk | Mechanism | Mitigation in tree |
|------|-----------|-------------------|
| Stale command after new F6 | `state_version` / `snapshot_sha256` | Engine reject; inbox archive on export (`archiveStaleInboxAfterSnapshotExport`) |
| Split-brain ownership | Campaign HUMAN vs JSON `"ai"` | `HUMAN_OVERRIDE` / `isStaleRelayAiAfterCampaignHumanAssignment` (`soldier-ownership-m1-25b.md`) |
| Session / battle identity change | `onBattleCompanionBindingContext` | Interrupt in-flight command; archive stale session inbox |
| Relay journal / completion | `command-relay-watcher.cjs`, M1-34G design | Production daemon stale-code risk documented in preflight—**operational**, not battlescape logic |
| On-demand vs command-relay | Separate daemons | Only one owner per `snapshot-path` for retrieve/send |
| Hidden information leak | Off-LOS live tiles | Documented; terrain-query marks UNKNOWN cells |

**Do not confuse:** `snapshot_id` (hash of canonical tactical **JSON**) vs `snapshot_sha256` (hash of raw **YAML bytes**) — command binding uses **YAML SHA** (`command-binding.cjs`).

---

## Test & live verification matrix

| Capability | Unit / fixture tests | Live GitHub E2E | Local engine evidence |
|------------|---------------------|-----------------|------------------------|
| Snapshot v5 + terrain | `companion_snapshot_terrain_test.cpp`, `tactical-v5-publish-roundtrip.test.cjs` | — | `tactical-live.yaml` v5 present |
| Terrain fairness | `terrain-fairness-m1-19.md`, tests | — | — |
| MOVE | `companion_command_test.cpp`, relay watcher | **UNVERIFIED** (M1-20 doc) | — |
| KNEEL | Same + M1-34B fixtures | **UNVERIFIED** | — |
| SNAP_SHOT | M1-32A tests, `companion_command_test.cpp` | **UNVERIFIED** | Local `tactical-result.json` shows **EXECUTING** SNAP_SHOT (non-terminal; do not treat as pass) |
| Terrain query | `tactical-command-m1-19.test.cjs` | **UNVERIFIED** | — |
| Isolated relay E2E | `run-m1-34e-isolated-e2e.cjs` | Isolated GitHub paths only | — |

---

## Confirmed gaps (prioritized roadmap)

### P0 — Safety / binding (mostly done; operational hardening)

- Keep **executor off** by default; enforce **AI ownership** + **binding fields** on all command types.
- Resolve **production daemon / relay completion** races (M1-34G) so remote commanders get trustworthy terminal results.

### P1 — Tactical AI usefulness without over-sharing

- **Mission context** field (type enum, turn limit, civilian flag) without map spoilers.
- **Static rules slice** for item types seen in snapshot / campaign.
- **Governance** for late-game (Cydonia) publish approval.
- **Live verification checklist** for one MOVE + one SNAP_SHOT + one KNEEL on GitHub path (owner-run).

### P2 — Combat breadth

- Commands: **AIMED_SHOT**, **THROW**, **PRIME**, **USE** (medikit), with same binding/authority pattern as SNAP_SHOT.
- Export: **ground items** in radius; optional **morale/stun** for friendly soldiers.
- **Explicit door / damage** state in terrain v2 (`terrainBrief` proposal).

### P3 — Advanced / high risk

- **END_TURN**, **ABORT**, inventory **transfer**, **psi**, multi-tile **HWP** control.
- Historical terrain memory (`packed-v2` / last observed turn).

---

## Appendix: command JSON contracts (implemented)

| command_type | Required fields | Engine entry |
|--------------|-----------------|--------------|
| `MOVE` | `destination` {x,y,z}, binding fields | `CompanionCommandRuntime.cpp` (~1524+) |
| `KNEEL` | binding fields | ~1312+ |
| `SNAP_SHOT` | `target`, `active_hand`, binding fields | ~1280+ |

Relay paths (GitHub): `m0/tactical-command.json`, `m0/tactical-result.json`, `m0/terrain-query.json`, `m0/terrain-query-result.json` (`github-relay.cjs`).

---

## Appendix: snapshot schema roots (validated)

**v5:** `schemaVersion`, `turn`, `side`, `selectedUnitId`, `map`, `units`, `eventLog`, `terrain`  
**v4 fallback:** drops `terrain`  
**Sidecar relay:** adds `terrainBrief`, optional `commandBinding` on publish when YAML SHA known.

Yes — **audit 1** ([M1-battlescape-capability-audit.md](file:///E:/Open%20X-Com%20Companion/companion/m0-publish/docs/M1-battlescape-capability-audit.md)) covers terrain, but mostly as **geometry and fairness**, not as **“this is UFO structure.”**

### What the audit did say

In **§1 Terrain…** it listed:

- **SUPPORTED / PARTIAL:** discovered tiles, LOS labels, walk TU, elevation, `blockSight`, packed-v1 blob, terrain-query, off-LOS caveats ([terrain-fairness-m1-19.md](file:///E:/Open%20X-Com%20Companion/companion/m0-publish/docs/terrain-fairness-m1-19.md)).
- **MISSING:** explicit **door state**, destructible/fire, full mission/UFO **layout identity** (only a vague **P1** note: non-spoiler **mission class**, e.g. crash vs terror — **not** “UFO wall vs barn wall”).

So the **UFO-not-known** problem is **aligned with the audit** (geometry without semantic labels), but we **did not** spell out your exact failure mode: AI reads **movement/sight obstruction** and treats it as generic **blocked area**, with no **UFO hull / interior / door** context.

### Why the AI sees “blocked” but not “UFO”

The exporter only captures **physics-ish** fields, not **map object identity**:

```16:48:engine/OpenXcom/src/Engine/CompanionSnapshotTerrainCapture.h
struct TerrainWallExport { int walk; bool blockSight; };
struct TerrainBodyExport { bool air; bool noFloor; int elev; ... walkF/walkO; blockSightF/O; };
// No MapData type, no "UFO", no door open/closed flag
```

Relay **`terrainBrief`** is explicit about that gap:

```49:52:companion/m0-publish/lib/terrain-brief.cjs
 * Classify one discovered terrain record using only packed/verbose export fields.
 * Does not infer object identity (doors, lifts, stairs).
```

Impassable objects get `objectIdentity: 'unknown'` and notes like *“door-like geometry; **type not exported**”* — which reads to the model as **blocked area**, not **UFO corridor wall**.

The snapshot also **does not** export mission type on the tactical root today, so the AI often lacks even **“you’re inside a crashed UFO”** at the briefing layer unless you say it in chat.

### What would actually fix it (not done in audits — design only)

| Addition | Helps with |
|----------|------------|
| **Mission context** on snapshot/relay (e.g. `missionType`, UFO size/class from `SavedBattleGame::getMissionType()` — player-visible) | “We’re on a UFO mission” globally |
| **Semantic tags** on discovered tiles (from `MapData` / tile flags: UFO vs XCOM base terrain, door, lift) — only where **discovered** | “That blocked tile is UFO hull / UFO door” |
| **terrainBrief v2** phrases | Turn geometry into player-meaningful labels without dumping the whole map mod |
| **Campaign ledger** (audit 3) | “We’ve been in Small Scout layouts before” — strategic, not per-cell |

**Fairness note:** tagging should follow the same rules as geometry (discovered / in-LOS policy you already documented); don’t export undiscovered UFO interior as labeled.

If you want, we can add a short **“Terrain semantics gap (UFO identity)”** subsection to audit 1 as a pointer doc — or fold it into a future implementation spec. I didn’t create a separate markdown for that in audit 3; audits 2 and 3 were geoscape base export and campaign ledger, not battlescape terrain semantics.


---

*End of audit.*
