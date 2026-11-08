# M1 Battlescape WP8C — Completion report (battlefield loot awareness)

**Date:** 2026-11-06  
**Scope:** Read-only **loot / ground awareness** for the Companion snapshot — **bounded** `groundItems` memory and **`hostile_casualty_tile_observed`** in **`perceptionLog`**. **No** change to **`PICKUP`/`DROP`** contracts. **No** GitHub publish, **no** canonical `runtime\m0\bin\openxcom.exe` deployment in this pass.

---

## 1. Executive summary

WP8C **tightens** the per-session `groundItems` export cap to **64** observations (deterministic eviction), adds **`hostile_casualty_tile_observed`** when a **visible** hostile death tile is resolved through existing **`CompanionPerceptionLog`** spatial rules (`UnitDieBState`), updates Node **`tactical-publish.cjs`** validation, adds C++/Node regression coverage, and documents fair-play boundaries.

---

## 2. Source findings (audit brief)

| Question | Finding |
|----------|---------|
| Can terrain tell if a tile is **currently** visible? | **Partially:** snapshot **`terrain`** carries discovery + **`inLos`** (verbose) semantics; **`groundItems`** / perception hooks use **`Tile::getVisible() > 0`** for “current friendly sight.” |
| Discovered vs. currently visible? | **Yes — distinct:** `isDiscovered` vs. `getVisible`. |
| Engine record item drops? | **No dedicated Companion event log type;** drops appear as **`BattleItem`** on tiles. **`groundItems`** observes ground rows under fair-play gates. |
| Does `perceptionLog` record deaths? | **Now:** **`hostile_casualty_tile_observed`** (tile + conservative confidence). **`unit_last_seen`** remains for **living** hostiles when visibility tracking emits it. |
| Ground items at distance? | When tile is **`getVisible() > 0`**, ground rows can export (subject to research / stacking rules). |
| Death ⇒ dropped gear observable? | **Not guaranteed;** death hook records **`possible_ground_equipment`** only if **`hasInventory()`** at death. Engine may still skip drops (`weaponSelfDestruction`, etc.). |
| Hidden map inventory? | **Never exported** by design. |
| Structures for bounded memory? | **`groundItems`** + existing **`perceptionLog`** ring buffer (**256** events). |
| Item moves out of sight? | **`CONFIRMED_IN_LOS`** stops exporting; **`REMEMBERED_OFF_LOS`** replays **last** in-LOS snapshot **without** reading hidden tile contents. |
| Save/load / session | Ground-item memory **not** in save; reload **clears** session memory; new export rebuilds from play. |

---

## 3. Fair-play decision

| Exported | Rationale |
|----------|-----------|
| `groundItems` in LOS | Legitimate ground rows consistent with player-visible tiles. |
| `REMEMBERED_OFF_LOS` | Bounded echo of **last** confirmed observation — **not** live ground state. |
| `hostile_casualty_tile_observed` | Only when death tile passes **friendly-visible** spatial resolution; **no** `subjectUnitId`; confidence is **possibility** not certainty. |

| Hidden | Rationale |
|--------|-----------|
| Undiscovered tiles | Skipped. |
| Off-LOS tile inventories | Not scanned for fresh data. |
| Full stack identities | Secondary rows stay **`additional_ground_item`**. |

---

## 4. Implemented model

- **`CompanionGroundItemMemory`:** cap **64**; sort `(z,y,x)`; overflow → `droppedCount`.
- **`CompanionPerceptionLog::tryRecordHostileDeathObserved`:** called from **`UnitDieBState`** for **original hostile** at final death; confidence from **`hasInventory()`**.
- **Node:** `MAX_GROUND_ITEM_OBSERVATIONS = 64`; new perception type + confidence whitelist; **`hostile_casualty_tile_observed`** forbids **`subjectUnitId`**.

---

## 5. Impossible or unsupported (this milestone)

- **Proving** UI sprite visibility from data alone (deferred **LIVE VERIFIED**).
- **Correlating** a specific weapon class to a kill without **`groundItems`** / research rules (by design).
- **Persistence** of ground memory across tactical save reload (not in save format).

---

## 6. Files modified

| Path | Change |
|------|--------|
| `engine/OpenXcom/src/Engine/CompanionGroundItemObservationCore.h` | Observation cap **64**. |
| `engine/OpenXcom/src/Engine/CompanionPerceptionLog.h` | `tryRecordHostileDeathObserved` declaration. |
| `engine/OpenXcom/src/Engine/CompanionPerceptionLog.cpp` | Implementation. |
| `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | Snapshot export: exclude `subjectUnitId` for new type. |
| `engine/OpenXcom/src/Battlescape/UnitDieBState.cpp` | Death hook + include. |
| `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` | WP8C perception tests. |
| `companion/m0-publish/lib/tactical-publish.cjs` | Cap + perception validation. |
| `companion/m0-publish/test/companion-perception-log-m1-wp6.test.cjs` | New perception tests. |
| `companion/docs/M1-TACTICAL-PLAN-FOUNDATION.md` | WP8C cross-reference. |
| `companion/docs/M1-BATTLESCAPE-WP8C-LOOT-AWARENESS.md` | Design note (this workstream). |
| `companion/docs/M1-BATTLESCAPE-WP8C-COMPLETION-REPORT.md` | This report. |
| `companion/docs/M1-WP8-INVENTORY-LIVE-ACCEPTANCE.md` | Grouped live-test runbook. |

---

## 7. Snapshot compatibility

- **Additive** perception `type` + confidence values — consumers must allow unknowns or update allowlists (Node updated).
- **`groundItems.observations`** max length **64** (was **384** in Node/engine) — stricter cap; relay snapshots larger than 64 tile cues will **fail Node validation** until refreshed on builds that include this change.

---

## 8. Verification categories

| Category | Status |
|----------|--------|
| **IMPLEMENTED** | Engine + Node as above. |
| **AUTOMATED TESTED** | **Done** — see §§9–10. |
| **ENGINE VERIFIED** | **Done** — `companion_snapshot_serialization_test.exe` exit **0** (2026-11-06). |
| **LIVE VERIFIED** | **Not run** (operator absent). |

---

## 9. Automated test results (recorded)

### Node (`companion/m0-publish`)

| Metric | Result |
|--------|--------|
| Command | `node companion/m0-publish/scripts/run-all-node-tests.cjs` |
| Outcome | **Pass** — **618** tests, **0** failures (repo root: `E:\Open X-Com Companion`; session ~2026-11-06, ~37 s wall clock) |

### C++ snapshot harness

| Metric | Result |
|--------|--------|
| Executable | `engine\OpenXcom\build-wp8-isolated\bin\Release\companion_snapshot_serialization_test.exe` |
| Outcome | **Exit 0** — includes **`testHostileDeathPerceptionWhenTileInFriendlySight`** and **`testHostileDeathPerceptionOmitsWhenTileNotInSight`**. |

---

## 10. Engine integration / build (isolated, recorded)

**MSBuild** (VS 18 BuildTools, Release \| Win32, solution `engine\OpenXcom\build-wp8-isolated\OpenXcom.sln`):

1. **Target** `companion_snapshot_serialization_test` — **succeeded** (link: path above).
2. **Target** `openxcom` — **succeeded**; output: **`engine\OpenXcom\build-wp8-isolated\bin\Release\openxcom.exe`**.

Example invocation (PowerShell):

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  "E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\OpenXcom.sln" `
  /m /p:Configuration=Release /p:Platform=Win32 /t:companion_snapshot_serialization_test
```

Full game link:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  "E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\OpenXcom.sln" `
  /m /p:Configuration=Release /p:Platform=Win32 /t:openxcom
```

**Canonical** `runtime\m0\bin\openxcom.exe` — **not** deployed in this milestone.

---

## 11. Node regression (reference command)

Same as §9:

`node companion/m0-publish/scripts/run-all-node-tests.cjs`

---

## 12. Live acceptance runbook

`companion/docs/M1-WP8-INVENTORY-LIVE-ACCEPTANCE.md`

---

## 13. Deployment status

- **Canonical runtime:** unchanged.  
- **GitHub:** no command publish.

---

## 14. GO / NO-GO (grouped live testing)

| Gate | Verdict |
|------|---------|
| Automated Node + snapshot C++ tests + isolated link | **GO** for proceeding to operator-led relay tests (evidence in §§9–10). |
| Operator relay + real F6 | **NO-GO** until runbook executed. |

---

## 15. Risks / next milestone

- **`groundItems` eviction policy (64 cap):** overflow drops by **sorted tile address** `(z, y, x)` — deterministic but **not** “oldest first” or “most recently seen.” A future milestone could prefer **CONFIRMED_IN_LOS** and **recent turn** before evicting **REMEMBERED_OFF_LOS** (not required for first live pass).
- **Stricter 64 cap** may evict busy maps sooner — operators should treat **`droppedCount`** as a signal.
- Optional: **LIVE** validation of death + drop timing vs. tile visibility (animation edge cases).
- Next: grouped **WP8 inventory** live session per **`M1-WP8-INVENTORY-LIVE-ACCEPTANCE.md`** (real relay: drop, pickup, unload, alien recovery).
