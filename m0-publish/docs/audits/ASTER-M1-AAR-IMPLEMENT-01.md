# ASTER-M1-AAR-IMPLEMENT-01 — Local battle AAR capture

**Date:** 2026-11-15  
**Mode:** Engine local capture only — no commits, no GitHub publish, no live mission.  
**Baseline:** [ASTER-M1-AAR-LIFECYCLE-AND-CONTRACT-AUDIT-01.md](./ASTER-M1-AAR-LIFECYCLE-AND-CONTRACT-AUDIT-01.md)

---

## Summary

Implemented **two-phase** automatic local AAR capture in canonical `engine/OpenXcom`:

| Phase | Hook | Artifact |
|-------|------|----------|
| **A** | First statement of `DebriefingState::prepareDebriefing()` | In-memory tactical terminal (logs, units, mission context) + pre-debrief rank snapshot |
| **B** | After `handlePromotions()`, **before** `setBattleGame(0)` | Atomic write `local/m0/companion-battle-aar.json` (beside `OPENXCOM_COMPANION_SNAPSHOT_PATH`) |

Gated like other Companion exports: `OPENXCOM_COMPANION_SNAPSHOT_PATH` must be set; skipped in debug save mode. **No** changes to `m0/state.json`, tactical SEND, or strategic SEND.

---

## Lifecycle verification (promotions / commendations)

Verified against current `DebriefingState::init()` and `btnOkClick()`:

| Data | Becomes authoritative | Captured in AAR? |
|------|------------------------|------------------|
| Score, rating, `_stats` breakdown | After score loop (~418–442) | **Yes** — `outcome.*` from same `_stats` / `MissionStatistics` |
| KIA/MIA, wounds, engine kills, stat increases | `prepareDebriefing` + post-score unit loop | **Yes** — `post_debrief.soldiers`, `injury_list`, `soldier_stat_increases` |
| Diary commendations (`manageCommendations`) | During init unit loop (before promotions) | **Yes** — `post_debrief.commendations_awarded_this_debrief[]` only entries with `SoldierCommendations::isNew()` |
| Rank promotions (`handlePromotions`) | End of `init()`, **before** `setBattleGame(0)` | **Yes** — `post_debrief.promotions_applied[]` via rank diff (Phase A snapshot vs post-`handlePromotions`) |
| Promotions **UI** (`PromotionsState`) | `btnOkClick` only | **Metadata only** — `promotions_ui_scheduled` (not a substitute for confirmed rank changes) |
| Commendation **UI** (`CommendationState`) | `btnOkClick` | Not duplicated — awards already applied in init; UI is presentation only |
| Memorial / dead roster persistence | `prepareDebriefing` / save mutation | **Partial** — KIA/MIA and engine kill list only; no dedicated memorial ledger block |

**Finalize timing:** Phase B intentionally runs **after** `handlePromotions()` so `promotions_applied` reflects confirmed ranks, not pending UI.

**Multi-stage missions:** When `BattlescapeState::finishBattle` routes to `nextStage`, debrief is skipped → **no** `finalized` AAR (correct; no misleading end-of-campaign report mid-deployment).

---

## Changed files

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Engine/CompanionBattleAarCaptureCore.h` | AAR schema builder API |
| `engine/OpenXcom/src/Engine/CompanionBattleAarCaptureCore.cpp` | JSON envelope, phase merge, summary, timeline |
| `engine/OpenXcom/src/Engine/CompanionBattleAarCapture.h` | Debrief hooks + test seam |
| `engine/OpenXcom/src/Engine/CompanionBattleAarCapture.cpp` | Phase A buffer, atomic write |
| `engine/OpenXcom/src/Engine/CompanionSnapshotBuild.h` | `buildAarTacticalTerminal()` |
| `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | Shared tactical-intelligence append; AAR terminal builder |
| `engine/OpenXcom/src/Battlescape/DebriefingState.h` | Friend `CompanionBattleAarDebriefAccess` |
| `engine/OpenXcom/src/Battlescape/DebriefingState.cpp` | Phase A + B hooks |
| `engine/OpenXcom/src/CMakeLists.txt` | Sources + `companion_battle_aar_capture_test` |
| `engine/OpenXcom/src/test/companion_battle_aar_capture_test.cpp` | Focused serialization tests |

**Untouched:** `companion/m0-publish` relay paths, `m0/state.json`, tactical/strategic SEND.

---

## Example sanitized JSON (structure)

```json
{
  "schema_version": 1,
  "type": "battle_aar",
  "status": "finalized",
  "report_id": "<sha256 hex over campaign_id + tactical_battle_id + mission_statistics_id>",
  "generation_id": "<unix_ms>",
  "finalized_at_ms": 0,
  "published_at": null,
  "identity": {
    "campaign_id": "<companion campaign id>",
    "tactical_battle_id": "<companion tactical battle id>",
    "tactical_session_id": "<event log session>",
    "mission_statistics_id": 0,
    "mission_type": "STR_TERROR_MISSION",
    "region": "STR_NORTH_AMERICA",
    "country": "STR_USA",
    "game_time": { "year": 1999, "month": 3, "day": 10, "hour": 14, "minute": 30 },
    "mission_start_time": null
  },
  "outcome": {
    "aborted": false,
    "success": true,
    "score": 350,
    "rating": "STR_RATING_GOOD",
    "valiant_crux": false,
    "loot_value": 0,
    "score_breakdown": [
      { "line_id": "STR_ALIENS_KILLED", "quantity": 8, "points": 400, "recovery": false }
    ],
    "provisional": false
  },
  "tactical_terminal": {
    "captured_at_phase": "pre_prepare_debriefing",
    "log_retention_note": "eventLog and perceptionLog are bounded rings; droppedCount > 0 means older events unavailable, not zero.",
    "terminal_payload": { "turn": 5, "side": 0, "missionContext": {}, "units": [], "eventLog": {}, "perceptionLog": {} }
  },
  "post_debrief": {
    "injury_list": { "101": 5 },
    "soldier_stat_increases": [{ "display_name": "Operative", "delta": { "firing": 2 } }],
    "soldiers": [{ "geoscape_soldier_id": 101, "kia": false, "mia": false, "engine_kills": [] }],
    "promotions_applied": [{ "rank_before": "RANK_SERGEANT", "rank_after": "RANK_CAPTAIN" }],
    "commendations_awarded_this_debrief": [{ "commendation_type": "STR_MEDAL_...", "decoration_level": 1 }],
    "promotions_ui_scheduled": true
  },
  "tactical_timeline": { "max_events": 64, "source": "perception_log", "events": [] },
  "mission_summary": { "bullets": ["Mission result: success; rating STR_RATING_GOOD; score 350"] },
  "attribution_policy": { "kill_credit_source": "engine BattleUnitStatistics + debrief stats" },
  "data_quality": {
    "missing_fields": ["identity.mission_start_time"],
    "unknown_vs_zero": "Use null for unknown; use 0 only when engine affirms zero.",
    "perception_log_dropped_count": 0
  }
}
```

---

## Test results

| Test | Result |
|------|--------|
| `companion_battle_aar_capture_test` (Release, `build-aar-test`) | **PASS** — report_id stability, YAML→JSON, debrief score alignment, dropped-count preservation |

Commands used:

```text
cmake -B build-aar-test -DOPENXCOM_BUILD_COMPANION_BATTLE_AAR_CAPTURE_TESTS=ON ...
cmake --build build-aar-test --target companion_battle_aar_capture_test --config Release
build-aar-test\bin\Release\companion_battle_aar_capture_test.exe
```

---

## Known gaps (explicit, not faked)

| Gap | Notes |
|-----|-------|
| `identity.mission_start_time` | Not stored by engine — `null` + listed in `data_quality.missing_fields` |
| GitHub / relay publish | Out of scope this step — no `battle-aar.json` PUT, no publish marker |
| Multi-stage partial reports | No `stage_complete` artifact; debrief skipped until final stage |
| Memorial roster block | No separate memorial record export |
| Post-`btnOkClick` only effects | Autosave, containment UI — outside finalize window by design |
| Squad-wipe / cutscene-win | Debrief still runs when `DebriefingState` is pushed; win/lose game cutscenes may pop debrief unshown — AAR still finalizes in `init()` if that state runs |
| Rookie→squaddie promotions | If applied only inside `prepareDebriefing` without rank enum change visible at Phase A boundary, may appear only as stat deltas — not separately tagged |

---

## Fair-play / perception

Tactical terminal reuses `CompanionSnapshotBuild::buildAarTacticalTerminal()` (same event/perception export rules as F6). No inferred killers; neutral civilian fatals remain policy-gated in perception export.

---

## Ready for Node / GitHub relay?

| Criterion | Status |
|-----------|--------|
| Stable local artifact path | **Yes** — `{snapshot_parent}/companion-battle-aar.json` |
| `status: finalized` only after debrief + promotions | **Yes** |
| `report_id` for idempotent publish | **Yes** |
| Schema documented | **Yes** — this doc + lifecycle audit |
| Relay watcher / `m0/battle-aar.json` | **Not implemented** (next step per audit §7) |

**Verdict:** Local artifact is **ready for owner review** and for a follow-on Node relay lane; engine hook is minimal and does not alter existing tactical/strategic channels.

---

## Owner review stop

No git commit, push, or live mission per task restrictions. Recommend one debriefed mission in companion runtime to inspect `local/m0/companion-battle-aar.json` before enabling relay publish.