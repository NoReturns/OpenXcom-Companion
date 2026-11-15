# ASTER-M1-AAR-COMPACT-03 — Compact GitHub AAR (debrief screens)

**Date:** 2026-11-15  
**Mode:** Review implementation — no commits, pushes, live publish, or runtime deploy.  
**Baselines:** [IMPLEMENT-01](./ASTER-M1-AAR-IMPLEMENT-01.md), [RELAY-01](./ASTER-M1-AAR-RELAY-01.md), [DURABILITY-02](./ASTER-M1-AAR-DURABILITY-02.md)

---

## 1. Owner intent

The GitHub battle AAR is a **structured text equivalent of OpenXcom post-mission debrief screens** (score, memorial, promotions, wounds, commendations). It is **not** a tactical event archive.

| Include (authoritative engine only) | Exclude from GitHub |
|-------------------------------------|---------------------|
| Mission identity and outcome | Full combat / event logs |
| Exact score, rating, all debrief stat rows | Perception logs |
| Lost in Service: name, rank, career kills | Terminal coordinates / unit dumps |
| Promotions: name, previous rank, new rank | Turn-by-turn history |
| Wounded: recovery days | Invented narrative summaries |
| Commendations when the game awards them | Detailed tactical telemetry |

**Preserved:** automatic publishing, permanent archive, producer durability (`aar-produced/`), queue/journal/retry, tactical & strategic relay isolation, full local artifact for diagnostics.

---

## 2. Findings (pre–COMPACT-03)

| Gap | Risk |
|-----|------|
| Relay published the **full** local `battle_aar` (including `tactical_terminal`) | Violates debrief-only contract; large GitHub payloads |
| `mission_summary.bullets` | Auto-generated prose, not an engine screen |
| `tactical_timeline` | Perception log slice — tactical memory, not debrief |
| KIA/MIA lacked **career kills** (`Soldier::getKills`) | Memorial screen parity incomplete |
| Wounded only via raw `injury_list` + per-soldier fields | No debrief-style wounded list |
| Ingest validation required `mission_summary.bullets` | Blocked compact local artifacts |

---

## 3. Changes

### 3.1 Engine — debrief-aligned fields (local `battle_aar`)

**File:** `engine/OpenXcom/src/Engine/CompanionBattleAarCaptureCore.cpp`

- **`outcome.score_breakdown`:** all debrief stat rows from engine (`quantity` may be `0` — full table parity with `DebriefingStat` list).
- **`post_debrief.soldiers[]`:** added `career_kills` from `Soldier::getKills()` (diagnostic roster; not relayed).
- **`post_debrief.lost_in_service[]`:** KIA/MIA soldiers — `display_name`, `rank`, `career_kills`, `kia`/`mia`.
- **`post_debrief.wounded[]`:** non-KIA/MIA with `getWoundRecovery() > 0` — `display_name`, `rank`, `recovery_days`.
- **Removed** `tactical_timeline` and `mission_summary` from local JSON (invented / perception content).
- **Retained** `tactical_terminal` in local artifact only for operator diagnostics.

### 3.2 Node — compact projection at publish time

**New:** `companion/m0-publish/lib/battle-aar-compact-project.cjs`

- `projectBattleAarForRelay(fullDoc)` → `type: battle_aar_compact`, `debrief.{lost_in_service, promotions, wounded, commendations, stat_increases}`.
- Copies `identity` + `outcome` verbatim from engine.
- `validateCompactBattleAar()` + leak guard (`tactical_terminal`, `engine_kills`, etc.).
- Fallback derivation from `post_debrief.soldiers` when explicit blocks missing (legacy artifacts).

**Updated:** `companion/m0-publish/lib/battle-aar-relay-publish.cjs`

- Ingest/queue still stores **full** produced artifact (unchanged digest / durability).
- **`publishBattleAarEntry`** projects to compact before envelope + archive/latest upload.
- `assessBattleAarCoverage` requires `lost_in_service` and `wounded` arrays; drops `mission_summary` requirement; requires `career_kills` on KIA/MIA rows when present.

Relay envelope fields unchanged (`kind: battle_aar_relay`, `snapshot_id`, SHA fields). **`relay_content_sha256`** now hashes the **compact** published body (artifact SHA still tracks full local file).

### 3.3 Published compact shape (example)

```json
{
  "schema_version": 1,
  "type": "battle_aar_compact",
  "status": "finalized",
  "identity": { "mission_type": "STR_TERROR_MISSION", "…": "…" },
  "outcome": {
    "score": 350,
    "rating": "STR_RATING_GOOD",
    "score_breakdown": [ { "line_id": "STR_ALIENS_KILLED", "quantity": 8, "points": 400, "recovery": false } ]
  },
  "debrief": {
    "lost_in_service": [],
    "promotions": [ { "display_name": "…", "rank_before": "RANK_SQUADDIE", "rank_after": "RANK_SERGEANT" } ],
    "wounded": [ { "display_name": "…", "rank": "RANK_SERGEANT", "recovery_days": 5 } ],
    "commendations": [ ],
    "stat_increases": [ ]
  }
}
```

Human-readable, no tactical blocks.

---

## 4. Verification

| Suite | Result |
|-------|--------|
| `companion-battle-aar-compact.test.cjs` | 3/3 — parity + leak rejection |
| `companion-battle-aar-relay.test.cjs` | 9/9 — publish uses `battle_aar_compact`, no tactical keys in archive JSON |
| `companion-battle-aar-durability.test.cjs` | 5/5 — queue/discover unchanged |
| **Total Node** | **17/17** |
| `companion_battle_aar_capture_test` (C++) | Source updated; rebuild via `build-aar-test` when validating engine |

Focused parity checks in tests:

- Score / rating / `score_breakdown` equality after projection.
- Wounded `recovery_days`, promotion ranks, commendation `decoration_level`.
- Published envelope excludes `tactical_terminal` and `terminal_payload`.

---

## 5. Isolation & durability (unchanged)

- No changes to `m0/state.json`, tactical command inbox, or strategic SEND paths.
- `aar-produced/<report_id>.json` retains **full** capture including `tactical_terminal`.
- Duplicate protection: ingest digest on full artifact; journal `content_sha256` on compact publish body.

---

## 6. Owner follow-ups (optional)

1. **Rebuild engine** so live missions emit `lost_in_service`, `wounded`, and `career_kills` (required for memorial parity).
2. Confirm zero-qty debrief rows in GitHub match operator expectation (matches engine stat list, not only UI lines with qty &gt; 0).
3. Approve compact schema before any commit / push.

---

## 7. Files touched

| Area | Files |
|------|--------|
| Engine | `CompanionBattleAarCaptureCore.cpp`, `.h`, `companion_battle_aar_capture_test.cpp` |
| Relay | `battle-aar-compact-project.cjs`, `battle-aar-relay-publish.cjs` |
| Tests | `companion-battle-aar-compact.test.cjs`, `companion-battle-aar-relay.test.cjs`, `minimal-battle-aar-finalized.json` |

**Stop here for owner review** — no commits, pushes, or live deployment in this step.