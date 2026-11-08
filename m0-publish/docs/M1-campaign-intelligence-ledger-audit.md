# M1 Campaign Intelligence Ledger Audit

**Date:** 2026-11-05  
**Scope:** Read-only design audit for a **persistent campaign knowledge** system—separate from F6 tactical snapshots and separate from geoscape **base intelligence** export (audit 2).  
**Related docs:** [M1-battlescape-capability-audit.md](./M1-battlescape-capability-audit.md), [M1-base-intelligence-export-audit.md](./M1-base-intelligence-export-audit.md).

**Status legend:** **SUPPORTED** / **PARTIAL** / **MISSING** / **UNVERIFIED** (Companion vs engine).

---

## Executive summary

Your three-layer model is the right split:

| Layer | Job | Companion today |
|-------|-----|-----------------|
| **1. Tactical snapshot (F6)** | What is happening *now* | **SUPPORTED** (YAML v4/v5, relay) |
| **2. Campaign intelligence (persistent)** | What we have *learned* across missions | **MISSING** — no durable ledger |
| **3. Equipment rules (mostly static)** | What gear *can* do, gated by entitlement | **PARTIAL** — only implicit TU/action hints in snapshot; **no** damage-type catalog |

The engine **always** knows alien HP, TU, armor modifiers, and full UFOpaedia text. The Companion must **not** mirror that into intelligence automatically. The ledger should store **player-entitled facts** plus **explicit observations** with **confidence** and **`null` for unknown stats**.

**Recommendation:** Add `companion-campaign-intelligence.json` (sidecar) **and** a `companion.intelligence` block in the **save YAML** (source of truth), keyed by **`campaign_id`**. Update the ledger at **mission boundaries** (debrief / return to geoscape), not on every F6. Keep implementation **out of** immediate combat command work (MOVE/KNEEL/SNAP).

---

## What F6 actually exports today (verified)

### Player soldiers (live roster)

| Information | Status | Source |
|-------------|--------|--------|
| Position, health, TU | **SUPPORTED** | `CompanionSnapshot.cpp` → `appendFriendlyTacticalDetails` |
| Equipped weapons, ammo, belt items | **SUPPORTED** | `hands`, `inventory` (max 24 non-hand entries) |
| Kneel, active hand | **SUPPORTED** | snapshot fields |
| Firing modes (as affordances) | **PARTIAL** | `actionCosts.hands.*.actions[]` — ids `snap`, `aimed`, `auto`, `launch`, `throw`, `prime`, `melee` + `tuCost`, `usable` |
| Weapon damage / damage type | **MISSING** | Not in snapshot; `RuleItem::getDamageType()` / power not serialized |
| Chambered ammo type | **SUPPORTED** | `loaded.ammoType`, `rounds` |

### Visible non-friendly units

| Information | Status | Notes |
|-------------|--------|--------|
| Position on map | **SUPPORTED** | `shouldIncludeUnit` → visible or player faction |
| Faction shells | **SUPPORTED** | `id`, `faction`, `originalFaction`, `position` only |
| Alien type / race / rank | **MISSING** | `BattleUnit::getType()` **not** exported for hostiles |
| Health, TU, armor | **MISSING** | By design in current exporter |
| Weaknesses / resistances | **MISSING** | `Armor::_damageModifier[]` never exposed |

**Symbol:** `appendUnit()` — friendly branch only calls `appendFriendlyEquipment` / `appendFriendlyActionCosts`.

### Event log (current battle only)

| Information | Status | Notes |
|-------------|--------|--------|
| Player weapon fire events | **SUPPORTED** | `eventLog.events[]`, type `weapon_fired` |
| Target cell, weapon type, fire mode | **SUPPORTED** | `CompanionEventLog.cpp` |
| Hit result / damage dealt / kills | **MISSING** | Log records **intent**, not outcome |
| Session scope | **Battle only** | `CompanionEventLog` is in-memory; **not** in savegame YAML |

**Conclusion:** Your table is accurate. Conversational memory + F6 is **not** a substitute for a campaign ledger.

---

## What the game already persists (engine — not Companion)

These are inputs to **derive** intelligence, not to dump wholesale:

| Source | Useful for ledger | Spoiler risk if copied blindly |
|--------|-------------------|--------------------------------|
| `SavedGame::getDiscoveredResearch()` | Completed research ids | Low if ids only |
| `Ufopaedia::isArticleAvailable(save, article)` | Same gate as UI (`isResearched(article->_requires)`) | Low for **ids**; high if full article text |
| `BattleUnitKills` on soldiers (`type`, `race`, `weapon`, `weaponAmmo`, `status`, `turn`) | Encounter observations | Medium — post-mission **facts player earned** |
| `MissionStatistics` | Mission history summary | Low |
| `Mod::getUfopaediaArticle`, `RuleItem`, `Armor` | Equipment/alien **rules** | **High** if unfiltered |

**Important:** Kill diary data can include **weapon + ammo type** used against **alien type/race** — ideal for **observation** edges (“we killed a Muton with incendiary”) without asserting **weakness**.

---

## Three information sources (target architecture)

```
┌─────────────────────┐     ┌──────────────────────────────┐     ┌─────────────────────────┐
│ F6 tactical YAML    │     │ companion-campaign-          │     │ companion-equipment-    │
│ (ephemeral)         │     │ intelligence.json            │     │ rules.json (optional)   │
│ now / turn / map    │     │ (persistent, campaign-scoped)│     │ (static, regen on unlock)│
└─────────────────────┘     └──────────────────────────────┘     └─────────────────────────┘
         │                              │                                      │
         │                              │                                      │
    no alien stats                  null until known                    isResearched() gate
    no ledger merge                 confidence + source                  RuleItem subset only
```

### 1. Tactical snapshot — unchanged role

Do **not** embed the full ledger into F6. Optional future: `campaign_id` + `intelligence_revision` pointer in snapshot **metadata only** (a few bytes) so the AI knows which ledger file to load.

### 2. Campaign intelligence ledger — **new**

**Proposed path:** beside companion dir (same parent as `OPENXCOM_COMPANION_SNAPSHOT_PATH`):

`companion-campaign-intelligence.json`

**Authoritative copy:** embed under save YAML:

```yaml
companion:
  campaign_id: "<32 hex>"
  intelligence:
    schema_version: 1
    # ... ledger body or hash + external file policy
```

On `SavedGame::save()`, write intelligence from memory; on load, hydrate sidecar file for tools/LLM.

**Campaign isolation:** Ledger load/save must match `SavedGame::getCompanionCampaignId()`. New campaign → empty ledger. **Never** copy ledger file between saves without matching `campaign_id`.

### 3. Equipment rules — **separate artifact**

**Proposed path:** `companion-equipment-rules.json`

- Regenerated when research unlocks change (same hooks as ledger refresh).
- Include only items/armor whose `RuleItem` / `Armor` requirements pass `SavedGame::isResearched(..., false)`.
- Fields: `itemType`, damage type enum/name, power, clip size, TU costs (snapshot parity), compatible ammo types — **no** unresearched mod catalog.

**Size:** typically **15–40 KiB** (see below). Not sent every F6.

---

## Ledger schema (conceptual)

Design goals: **null = unknown**, **confidence ≠ proof**, **source** auditable.

```json
{
  "schema_version": 1,
  "campaign_id": "a1b2…",
  "game_date_at_last_update": { "year": 1999, "month": 6, "day": 12 },
  "intelligence_revision": 17,

  "research_completed": [
    { "id": "STR_ALIEN_ORIGINS", "completed_at_game_date": { "month": 3, "day": 1 } }
  ],

  "aliens": {
    "STR_MUTON": {
      "display_key": "STR_MUTON",
      "research_completed": true,
      "ufopaedia_article_id": "STR_MUTON_UFOPAEDIA",
      "known_max_health": null,
      "known_max_tu": null,
      "known_weaknesses": [
        {
          "damage_type": "DT_INCENDIARY",
          "confidence": "confirmed",
          "source": "research",
          "evidence_id": "STR_MUTON_UFOPAEDIA"
        }
      ],
      "observations": [
        {
          "observation_id": "obs-0042",
          "kind": "kill",
          "mission_statistics_id": 8,
          "weapon": "STR_INCENDIARY_LAUNCHER",
          "ammo": "STR_INCENDIARY_AMMO",
          "confidence": "observed",
          "note": "Target killed; does not alone prove weakness"
        }
      ]
    }
  },

  "encounters": [
    {
      "mission_id": 8,
      "type": "STR_TERROR_MISSION",
      "alien_race": "STR_MUTON",
      "success": true,
      "game_date": { "month": 6, "day": 12 }
    }
  ],

  "operator_notes": []
}
```

### Confidence model (recommended)

| Level | Meaning | Typical source |
|-------|---------|----------------|
| `confirmed` | Same as in-game UFOpaedia / finished research | `Ufopaedia::isArticleAvailable`, completed research unlock strings |
| `reported` | Engine-released stat from research (not yet in ledger) | Parsed from entitled article/rule hooks only |
| `observed` | We saw an event once | Single kill / hit log |
| `repeated` | Pattern across N missions | Aggregator (e.g. ≥3 kills with same damage type) |
| `contradicted` | New research overrides old belief | Revision history entry |

**Rule:** Incendiary kill → **`observed`** only unless research confirms **`confirmed`**. Your Muton / harsh-language example fits **`confirmed` + `source: research`** vs **`null`** stats.

### Fields that must stay `null` until entitled

| Field | When set |
|-------|----------|
| `known_max_health`, `known_max_tu` | Only after research/article explicitly grants (or optional **repeated** heuristic policy you approve) |
| Armor face values | Same |
| Damage modifiers | **`confirmed`** from research/UFOpaedia-derived facts, not from `Armor::getDamageModifier()` alone |

**Never** populate from visible battlescape `BattleUnit::getHealth()` into the **persistent** ledger automatically (snapshot may show current HP for *tactical* turns — different contract).

---

## Where to implement (engine hooks)

Keep **`CompanionCampaignIntelligenceCore`** (pure) + **`CompanionCampaignIntelligenceStore`** (I/O) separate from `CompanionSnapshot` and `CompanionCommandRuntime`.

| Event | Hook location | Ledger action |
|-------|---------------|---------------|
| Research completed | `SavedGame::addFinishedResearch` / end-of-day geoscape processing | Add research id; merge **confirmed** weaknesses from unlock graph; bump `intelligence_revision` |
| UFOpaedia-equivalent unlock | After research, via `Mod` + `Ufopaedia::isArticleAvailable` | Attach article ids; extract **allowed** structured fields (not prose) |
| Mission end | `DebriefingState` after statistics finalized | Append `encounters[]`; ingest soldier `BattleUnitKills` as **observations** |
| Return to geoscape | `GeoscapeState` init after battle | Atomic write sidecar JSON + optional notify |
| Manual refresh | Geoscape hotkey (same family as base export audit) | Rebuild from save without playing a mission |
| F6 | **No full rebuild** | Optional revision pointer only |

**Battle-time incremental updates (optional P2):** hook `CompanionEventLog` extension to record **hit/kill outcomes** — requires new engine instrumentation (`ProjectileFlyBState` / damage application). Not required for v1 if debrief kill diary is enough.

**Do not** hook GitHub relay for ledger v1 — local/save-bound matches your workflow.

---

## UFOpaedia / research integration (without encyclopedia dump)

| Approach | Verdict |
|----------|---------|
| Export all `ArticleDefinition` text | **Reject** — huge, spoilers, duplicates UI |
| Export list of **available** article ids | **Good** — `getAvailableArticles` + `isArticleAvailable` |
| Export structured **facts** parsed from entitled item/armor/ufo articles | **Good P1** — damage type, power, clip, size |
| Mirror `_discovered` research list | **Good P0** — already player progress |

**Symbols:** `Ufopaedia.cpp` (`isArticleAvailable`, `getAvailableArticles`); `SavedGame::getDiscoveredResearch()`.

For alien weaknesses, prefer **research unlock strings** and UFOpaedia UFO/alien articles over raw `Armor` modifiers until research says otherwise.

---

## Equipment rules file (layer 3 detail)

Build when:

- Campaign load
- Research completed
- Manual “refresh companion data” key

**Include per entitled item:**

- From `RuleItem`: `getType()`, `getDamageType()`, power, accuracy modes, TU, clip, compatible ammo, `getRequirements()` (already satisfied)
- From `Armor`: armor values, `getDamageModifier()` **only if** armor is researched/equippable

**Exclude:**

- Unresearched craft weapons, alien-only items not yet seen (optional: include **seen** alien weapons after first recovery — policy flag)

**Relation to snapshot `actionCosts`:** Snapshot = **current soldier can afford / usable now**; rules file = **reference** for planning across missions.

---

## File size estimates

### `companion-campaign-intelligence.json`

| Section | Early campaign | Late campaign (many missions) |
|---------|----------------|-------------------------------|
| Identity + research list | 2–5 KiB | 8–15 KiB |
| Alien entries (~15–40 types touched) | 5–15 KiB | 20–60 KiB |
| Observations (kill diary-derived) | 2–10 KiB | 30–120 KiB if unbounded |
| Encounters (`MissionStatistics` summaries) | 1–5 KiB | 10–40 KiB |
| Operator notes | user-dependent | user-dependent |
| **Typical total** | **~15–40 KiB** | **~60–200 KiB** |

**Caps (recommended):**

- Max **500** observations per alien type (FIFO or merge)
- Max **200** encounter rows
- Max file **256 KiB** with `truncated: true` metadata

Still **far below** dumping UFOpaedia (full mod article set can be **multiple MiB** of text).

### `companion-equipment-rules.json`

| Scope | Size |
|-------|------|
| ~80 entitled items × ~150–250 B | **12–20 KiB** |
| Heavy modded run (~400 items) | **40–80 KiB** |

Regenerate only when unlock set changes — not every F6.

---

## Current vs desired (your table, audited)

| Information | Current Companion status | Ledger / rules target |
|-------------|-------------------------|------------------------|
| Soldier positions, TU, health | **SUPPORTED** (F6) | Stay in F6 only |
| Equipped weapons and ammunition | **SUPPORTED** | F6 + equipment rules reference |
| Inventory / action costs | **PARTIAL** | F6 + rules file |
| Weapon firing modes | **PARTIAL** (TU/usability, not damage) | Rules file + F6 affordances |
| Weapon damage / damage type | **MISSING** | **Equipment rules** when researched |
| Visible alien locations | **SUPPORTED** | F6 |
| Alien health, TU, armor, weaknesses | **MISSING** (tactical + ledger) | Ledger: **null** until confirmed; optional battle snapshot never writes to ledger |
| Completed research / UFOpaedia | **MISSING** in Companion | Ledger **research_completed** + article ids |
| Cross-mission learning | **MISSING** | Ledger **observations** + **encounters** |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Engine stats leak into “intelligence” | Core layer rejects writes unless `source` is research/ufopaedia/observation policy |
| Kill = weakness inference | Default confidence **`observed`**; separate **`confirmed`** path |
| Wrong campaign | `campaign_id` on every read/write; reject mismatch |
| LLM fabricates ledger entries | Optional `operator_notes` only; engine-generated entries require `source` ≠ `chat` or dual-sign |
| Save tampering | Treat like save game; optional SHA in export metadata |
| Duplicating base export | Ledger = **knowledge**; base intelligence audit = **resources** — cross-link ids only |
| Scope creep into F6 | No full ledger in YAML; revision pointer only |

---

## Implementation roadmap (separate from combat P0)

| Phase | Deliverable |
|-------|-------------|
| **P0** | Schema + `CompanionCampaignIntelligenceCore` tests; save YAML persistence; `research_completed` sync from `_discovered` |
| **P0** | Debrief hook: `encounters` + kill observations (`BattleUnitKills`) with **`observed`** confidence |
| **P1** | UFOpaedia/article id index for entitled articles; promote research-granted facts to **`confirmed`** |
| **P1** | `companion-equipment-rules.json` generator (research-gated `RuleItem` / `Armor` subset) |
| **P1** | Sidecar mirror + geoscape manual refresh key |
| **P2** | Hit/kill battle hooks; **`repeated`** / **`contradicted`** aggregators |
| **P2** | Optional relay publish of ledger (explicit opt-in) — **not** required for your stated use case |
| **P3** | Operator merge tool / validated note append |

**Explicitly defer:** Putting ledger bodies inside GitHub `m0/state.json` tactical payload; auto-export alien HP from LOS; full UFOpaedia text.

---

## How you’d use it (eight missions later)

1. You finish a mission; engine updates **save-embedded ledger** + sidecar JSON at debrief/geoscape.
2. You optionally export **base intelligence** (audit 2) for finances/aircraft.
3. You press F6 when you need **tactical now**.
4. For strategy chat, you attach **`companion-campaign-intelligence.json`** (and optionally equipment rules) — not the wiki, not full F6 history.
5. Assistant reads **`STR_MUTON`** entry: confirmed weaknesses from research, **`null`** TU/health until unlocked, observations from past missions.

Conversational memory becomes **interpretation**; the ledger becomes **record**.

---

*End of audit.*
