# M1 Base Intelligence Export Audit (Geoscape / Basescape)

**Date:** 2026-11-05  
**Scope:** Read-only review of how a **manual** `companion-base-intelligence.json` export could be added, what engine data exists, **discovery-only** gating, and plausible file sizes.  
**Explicit non-goals:** No F6 coupling, no GitHub send/receive pipeline (unless added later as a separate opt-in), no implementation in this audit.

---

## Executive summary

There is **no** geoscape/base intelligence export today. All Companion I/O is **battlescape-centric** (`OPENXCOM_COMPANION_SNAPSHOT_PATH`, F6 briefing, tactical YAML, command relay).

The **good news:** OpenXcom already keeps almost everything you listed in **`SavedGame` + `Base` + related types**, and the **Research UI** already uses APIs that respect **completed vs available vs hidden** topics (`isResearched`, `getAvailableResearchProjects`, `hasUndiscoveredProtectedUnlock`). Geoscape visibility flags on **UFOs**, **mission sites**, and **alien bases** match “only what you’ve detected.”

**Recommended shape:** A new **manual hotkey** on **Geoscape** and/or **Basescape** (not F6) that writes **`companion-base-intelligence.json`** next to the existing companion directory (same parent as `tactical-live.yaml` when `OPENXCOM_COMPANION_SNAPSHOT_PATH` is set). Implementation should mirror the tactical stack: **`CompanionBaseIntelligenceExportCore`** (pure, unit-tested) + thin **`CompanionBaseIntelligenceExport::tryExport`** (engine + `Mod` + `SavedGame`).

**Size:** Expect **~25–120 KiB** JSON for typical mid-campaign saves if you export **aggregated stores** and **roster summaries**; **150–400 KiB** for late-game hoarding; cap at **512 KiB–1 MiB** with explicit truncation metadata if needed. This is **much smaller** than tactical terrain (which can approach **256 KiB** alone).

---

## What exists today (Companion)

| Mechanism | Scope | Reusable for base export? |
|-----------|--------|---------------------------|
| `OPENXCOM_COMPANION_SNAPSHOT_PATH` | Battlescape YAML path | **Yes** — use `CompanionBriefingTestSupport::parentDirectoryOfSnapshotPath` for output dir |
| F6 / `CompanionBriefingRequest` | Tactical snapshot + briefing | **No** — keep separate trigger |
| `SavedGame::getCompanionCampaignId()` | Campaign identity in save YAML | **Yes** — primary campaign key |
| `companion-soldier-control.json` | Tactical AI assignments | **Optional cross-ref** only; not a geoscape export |
| Node relay / `buildRelayPayload` | Tactical GitHub | **Out of scope** for your stated workflow |

---

## Proposed operator workflow

1. Finish mission, land on **Geoscape** (or review in **Basescape**).
2. Press a dedicated key (proposal: **F7** or **Ctrl+Shift+B** — configurable later; **not F6**).
3. Engine writes **`companion-base-intelligence.json`** atomically beside `local/m0/` (or snapshot parent dir).
4. You paste or attach that file for strategic discussion — **no automatic upload**.

Optional later: sidecar “publish once” for GitHub — **not required** for the use case you described.

---

## Where to hook in the engine

| Location | Why |
|----------|-----|
| `GeoscapeState.cpp` | Primary post-mission screen; natural “strategic export” moment |
| `BasescapeState.cpp` | Export while auditing bases; same exporter, same file |
| Avoid `BattlescapeState` / F6 | Keeps battlescape vs geoscape contracts separate |

**Pattern to copy**

- Gate: companion dir configured (`OPENXCOM_COMPANION_SNAPSHOT_PATH` or a dedicated `OPENXCOM_COMPANION_BASE_EXPORT_PATH` directory).
- Gate: not `_save->getDebugMode()` if you want parity with tactical commands (optional for export-only).
- Build JSON in core; write via existing atomic write helper (`CompanionSnapshotExportCore::writeUtf8FileAtomically` or sibling).
- Log one line on success/failure (`Logger`).

**New symbols (proposed)**

- `engine/OpenXcom/src/Engine/CompanionBaseIntelligenceExportCore.h/.cpp` — schema, gating, serialization, size cap.
- `engine/OpenXcom/src/Engine/CompanionBaseIntelligenceExport.h/.cpp` — `tryExport(SavedGame *save, Mod *mod, const ExportContext &ctx)`.
- `engine/OpenXcom/src/test/companion_base_intelligence_export_test.cpp` — fixture `SavedGame` snippets, spoiler-leak tests.

---

## Identity block (wrong-campaign prevention)

Include at top of every export:

| Field | Source | Notes |
|-------|--------|--------|
| `schema_version` | `2` (BI1+) | v2: `bases[].id` and every `base_id` use stable 1-based index into `SavedGame::getBases()`; v1 wrongly echoed `Target::getId()` (often 0 for all bases). |
| `exported_at_ms` | Wall clock | Same pattern as tactical markers |
| `campaign_id` | `SavedGame::getCompanionCampaignId()` | Already persisted under `companion.campaign_id` in save YAML |
| `game_date` | `SavedGame::getTime()` | e.g. `{ year, month, day, hour, minute }` |
| `save_display_name` | `SavedGame::getName()` | From save header (`name:` in `.sav`) |
| `save_file_hint` | **See gap below** | Filename stem if known |
| `save_content_sha256` | Optional hash of on-disk `.sav` bytes | Strongest “this exact save” binding |
| `difficulty`, `ironman`, `months_passed` | `SavedGame` | Context for advice |
| `mods` | From save header | Mod compatibility |

**Gap:** `Game` does **not** reliably retain the full path of the loaded `.sav` in memory (only name + ironman autosave naming in `Game.cpp`). For a robust **save identifier**:

- **P0:** `save_display_name` + `campaign_id` + `game_date` + `rng`/hash of `SavedGame::getAllIds()` snapshot (cheap fingerprint).
- **P1:** On load/save, persist `companion.last_save_filename` into save YAML (small Companion extension).
- **P1 alt:** Operator sets `OPENXCOM_COMPANION_USER_DIR`; exporter scans for `{save_display_name}.sav` and hashes it read-only.

---

## Category-by-category: engine source → export → discovery gate

Status: **MISSING** = not exported today; **FEASIBLE** = data + gating clear in engine.

### Finances

| Data | Engine API | Player knows? | Export |
|------|------------|---------------|--------|
| Current funds | `getFunds()` | Yes | **FEASIBLE** |
| Monthly income / expense history | `getIncomes()`, `getExpenditures()`, `getFundsList()`, `getMaintenances()` | Finance graph | **FEASIBLE** — last N months |
| Country funding | `getCountries()`, `Country::getFunding()`, `getPact()` | Geoscape funding UI | **FEASIBLE** |
| Total maintenance | `getBaseMaintenance()`, per-base maintenance via facilities | Base info | **FEASIBLE** |

**Symbols:** `SavedGame.h` / `SavedGame.cpp`; `Country.h`.

**Spoiler risk:** Low — funding is player-facing.

---

### Facilities

| Data | Engine API | Export |
|------|------------|--------|
| Bases list | `getBases()` | **FEASIBLE** — id, name, lon/lat, marker |
| Built facilities | `Base::getFacilities()`, `BaseFacility::getRules()`, `(x,y)` | **FEASIBLE** |
| Under construction | `BaseFacility::getBuildTime()` (>0 days remaining) | **FEASIBLE** — completion = game days via daily `build()` |
| Queued construction | Player build queue in basescape UI | **FEASIBLE** — facilities with `buildTime > 0` |

**Symbols:** `Base.h`, `BaseFacility.cpp`.

**Spoiler risk:** Low.

---

### Research

| Data | Engine API | Discovery gate |
|------|------------|----------------|
| Completed topics | `getDiscoveredResearch()` or `isResearched(id, false)` | **Only completed** — do **not** dump unresearched mod tree |
| Available to start | `getAvailableResearchProjects(projects, mod, base, false)` | **Same as UI** — respects deps/requirements |
| Hidden “protected unlocks” | `hasUndiscoveredProtectedUnlock(r, mod)` | **Exclude** topics UI hides (see `GeoscapeState.cpp` ~1668) |
| Active projects | `Base::getResearch()` → `ResearchProject` | **FEASIBLE** — assigned scientists, spent/cost, progress string |
| Scientist counts | `Base::getScientists()`, `getAvailableScientists()` | **FEASIBLE** |

**Symbols:** `SavedGame.cpp` (`getAvailableResearchProjects`, `hasUndiscoveredProtectedUnlock`); `ResearchProject.h`.

**Spoiler risk:** **Medium if implemented wrong** — never export `Mod::getResearch()` wholesale or `_activeMissions` research triggers. Stick to **`getDiscoveredResearch` + per-base `getAvailableResearchProjects`**.

---

### Manufacturing

| Data | Engine API | Export |
|------|------------|--------|
| Active jobs | `Base::getProductions()` → `Production` | **FEASIBLE** — rule id, engineers, time spent, amount |
| Available products | `getAvailableProductions(productions, mod, base)` | **FEASIBLE** — UI-equivalent |
| Costs / progress | `Production::getRules()`, `step` state via saved fields | **FEASIBLE** |

**Symbols:** `Production.h`, `SavedGame::getAvailableProductions`.

**Spoiler risk:** Low if using availability helper (requires research).

---

### Aircraft

| Data | Engine API | Export |
|------|------------|--------|
| Craft roster | `Base::getCrafts()` | **FEASIBLE** |
| Fuel, damage, status | `Craft::getFuel()`, `getDamage()`, `getStatus()` | **FEASIBLE** |
| Weapons / ammo on craft | `Craft::getWeapons()`, craft `ItemContainer` | **FEASIBLE** — aggregate by item type |
| Interception order / mission flag | `getInterceptionOrder()`, mission flags | **FEASIBLE** |
| In transit | `Craft` on globe vs `_base` | **FEASIBLE** |

**Symbols:** `Craft.h`.

**Spoiler risk:** Low.

---

### Personnel

| Data | Engine API | Discovery / privacy gate |
|------|------------|---------------------------|
| Roster | `Base::getSoldiers()`, `SavedGame::getSoldier(id)` | Live soldiers only |
| Rank, stats, missions, kills | `Soldier` getters | **FEASIBLE** |
| Wounds / recovery | `getWoundRecovery()` | **FEASIBLE** |
| Psi training flag | `isInPsiTraining()` | **FEASIBLE** |
| Psi strength/skill visibility | `calcStatString(..., psiStrengthEval && isResearched(psiRequirements))` | **Gate psi fields** like UI — hide until psi lab research |
| Assignments | Craft assignment, base location | **FEASIBLE** |
| Companion AI flag | `getCompanionSoldierOwnership(id)` | **Optional** — strategic “who is bot-controlled” |

**Symbols:** `Soldier.h`, `Soldier.cpp` (~147 psi gating).

**Spoiler risk:** Low with psi gating; do not export **dead soldiers’ pre-death secrets** beyond memorial stats unless desired (`getDeadSoldiers()` — optional section).

---

### Inventory (stores)

| Data | Engine API | Export |
|------|------------|--------|
| Base stores | `Base::getStorageItems()` → `ItemContainer::getContents()` | **FEASIBLE** — map `itemType → qty` |
| Craft/HWP ammo | per-craft containers | **FEASIBLE** |
| Stores capacity | `Base` storage helpers | **FEASIBLE** — used vs capacity |

**Symbols:** `ItemContainer.h`.

**Spoiler risk:** Low — player owns stores. **Size risk:** high if you duplicate per-item metadata; use **type + quantity** only (no rule blobs).

---

### Geoscape (detected world state)

| Entity | Include when | Engine check |
|--------|--------------|--------------|
| UFO | Radar/hyperwave contact | `Ufo::getDetected()` / `getHyperDetected()` |
| Mission sites | Shown on globe | `MissionSite::getDetected()` |
| Alien bases | Located | `AlienBase::isDiscovered()` |
| X-COM bases | Always | All `Base` entries |
| Waypoints | Player-placed | `Waypoint` list (player-created) |

**Do not export (spoiler / omniscience)**

- Full `SavedGame::getAlienMissions()` — internal mission graph, not equal to player map.
- Undetected UFOs (`getDetected() == false`).
- Alien strategy internals (`AlienStrategy`) — future spawn logic.
- `_discovered` research **candidates** not yet in `getAvailableResearchProjects`.

**Symbols:** `Ufo.h`, `MissionSite.h`, `AlienBase.h`; filtering patterns in `GeoscapeState.cpp` (~1313, ~1470).

**Spoiler risk:** **High** if mission vectors exported unfiltered — treat as **blocklist default**.

---

### Logistics

| Data | Engine API | Export |
|------|------------|--------|
| Transfers in flight | `Base::getTransfers()` | **FEASIBLE** — hours remaining, type, item/qty/soldier/craft |
| Purchases | Becomes `Transfer` after `PurchaseState` | Covered by transfers |
| Deliveries | `Transfer` not `_delivered` | **FEASIBLE** |

**Symbols:** `Transfer.h`.

**Spoiler risk:** Low.

---

## Suggested JSON shape (sketch)

```json
{
  "schema_version": 1,
  "identity": {
    "campaign_id": "<32 hex>",
    "save_display_name": "2nd-mission-win",
    "game_date": { "year": 1999, "month": 1, "day": 13, "hour": 6, "minute": 51 },
    "save_fingerprint": "<optional sha256 or ids hash>"
  },
  "finances": { "funds": 1523000, "incomes": [], "expenditures": [], "countries": [] },
  "bases": [ { "name": "...", "facilities": [], "research": [], "production": [], "storage": {}, "transfers": [] } ],
  "personnel": { "by_base": [], "totals": {} },
  "aircraft": [],
  "research": { "completed": ["STR_..."], "available_by_base": {}, "notes": "UI-parity only" },
  "geoscape": { "ufos": [], "mission_sites": [], "alien_bases": [] },
  "export_meta": { "truncated": false, "bytes": 84210, "engine_build": "..." }
}
```

Use **rule IDs** (`STR_*`) not localized strings so mods stay stable; optional parallel `display_name` if you call `Language` at export time.

---

## File size estimate

### Reference save sizes (read-only, local `user/xcom1`)

| Save | `.sav` bytes (YAML) |
|------|---------------------|
| `2nd-mission-win.sav` | ~35,758 |
| `after-the-fall.sav` | ~30,815 |

Intelligence JSON is a **subset** of save content (no map tiles, no battle, no full alien AI state).

### Rough model

| Component | Early campaign | Mid / late (many bases/soldiers/items) |
|-----------|----------------|----------------------------------------|
| Identity + finances | 1–3 KiB | 2–8 KiB |
| Facilities (≤8 bases × ~30 facs) | 5–15 KiB | 20–60 KiB |
| Personnel (~20–80 soldiers × ~350 B) | 7–28 KiB | 30–120 KiB |
| Storage (aggregated `{type,qty}`) | 2–10 KiB | 20–150 KiB |
| Craft (≤20) | 3–10 KiB | 10–40 KiB |
| Research lists | 2–8 KiB | 8–25 KiB |
| Geoscape contacts | 1–5 KiB | 5–20 KiB |
| Logistics (transfers) | 1–5 KiB | 5–30 KiB |
| **Total (typical)** | **~25–80 KiB** | **~80–400 KiB** |

**Worst case:** Many bases with **thousands** of distinct item stacks — still far below a full `.sav` if you only emit `{itemType, quantity}` and cap distinct keys (e.g. max 2000 lines → ~80 KiB items alone).

**Recommended cap:** **512 KiB** default (2× headroom over typical late game), optional **1 MiB** with `export_meta.truncated` sections — still below tactical **256 KiB YAML cap** concern because base export has **no terrain blob**.

Comparison:

| Artifact | Typical size |
|----------|----------------|
| `tactical-live.yaml` (production sample) | **~100 KiB** (terrain-heavy) |
| `companion-base-intelligence.json` (proposed) | **~50–150 KiB** most campaigns |

---

## Discovery / spoiler checklist (acceptance tests)

Automated tests should assert **negative cases**:

1. Undetected UFO in save → **absent** from `geoscape.ufos`.
2. Unresearched topic not in `getAvailableResearchProjects` → **absent** from `available`.
3. Completed research with hidden unlock chain → **no** leaked unlock names (`hasUndiscoveredProtectedUnlock`).
4. Soldier psi stats before psi requirements researched → **redacted** or omitted.
5. `getDebugMode() == true` → export disabled or flagged `debug_untrusted`.
6. `getAlienMissions()` → **never** serialized wholesale.

---

## Implementation roadmap (priority)

| Priority | Work |
|----------|------|
| **P0** | `CompanionBaseIntelligenceExportCore` + manual Geoscape hotkey + atomic JSON write beside snapshot dir |
| **P0** | Identity block: `campaign_id`, `game_date`, `save_display_name`, optional save SHA |
| **P0** | Finances, bases/facilities, storage aggregates, personnel (with psi gate), craft, active research/manufacturing, transfers |
| **P0** | Geoscape section with **detected-only** filters |
| **P1** | Basescape same hotkey; `save_content_sha256`; persist last save path in companion save block |
| **P1** | Node **validator** (like `tactical-publish.cjs`) for schema sanity — still no relay required |
| **P2** | Optional GitHub publish path mirroring F6 (only if you want remote agents later) |
| **P2** | Localization of display names; dead soldier roster section |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Exporting full research tree | Use `getDiscoveredResearch` + `getAvailableResearchProjects` only |
| Leaking spawn script via alien missions | Never export raw `getAlienMissions()` |
| Psi / Cydonia spoilers | Mirror UI gates; optional `spoiler_policy: "strict"` flag in schema |
| Wrong campaign discussion | `campaign_id` + save fingerprint in every file; reject stale files in chat by convention |
| Huge JSON | Aggregate items; cap list lengths; `export_meta.truncated` |
| Debug mode | Block export (match tactical snapshot policy) |

---

## Relation to battlescape Companion

| Concern | Battlescape | Base intelligence (proposed) |
|---------|-------------|------------------------------|
| Trigger | F6 + idle export | **Manual key on Geoscape/Basescape** |
| File | `tactical-live.yaml` | `companion-base-intelligence.json` |
| Relay | GitHub tactical + commands | **None** (local file for human/LLM paste) |
| Freshness binding | `snapshot_sha256`, `state_version` | **Save/campaign identity** — no turn-by-turn sync needed |
| Commands back | MOVE/KNEEL/SNAP | **None** — strategic discussion only |

---

*End of audit.*
