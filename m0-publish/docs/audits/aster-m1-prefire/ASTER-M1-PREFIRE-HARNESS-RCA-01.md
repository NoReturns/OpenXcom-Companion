# ASTER-M1-PREFIRE-HARNESS-RCA-01

**Mode:** Strictly read-only (source + existing artifacts)  
**Date:** 2026-11-14  
**Scope:** Engine regression `testPrefireDisplayedFiringAccuracyOnFirearmActions` in `companion_snapshot_serialization_test.cpp`

---

## Executive summary

The pre-fire regression is **not** a mismatch between test literals and engine math when fixtures have deterministic stats. Integer arithmetic in `BattleUnit::getFiringAccuracy` matches the test’s standing (`30`), two-hand (`24`), kneel (`34`), and wounded (`26`) expectations.

The **confirmed root cause** is an **invalid battle fixture**: roster soldiers built from an **unloaded** `RuleSoldier` get **zero** min/max stats, so `BattleUnit` can be constructed with **`getBaseStats()->health == 0`**. That triggers **integer divide-by-zero** in `BattleUnit::getAccuracyModifier` (`25 * _health / getBaseStats()->health`) when `getFiringAccuracy` runs—most visibly during snapshot export (`appendActionEntry`) **before** the production health guard existed.

Current source adds `seedSoldierFiringStats()` (health `50`, firing `60`) **before** `addSoldierUnit()`, which should produce a valid `BattleUnit`. Captured run artifacts show the prefire step **starting** but **no** `FAIL:` lines and **no** final summary—consistent with **abnormal termination inside the step** on a binary that predates or omits the seed/guard pairing, not with a clean assertion-only failure.

**Exit code `3` is not explained by current `main()`** (it returns `EXIT_FAILURE`, typically process exit **1**). The count **`3` aligns with `g_failures`** if stderr’s `N test(s) failed.` was conflated with `$LASTEXITCODE`, or with **cascading assertions** in scenario 2’s inner block when `displayedFiringAccuracy` is omitted (see below).

---

## 1. Code paths inspected

| Area | Location | Role |
|------|----------|------|
| Test | `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` ~L2041–L2150 | Four scenarios + `seedSoldierFiringStats` |
| Fixture | `SoldierFixture`, `TacticalFixture::addRosterSoldier`, `addSoldierUnit` ~L52–L178 | Roster + battle unit wiring |
| Soldier ctor | `Soldier.cpp` ~L43–L79 | RNG stats only when `id != 0`; uses `rules->getMinStats()` / `getMaxStats()` |
| BattleUnit ctor (soldier) | `BattleUnit.cpp` ~L49–L124 | `_stats = *soldier->getCurrentStats();` then `_stats += armor`; `_health = _stats.health` |
| `getBaseStats()` | `BattleUnit.cpp` ~L2462–L2464 | Returns `&_stats` (effective max/base stats in battle) |
| `getFiringAccuracy` | `BattleUnit.cpp` ~L1506–L1539 | Firing × weapon% × kneel × two-hand × modifier |
| `getAccuracyModifier` | `BattleUnit.cpp` ~L1548–L1570 | `std::max(10, 25 * _health / getBaseStats()->health + 75 - 10 * wounds)` |
| Export guard | `CompanionSnapshot.cpp` ~L713–L720 | Export accuracy only if `baseStats != 0 && baseStats->health > 0` |
| Harness | `companion_snapshot_serialization_test.cpp` ~L35–L41, L2291–L2297 | `g_failures`; exit `EXIT_FAILURE` on any failure |

---

## 2. Fixture initialization trace

### Soldier / battle unit (default, without seed)

1. `SoldierFixture` uses `RuleSoldier rules("STR_SOLDIER")` and `Armor armor("STR_JUMPSUIT")` **without** `rules.load()` — `_minStats` / `_maxStats` remain **default (zero)**.
2. `Soldier(rules, armor, id)` with `id != 0` sets `_currentStats.health = RNG::generate(0, 0) = 0` (and similarly for other stats).
3. `addSoldierUnit` → `BattleUnit(soldier)`: copies `_currentStats`, adds armor stats (unloaded armor → zeros), sets `_health = _stats.health` → **`_health` and `_stats.health` can both be 0**.

### With `seedSoldierFiringStats(soldier, 60[, 50])` (current test)

Called **after** `addRosterSoldier`, **before** `addSoldierUnit`:

- Sets `soldier->getCurrentStats()->firing = 60`, `health = 50`, `tu = 80`, `stamina = 80`.
- Battle unit then copies those values → **`getBaseStats()->health == 50`**, `_health == 50` (unless armor modifies health).

### Per scenario (weapon / posture / hands)

| Scenario | Unit id | Seed | Posture | Right hand | Left hand | Current `_health` | Base `_stats.health` |
|----------|---------|------|---------|------------|-----------|-------------------|----------------------|
| Standing | 81 | firing 60, health 50 | standing | `STR_PREFIRE_TF_RIFLE` (snap 50, two-handed) | empty | 50 | 50 |
| Grenade off-hand | 82 | same | standing | same rifle | `STR_WP8_GRENADE` | 50 | 50 |
| Kneeling | 83 | same | kneel | rifle | empty | 50 | 50 |
| Wounded | 84 | same | standing | rifle | empty | **25** via `unit->load("health: 25")` | **50** (load does not change `_stats`) |

Weapon rule `prefireTwoHandedFirearmRules()`: `accuracySnap = 50`, `twoHanded = true`, `clipSize = -1` (no ammo required via `companionFirearmHasAmmo` / `needsAmmo()`).

---

## 3. Expected values (exact engine integer math)

Notation: `mod = getAccuracyModifier(item)` with no fatal wounds.

**Modifier (full health):**  
`mod = max(10, 25 * 50 / 50 + 75 - 0) = max(10, 100) = 100`

**Modifier (wounded, `_health = 25`, base 50):**  
`mod = max(10, 25 * 25 / 50 + 75) = max(10, 12 + 75) = 87`

### Standing (snap, BA_SNAPSHOT)

```
result = 60 * 50 / 100           = 30
       (no kneel, no two-hand)
return 30 * 100 / 100            = 30
```

Test literal: **30**. Export: `displayedFiringAccuracy = 30`, `twoHandedPenaltyActive = false`.

### Grenade in off-hand

```
result = 30
both hands occupied → 30 * 80 / 100 = 24
return 24 * 100 / 100              = 24
```

Test literal: **24**. `twoHandedPenaltyActive = true`.

### Kneeling

```
result = 30
kneel → 30 * 115 / 100 = 34
return 34 * 100 / 100 = 34
```

Test literal: **34**.

### Wounded

```
result = 30
return 30 * 87 / 100 = 2610 / 100 = 26
```

Test `expected = 60 * 50 / 100 * 87 / 100 = 26` (equivalent ordering for integers here).

**Conclusion:** With seeded stats (`firing 60`, base health `50`), **expected == engine == test literals** for all four cases.

---

## 4. Captured stdout/stderr artifacts

### Files reviewed

| Artifact | Content relevant to prefire |
|----------|------------------------------|
| `build-isolated-m1-23e/out.txt` | Only step banner for `testPrefireDisplayedFiringAccuracyOnFirearmActions` (no `FAIL:`, no summary) |
| `build-isolated-m1-23e/err8.txt`, `stde.txt`, `out7.txt` | Full harness steps through line 61 = prefire step name; **no** `FAIL:` lines; **no** `N test(s) failed.` or `all tests passed.` |
| `build-isolated-m1-23e/out5.txt` | Older run: ends at `testTuReservationSnapshotFields` then **`all tests passed.`** — **does not list** prefire (binary without that step) |
| `build-isolated-m1-23e/stdo.txt`, `out8.txt` | Empty |
| `local/m0/test-battle-harness/reports/serialization-test-stderr.txt` | Unrelated: `FAIL: hidden mind-controlled roster soldier omitted` + `1 test(s) failed.` |

### Recoverable failing assertions

**None** for prefire from stored artifacts. No `FAIL:` lines naming `snap displayedFiringAccuracy exported`, `penalty snap exported`, literals, or match-engine messages.

### Uncaught exception

Artifacts are **consistent with abnormal termination during** `testPrefireDisplayedFiringAccuracyOnFirearmActions` (step banner emitted via `SNAPSHOT_TEST_STEP`, then silence). That pattern matches **SEH divide-by-zero (`0xC0000094` / `-1073741676`)** on `getFiringAccuracy` → `getAccuracyModifier` when **`getBaseStats()->health == 0`**, not a completed assertion run.

No artifact in-repo documents `0xC0000094` textually (evidence gap for exception code in logs).

### Exit code `3` vs `main()`

Current `main()`:

```cpp
if (g_failures != 0) {
    std::cerr << g_failures << " test(s) failed." << std::endl;
    return EXIT_FAILURE;  // not g_failures
}
```

- Process exit on failure: **`EXIT_FAILURE` (1 on MSVC)**, not the failure count.
- **`3 test(s) failed.`** on stderr would mean **`g_failures == 3`** while **`$LASTEXITCODE` is still 1** unless an outer wrapper maps codes.
- **Plausible `g_failures == 3` without seed/guard** (export omits `displayedFiringAccuracy`, scenario 2 inner block still runs on `if (snap.IsDefined())` only):
  1. `FAIL: penalty snap exported` (or standing export fail first in another ordering)
  2. `FAIL: two-hand penalty with grenade off-hand`
  3. `FAIL: penalty snap matches engine` and/or `FAIL: snap 30 * 80% two-hand penalty`

**Cannot confirm** which three messages ran—no artifact.

---

## 5. Production health guard vs fixture validity

| Question | Answer |
|----------|--------|
| Does the guard **mask** invalid fixtures? | **Yes.** If `baseStats->health <= 0`, export **skips** `displayedFiringAccuracy` / `twoHandedPenaltyActive` while snap **actions** can still exist → failures look like “not exported,” not “divide by zero.” |
| Is the guard **still needed** in production? | **Yes**, independently of tests—prevents export-time crash on corrupted/zero max-health units in live snapshots. |
| Does the guard **fix** tests alone? | **No.** Tests still call `unit->getFiringAccuracy(...)` inside `expect(...)` when the YAML field **is** present; with `health > 0` that is safe. With `health == 0` and omitted YAML, scenario 2’s loose inner `if (snap.IsDefined())` can still provoke **extra** failures or unsafe YAML access. |
| Correct fixture responsibility | **`seedSoldierFiringStats` (or equivalent) must run before `addSoldierUnit`** so `BattleUnit::_stats.health > 0` and firing is deterministic. Production guard is a **separate**, defensive layer. |

---

## 6. Confirmed root cause(s)

1. **Primary:** Zero **base/max health** on soldier-derived `BattleUnit` fixtures (`RuleSoldier` unloaded → RNG health 0) → **divide-by-zero** in `getAccuracyModifier` when computing pre-fire accuracy (export and/or test).
2. **Contributing (test harness):** Scenario **grenade off-hand** uses `if (snap.IsDefined())` without requiring `displayedFiringAccuracy` (unlike scenario 1), which can **inflate `g_failures`** when export omits the field (up to **three** failures in that block alone).
3. **Non-issue (given valid fixture):** Literal expected values **30 / 24 / 34 / 26** match engine formulas.

---

## 7. Expected versus actual (artifact-backed)

| Item | Expected (valid seed) | Actual in artifacts |
|------|------------------------|---------------------|
| Step reaches prefire | Banner line | **Yes** (`err8.txt` / `out7.txt` line 61) |
| `FAIL:` messages | 0 if pass; else named expects | **Not present** (prefire) |
| Final summary | `all tests passed.` or `N test(s) failed.` | **Absent** on runs that include prefire step |
| Process exit | `0` or `1` per `main()` | **Not recorded** in artifacts |
| `displayedFiringAccuracy` in YAML | 30/24/34/26 per scenario | **Not captured** (no YAML dumps in artifacts) |

---

## 8. Evidence gaps

- No saved stderr with prefire-specific `FAIL:` lines or `3 test(s) failed.`
- No recorded `$LASTEXITCODE` alongside harness output for the failing run
- No confirmation whether the executed binary included `seedSoldierFiringStats` and `CompanionSnapshot.cpp` health guard (source has both; `out5.txt` predates prefire step entirely)
- No post-fix bounded run log in-repo

---

## 9. Proposed minimal correction (single change)

**One change:** Ensure every prefire scenario’s `BattleUnit` is created with **positive `getBaseStats()->health`** and deterministic firing **before** any snapshot export or `getFiringAccuracy` use.

**Canonical location (already present in source—verify in the binary under test):**

- `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`
  - Keep **`seedSoldierFiringStats`** at ~L2041–L2048
  - Keep call order: `addRosterSoldier` → **`seedSoldierFiringStats`** → **`addSoldierUnit`** (all four blocks, ~L2059–L2131)

If a future edit needs a single hunk because seed is missing in a branch, add **only** `seedSoldierFiringStats` + four call sites (no changes to engine math or literals).

**Do not rely on** `CompanionSnapshot.cpp` guard to satisfy the test—fix the fixture.

**Optional follow-up (not the single P0 fix):** Align scenario 2 inner guard with scenario 1: `if (snap.IsDefined() && snap["displayedFiringAccuracy"].IsDefined())` ~L2092 to avoid cascading false failures when export is skipped.

**Keep** production guard at `CompanionSnapshot.cpp` ~L715–L720.

---

## 10. Bounded verification command (approval required; not run for this RCA)

Incremental rebuild of the serialization test target, then one harness execution with captured exit code:

```powershell
Set-Location "E:\Open X-Com Companion\engine\OpenXcom\build-isolated-m1-23e"
msbuild src\companion_snapshot_serialization_test.vcxproj /p:Configuration=Debug /t:ClCompile,Link
$log = "E:\Open X-Com Companion\local\m0\audits\.relay-scratch\prefire-harness-verify-01.txt"
& ".\bin\Debug\companion_snapshot_serialization_test.exe" *>&1 | Tee-Object -FilePath $log
Write-Host "LASTEXITCODE=$LASTEXITCODE"
```

**Pass criteria:** stderr ends with `companion_snapshot_serialization_test: all tests passed.` and `LASTEXITCODE=0`; log contains prefire step with **no** `FAIL:` lines after it.

---

## 11. Assertion map (for interpreting a future log)

| Scenario | Assertions (message keys) |
|----------|---------------------------|
| Standing | `unit actionCosts exported`; `snap displayedFiringAccuracy exported`; `snap displayedFiringAccuracy matches getFiringAccuracy`; `no two-hand penalty when off-hand empty`; `snap accuracy 60*50/100 standing` |
| Grenade | `penalty snap exported`; `two-hand penalty with grenade off-hand`; `penalty snap matches engine`; `snap 30 * 80% two-hand penalty` |
| Kneel | `kneel snap action exported`; `kneel snap 30*115/100`; `kneel snap matches engine` |
| Wounded | `wounded snap action exported`; `health modifier reflected in displayed accuracy`; `wounded snap matches engine` |

---

*End of ASTER-M1-PREFIRE-HARNESS-RCA-01.*