# ASTER-M1-AAR-COMPACT-VALIDATE-04 — Compact AAR build & publish validation

**Date:** 2026-11-15  
**Mode:** Validation only — no commits, pushes, live GitHub publish, deployment, or full missions.  
**Schema baseline:** Owner-approved compact contract ([COMPACT-03](./ASTER-M1-AAR-COMPACT-03.md))

---

## 1. MSBuild / toolchain discovery

`msbuild` is **not** on default PATH. Located via **vswhere**:

| Item | Value |
|------|--------|
| **MSBuild** | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe` |
| **Version** | 18.5.4+cb4e32d21 (.NET Framework) |

---

## 2. Engine rebuild (test tree only)

**Command:**

```text
MSBuild.exe "E:\Open X-Com Companion\engine\OpenXcom\build-aar-test\src\companion_battle_aar_capture_test.vcxproj"
  /p:Configuration=Release /p:Platform=Win32 /m:1
```

**Recompiled (AAR-related):** `CompanionBattleAarCaptureCore.cpp`, `CompanionBattleAarCapture.cpp`, `DebriefingState.cpp` (dependency), `companion_battle_aar_capture_test.cpp`.

**Output:** `engine\OpenXcom\build-aar-test\bin\Release\companion_battle_aar_capture_test.exe` — **exit 0**, stdout: `companion_battle_aar_capture_test: all passed.`

**Not built / not touched:** `openxcom.vcxproj`, `runtime\m0\bin\openxcom.exe`, isolated production trees (`build-isolated-m1-23e`, etc.).

### Deployed binary pin (unchanged)

| Artifact | SHA-256 |
|----------|---------|
| `runtime\m0\bin\openxcom.exe` | `8BB612FF1B19F5C4AED053786E8652FEB023D18F8173D5EF3AE7C02B3B61C08B` |

Verified before and after this validation pass; no copy/deploy step ran.

---

## 3. Owner rule: omit zero-qty debrief rows

**Engine parity** (`CompanionBattleAarCaptureCore.cpp`): `score_breakdown` skips rows where `DebriefingStat::qty == 0`, matching debrief UI:

```352:355:engine/OpenXcom/src/Battlescape/DebriefingState.cpp
	for (std::vector<DebriefingStat*>::iterator i = _stats.begin(); i != _stats.end(); ++i)
	{
		if ((*i)->qty == 0)
			continue;
```

**Relay safety net** (`battle-aar-compact-project.cjs`): compact projection also filters `quantity === 0` so legacy local artifacts cannot leak non-displayed rows to GitHub.

**Totals unchanged:** `outcome.score` and `outcome.rating` remain engine `MissionStatistics` fields (authoritative debrief totals), independent of which breakdown lines are listed.

---

## 4. Automated test results

| Suite | Command / target | Result |
|-------|------------------|--------|
| C++ AAR capture | `build-aar-test\bin\Release\companion_battle_aar_capture_test.exe` | **PASS** (4 tests) |
| Node compact | `companion-battle-aar-compact.test.cjs` | **4/4** |
| Node relay | `companion-battle-aar-relay.test.cjs` | **9/9** |
| Node durability | `companion-battle-aar-durability.test.cjs` | **5/5** |
| **Total Node** | | **18/18** |

### Compact contract checks exercised by tests

| Requirement | Evidence |
|-------------|----------|
| Authoritative debrief scoring | `outcome.score` / `rating` / `score_breakdown` mirrored; zero-qty rows omitted |
| Memorial (lost in service) | `career_kills` on KIA/MIA; `lost_in_service` block required at ingest |
| Promotions | `debrief.promotions[]` with `rank_before` / `rank_after` |
| Wounds | `debrief.wounded[]` with `recovery_days` |
| Commendations | `debrief.commendations[]` when present |
| Stat increases | `debrief.stat_increases[]` passed through when engine supplies them |
| No tactical / logs / narrative | Published envelope has no `tactical_terminal`, `terminal_payload`, `engine_kills`, `mission_summary` |
| No invented fields | Engine removed `mission_summary`; relay only projects engine-sourced blocks |
| Archive + retry | Relay + durability suites unchanged (queue, journal, outage retry, archive path, produced artifacts) |

---

## 5. Sanitized GitHub publish example

Exact shape after `projectBattleAarForRelay()` + `buildBattleAarRelayEnvelope()` (fixture data, fake relay SHA). Full file: `companion/m0-publish/test/fixtures/example-battle-aar-compact-published.json`.

```json
{
  "schema_version": 1,
  "type": "battle_aar_compact",
  "status": "finalized",
  "report_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "identity": {
    "campaign_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "tactical_battle_id": "tactical-battle-1",
    "mission_statistics_id": 7,
    "mission_type": "STR_TERROR_MISSION",
    "region": "STR_NORTH_AMERICA",
    "country": "STR_USA",
    "game_time": { "year": 1999, "month": 3, "day": 10, "hour": 14, "minute": 30 }
  },
  "outcome": {
    "success": true,
    "score": 350,
    "rating": "STR_RATING_GOOD",
    "score_breakdown": [
      { "line_id": "STR_ALIENS_KILLED", "quantity": 8, "points": 400, "recovery": false },
      { "line_id": "STR_ELERIUM_115", "quantity": 2, "points": -50, "recovery": true }
    ]
  },
  "debrief": {
    "lost_in_service": [],
    "promotions": [
      { "display_name": "Promoted Operative", "rank_before": "RANK_SQUADDIE", "rank_after": "RANK_SERGEANT" }
    ],
    "wounded": [
      { "display_name": "Test Operative", "rank": "RANK_SERGEANT", "recovery_days": 5 }
    ],
    "commendations": [
      { "display_name": "Test Operative", "commendation_type": "STR_MEDAL", "noun": "STR_ALIEN", "decoration_level": 1 }
    ],
    "stat_increases": []
  },
  "kind": "battle_aar_relay",
  "snapshot_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

*(Relay metadata fields `relay_published_at`, `relay_content_sha256`, `request_id`, `published_at`, and `data_quality` omitted above for readability; they are included in the on-wire publish body.)*

---

## 6. Payload size vs relay cap

| Metric | Value |
|--------|--------|
| Serialized publish body (fixture + relay envelope, pretty-printed) | **2,448 bytes** (~2.4 KiB) |
| `DEFAULT_BATTLE_AAR_MAX_BYTES` (`relay-config.cjs`) | **786,432 bytes** (768 KiB) |
| Headroom | **>99.6%** below cap |

Full local `battle_aar` with `tactical_terminal` remains in `aar-produced/` only; compact publish is intentionally small.

---

## 7. What remains before live use

1. **Production engine build** — AAR capture changes are verified in `build-aar-test` only; promoting them to `runtime\m0\bin\openxcom.exe` is a **separate** deploy decision (not done here).
2. **Live debrief spot-check** — one mission F6 cycle to confirm producer `lost_in_service` / `career_kills` with real battle roster (optional; harness covers logic).

---

## 8. Isolation preserved

- No `m0/state.json`, tactical command inbox, or strategic SEND changes in this pass.
- Durable queue, `aar-produced/` discovery, archive path layout, and duplicate journal semantics: **unchanged** (durability suite green).

**Stop for owner review.**