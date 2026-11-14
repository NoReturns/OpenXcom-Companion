# ASTER-M1-C9-C10-RELIABILITY-RECONCILIATION-01

**Date:** 2026-11-14  
**Mode:** Read-only reconciliation — no production edits, builds, launches, commits, or pushes.  
**Parent:** [ASTER-M1-POST-MISSION-RELIABILITY-AUDIT-01](./ASTER-M1-POST-MISSION-RELIABILITY-AUDIT-01.md) (rows **C9**, **C10**)  
**Related:** [ASTER-M1-STRATEGIC-INTEL-COVERAGE-01](./ASTER-M1-STRATEGIC-INTEL-COVERAGE-01.md), [ASTER-M1-S11-PURCHASING-TIMING-AUDIT-01](./ASTER-M1-S11-PURCHASING-TIMING-AUDIT-01.md), [ASTER-M1-B8-ACCURACY-RECONCILIATION-01](./ASTER-M1-B8-ACCURACY-RECONCILIATION-01.md)

---

## 1. Executive summary

| Item | Original POST-MISSION framing | Reconciled verdict |
|------|------------------------------|--------------------|
| **C9** | “Geoscape SEND **removal** (future)” — scoped hide on geoscape only | **Capability:** **CLOSED** — Geoscape **SEND** publishes **strategic** base intelligence without tactical play. **Removal UX:** **not implemented** — remains optional **P2** product work, **not** a production defect. |
| **C10** | No **unified AAR JSON** tactical → geoscape; no `DebriefingState` export | **CONDITIONAL** — rich **separate** channels exist (tactical snapshot, strategic BI, command results, perception ledger); **single cross-layer AAR** still absent by **design scope**, not a silent failure. |

**Cross-closeout:** B4/B5/B6/B7 accepted findings are **not reopened**. B8 and S11 remain **CONDITIONAL** on reporting/semantics only; they do **not** block C9/C10 closure.

**No new contradictory live evidence** was required for this pass; reconciliation is source + retained artifacts + existing test harnesses.

---

## 2. Original C9 and C10 findings (verbatim intent)

### 2.1 C9 (POST-MISSION table)

| Field | Text |
|-------|------|
| **Item** | Geoscape SEND removal (**future**) |
| **Verified behavior (2026-11-14)** | Shared `CompanionOnDemandRelayOverlay`; Geoscape `onStrategicSendPressed` **identical to Base**; **RETRIEVE hidden**, **SEND + status still shown** on Geoscape |
| **Suspected defect** | Removal must scope `interfaceId == "geoscape"` only |
| **Severity** | P2 |
| **Acceptance (plan §4)** | P2-1: Geoscape SEND removal scoped — **Base SEND + strategic publish unchanged** |

**Interpretation for reconciliation:** The backlog row is a **future UI scope change**, not a report that Geoscape SEND is broken. The implied acceptance for **current** behavior is: Geoscape can push **strategic** intelligence; **tactical** retrieve/commands stay on battlescape.

### 2.2 C10 (POST-MISSION table)

| Field | Text |
|-------|------|
| **Item** | After-action / end-of-month reporting |
| **Verified behavior** | Tactical: `perceptionLog`, `rosterCasualtySummary`; **no mission score block**. Strategic SEND: finances, countries, roster; **no `DebriefingState` export** |
| **Suspected gap** | No unified AAR JSON across tactical → geoscape |
| **Severity** | P2 |
| **Acceptance (plan §4)** | P2-2: **AAR export spec** — engine debrief hook design only |

**Interpretation:** C10 is a **completeness / architecture** gap for cooperative “one briefing,” not a claim that existing exports are wrong.

---

## 3. Part A — C9 current implementation evidence

### 3.1 UI: Geoscape vs Basescape vs Battlescape

| Surface | `interfaceId` | SEND click | RETRIEVE visible | Auto-retrieve |
|---------|---------------|------------|------------------|-----------------|
| Geoscape | `"geoscape"` | Strategic | **Hidden** | No |
| Basescape | `"basescape"` | Strategic | Hidden | No |
| Battlescape | `"battlescape"` | Tactical (F6 briefing path) | **Visible** | Yes |

**Retrieve hide** — `CompanionOnDemandRelayOverlay.cpp` ~366–368: `g_hideRetrieveUi = iface == "basescape" || iface == "geoscape"`.

**Geoscape SEND handler** — `GeoscapeState.cpp` ~2779–2782:

```2779:2782:engine/OpenXcom/src/Geoscape/GeoscapeState.cpp
void GeoscapeState::btnCompanionSendClick(Action *)
{
	CompanionOnDemandRelayOverlay::onStrategicSendPressed(
		_game->getSavedGame(), _game->getMod());
}
```

**Basescape** — same call in `BasescapeState.cpp` ~550–552.

**Battlescape** — `BattlescapeState.cpp` ~2446–2448: `requestCompanionBriefing(true)` (tactical snapshot path, **not** `onStrategicSendPressed`).

### 3.2 Strategic SEND pipeline (no tactical YAML)

| Step | Location | Behavior |
|------|----------|----------|
| Enqueue | `CompanionOnDemandRelayOverlay::onStrategicSendPressed` ~618–652 | `tryEnqueueSend("strategic", …)` with live `SavedGame` + `Mod` |
| Export + stage | `CompanionStrategicSendEnqueueSupport.cpp` | Live BI export → `companion-base-intelligence-send.json` + digest marker |
| Request JSON | `CompanionOnDemandRelayCore.cpp` ~161, ~724–861 | `send_scope: "strategic"` |
| Publish | `companion/m0-publish/lib/strategic-publish.cjs` | `m0/base-state.json`; **does not** publish `m0/state.json` |
| Gates | `assessStrategicSendReadiness` | Staged BI, `schema_version === 2`, marker `request_id` + `content_sha256` match |

**F8 vs SEND:** F8 writes canonical `companion-base-intelligence.json`; SEND stages **byte-stable** `-send.json` + marker so F8 overwrite during pending SEND does not corrupt relay (tested in `companion-on-demand-relay-m1-strategic.test.cjs`).

### 3.3 Tactical vs strategic distinction (requirement §3)

| Artifact | Trigger | Relay target | Requires battle |
|----------|---------|--------------|-----------------|
| `tactical-live.yaml` / `m0/state.json` | F6, battlescape SEND, post-command publish | Tactical | **Yes** (or harness) |
| `companion-base-intelligence-send.json` / `m0/base-state.json` | Geoscape/Basescape SEND | Strategic | **No** |

### 3.4 Schema, identity, freshness

| Concern | Evidence |
|---------|----------|
| **Schema** | BI `schema_version: 2` (`CompanionBaseIntelligenceExportCore.cpp`) |
| **Campaign identity** | `identity.campaign_id`, `game_date`, `exported_at_ms` |
| **Relay freshness** | `snapshot_sha256`, `snapshot_id`, `request_id`, `published_at` (`strategic-publish.cjs`) |
| **Session safeguards** | Strategic path **does not** use tactical `commandBinding` / `session_id`; tactical orphan issues (A2) **do not apply** to geoscape-only SEND |
| **Fair play** | BI geoscape section uses detection/discovery gates (per STRATEGIC-INTEL-COVERAGE-01); no alien mission graph |

### 3.5 Tests and live artifacts

| Asset | Coverage |
|-------|----------|
| `companion/m0-publish/test/companion-on-demand-relay-m1-strategic.test.cjs` | NOT_READY, publish to `base-state`, no tactical PUT, marker staleness, digest mismatch, F8/staged isolation |
| `engine/OpenXcom/src/test/companion_on_demand_relay_test.cpp` | Strategic enqueue concurrency, `send_scope` |
| `engine/OpenXcom/src/test/companion_base_intelligence_export_test.cpp` | BI parity, spoilers, purchasing catalog (post–stub era) |
| `local/m0/companion-base-intelligence.json` | Populated sample (~8.7 KiB, schema v2) |
| `local/m0/companion-base-intelligence-send.json` | Staging copy (same campaign in workspace snapshot) |

**Live geoscape SEND e2e** on owner campaign was **not re-run** in this audit; confidence is **implementation + unit/integration tests**, not a new Nov 14 relay trace.

### 3.6 Missing, stale, or misleading (C9 scope)

| Issue | Defect? | Notes |
|-------|---------|-------|
| Geoscape SEND still visible (removal not done) | **No** — matches original “future” row | P2-1 backlog only |
| Stale `base-state.json` if operator skips SEND after save changes | **Ops / freshness** | Same class as tactical stale `state.json` |
| `purchasing.catalog.delivery_hours` ETA semantics | **Doc** (S11) | Not C9 regression |
| `aircraft.on_mission` naming | **Documented** deprecated in `schema_notes` ~423–427 | `away_from_base` preferred |
| STRATEGIC-INTEL-COVERAGE-01 “purchasing stub” | **Doc stale** | Current engine exports full `purchasing.available_by_base` (`CompanionBaseIntelligencePurchaseCatalogCore.cpp` ~201–293) |
| Interception / globe craft position | **Gap** | Still missing per coverage audit — limits **some** geoscape decisions, not SEND reliability |

### 3.7 Part A question: strategic SEND without tactical gameplay?

**Yes**, when snapshot path is configured and Node relay auth succeeds: Geoscape SEND enqueues `send_scope: strategic`, exports BI from live save, publishes `m0/base-state.json` **without** tactical `m0/state.json`. RETRIEVE on geoscape is hidden, avoiding tactical command retrieval on the wrong surface.

---

## 4. Part B — C10 reporting paths and contract

### 4.1 Original intended contract (inferred from POST-MISSION + STRATEGIC-INTEL §9)

- **Operator / Aster** should reason about **mission outcome** (score, casualties, performance) and **campaign transition** (return to geoscape, funding month) in **one** consumable shape.
- **Today:** Mission facts are split across **tactical export**, **perception/event logs**, **command results**, and **strategic BI** — no debrief hook.

### 4.2 Current reporting channels (authoritative layers)

| Layer | Primary files / relay | What it represents |
|-------|----------------------|--------------------|
| **Tactical snapshot** | `tactical-live.yaml`, `m0/state.json` | Binding, units, terrain, `actionCosts`, logs at export instant |
| **Observed battle narrative** | `perceptionLog`, `eventLog` | Fair-play observations; seq-bounded memory |
| **Roster casualty ledger** | `perceptionLog.rosterCasualtySummary` | Engine-attributed KIA/MIA-style episodes (`CompanionSnapshot.cpp` ~1031–1056) |
| **Combat attribution** | `combat_casualty_attributed` (perception) | Visible fatal events; **B4:** civilians/neutrals excluded by policy |
| **Command execution** | `tactical-command-result.json`, relay notify | **Engine-confirmed** REJECTED/COMPLETED/FAILED; consumers in `move-result-consumer.cjs`, `fire-result-consumer.cjs`, `drop-result-ground-placement.cjs` |
| **Post-command tactical publish** | `post-command-tactical-publish.cjs` | Refreshed tactical state after terminal command (not full AAR) |
| **Strategic state** | `companion-base-intelligence.json`, `m0/base-state.json` | Geoscape resources, roster, research, logistics — **no mission debrief** |
| **Relay / HUD status** | `companion-on-demand-status.json`, `relay-status-label.cjs` | **Transport** state; A1/C8 multi-lane semantics (orthogonal to AAR content) |
| **Agent workflow text** | `tactical-briefing-ai-workflow.cjs` | Instructions to separate perception history vs current readiness |

### 4.3 Distinctions the Companion **does** enforce (Node + docs)

| Distinction | Mechanism |
|-------------|-----------|
| Observed vs confirmed fire outcome | `fire-result-consumer.cjs`: COMPLETED ≠ hit/kill |
| Move success vs destination | `move-result-consumer.cjs`: `destination_reached` + `final_position` |
| Perception psych `*_observed` vs readiness | M1 briefing workflow + cursor rules |
| Hostile current LOS vs perception memory | `hostile-intelligence-consumer.cjs` |
| Strategic vs tactical relay | `send_scope` + separate GitHub paths |
| Stale command vs fresh binding | `tactical-command.cjs`, session orphan policy (A2) |

### 4.4 Gaps vs unified reporting (still true)

| Gap | Defect or optional? | Evidence |
|-----|---------------------|----------|
| No `DebriefingState` / mission score export | **Designed scope gap** (P2-2) | No exporter in `CompanionBaseIntelligenceExportCore` or tactical snapshot |
| No single JSON merging last mission + geoscape transition | **Architecture gap** | POST-MISSION C10; ledger audit — intentional separation |
| `MissionStatistics` not in BI | **Missing feature** | STRATEGIC-INTEL-COVERAGE-01 §9 |
| End-of-month funding tick not packaged as “report” | **Optional** | Finances histories exist in BI when populated |
| `weapon_fired` lacks post-shot advisory fields | **B8 reporting** (CONDITIONAL) | Not C10 regression |
| Relay status “failed then success” | **A1/C8** transport UX | Not content completeness |

### 4.5 Consistency for cooperative play

| Question | Assessment |
|----------|------------|
| Are command outcomes attributed correctly when terminal? | **Yes** — engine result JSON is source; Node consumers document non-inference rules |
| Can Aster plan geoscape without mission? | **Yes** — strategic SEND (C9 CLOSED) |
| Can Aster reconstruct full mission AAR from one pull? | **No** — requires tactical SEND (or F6) **plus** optional human debrief screen data not exported |
| Fog-of-war preserved? | **Yes** — no hidden trajectory, undetected UFOs, or full alien mission graph in exports |

### 4.6 Redundant or contradictory reporting

| Symptom | Root cause class | C10 defect? |
|---------|------------------|-------------|
| Relay line vs command result | Status lanes (A1/C8) | **No** — labeling/transport |
| `on_mission` vs `returning_from_ground_mission` | Legacy field + `schema_notes` | **Doc** — not contradiction in engine |
| Perception vs `eventLog` ordering | Separate logs, no seq key (B8) | **Known reporting limit** — defer B8 track |

---

## 5. Cross-check: related closeouts (not reopened)

| Item | Prior disposition | Impact on C9/C10 |
|------|-------------------|------------------|
| **B4** civil fatals | Policy omission | Explains missing AAR civilian lines — **not** a C10 serialization bug |
| **B5** TU | Staleness / advisory | Command result + refresh pattern sufficient for cooperative play |
| **B6** DROP | Engine OK; live validation edge | Tactical only |
| **B7** explosives | Partial chain attribution | Tactical perception only |
| **B8** | CONDITIONAL reporting | Does not block strategic SEND |
| **S11** | CONDITIONAL doc | Improves BI purchasing semantics; **purchasing catalog now in export** |

---

## 6. Verdicts

### 6.1 C9 — **CONDITIONAL** (split)

| Sub-question | Verdict |
|--------------|---------|
| Geoscape strategic SEND reliable without tactical play? | **CLOSED** |
| Original “remove Geoscape SEND bar” task | **OPEN** (optional P2 UX only if owner still wants it) |
| Incorrect strategic data representation in export | **Closed-negative** — no confirmed defect; aircraft interception position remains a **coverage gap**, not SEND failure |

**Overall C9 backlog row:** Treat **capability** as **done**; treat **removal** as **deferred P2**, not OPEN defect.

### 6.2 C10 — **CONDITIONAL**

| Sub-question | Verdict |
|--------------|---------|
| Existing multi-channel reporting correct & attributed? | **CLOSED** within each channel’s contract |
| Unified AAR JSON tactical → geoscape? | **OPEN (feature gap)** — was always P2 spec, not shipped |
| Production defect breaking cooperative play? | **Closed-negative** — agents must merge tactical + strategic + results explicitly |

---

## 7. Confirmed defects vs gaps

| ID | Finding | Type |
|----|---------|------|
| — | Geoscape SEND publishes wrong schema or tactical state | **Not found** |
| — | Strategic marker/digest bypass | **Not found** |
| D-C9-DOC-01 | STRATEGIC-INTEL-COVERAGE-01 states purchasing stub | **Documentation stale** |
| D-C10-SCOPE-01 | No debrief/mission score export | **Scope gap** (original C10) |
| D-C10-SCOPE-02 | No campaign ledger / cross-mission memory in SEND | **By design** (ledger audit) |
| D-A1-UX-01 | Relay status contradictions | **Related P0/P2** — not C10 content defect |

---

## 8. Minimal recommendations (severity order)

1. **P2 (C9 product):** If owner still wants Geoscape bar hidden — implement `createUi` / visibility scoped to `interfaceId == "geoscape"` only; **keep** Basescape SEND + full `onStrategicSendPressed` path (POST-MISSION P2-1).
2. **P2 (C10):** AAR **spec only** — document which existing fields compose “mission closeout” (`rosterCasualtySummary`, last tactical `state.json`, optional `tactical-command-result` chain) before any `DebriefingState` hook (POST-MISSION P2-2).
3. **P2 (doc):** Refresh STRATEGIC-INTEL-COVERAGE-01 purchasing section → full catalog + S11 transfer semantics in `schema_notes`.
4. **P2 (optional):** One live geoscape SEND → GitHub `base-state.json` smoke on pinned runtime (verification only).
5. **Do not** merge tactical into strategic SEND payload (fair-play + size); **do not** reopen B4/B5 engine mechanics without new evidence.

---

## 9. Defer to upcoming AAR audit (do not implement standalone)

These belong in a **unified AAR audit**, not ad-hoc C9/C10 code:

- `DebriefingState` field inventory vs player-visible debrief text/score/rating.
- `MissionStatistics` / monthly score alignment with `finances.research_score_monthly_history`.
- Mission-end transition: last tactical snapshot timing vs first post-mission geoscape SEND.
- Campaign ledger (`companion-campaign-intelligence.json`) pointer vs duplicating history in BI.
- Whether cooperative agents need a **normative “closeout checklist”** (tactical SEND + strategic SEND + result terminals) instead of new JSON.
- Civilian/neutral fatals in **narrative** reporting (B4 policy), if AAR must mention them.

---

## 10. References (implementation)

| Path | Relevance |
|------|-----------|
| `engine/OpenXcom/src/Engine/CompanionOnDemandRelayOverlay.cpp` | Relay bar, strategic send, geoscape retrieve hide |
| `engine/OpenXcom/src/Geoscape/GeoscapeState.cpp` | Geoscape SEND click |
| `engine/OpenXcom/src/Basescape/BasescapeState.cpp` | Base strategic SEND |
| `engine/OpenXcom/src/Battlescape/BattlescapeState.cpp` | Tactical SEND / F6 |
| `engine/OpenXcom/src/Engine/CompanionStrategicSendEnqueueSupport.cpp` | Staged BI + marker |
| `engine/OpenXcom/src/Engine/CompanionBaseIntelligenceExportCore.cpp` | BI schema v2 |
| `companion/m0-publish/lib/strategic-publish.cjs` | `base-state` publish |
| `companion/m0-publish/lib/tactical-publish.cjs` | Tactical validation |
| `companion/m0-publish/test/companion-on-demand-relay-m1-strategic.test.cjs` | Strategic SEND tests |

---

*End of ASTER-M1-C9-C10-RELIABILITY-RECONCILIATION-01. Stop after report; await owner review.*