# ASTER-M1-PREFIRE-STATIC-RCA-08

**Mode:** Strictly read-only (no builds, no test runs, no source edits, no commits)  
**Date:** 2026-11-14  
**Status:** **P0 BLOCKED**  
**Workspace:** `E:\Open X-Com Companion`  
**Canonical build tree:** `build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe`

---

## Executive summary

Diagnostic evidence from **2026-11-14 ~14:38–14:39 local** shows scenario 1 reaches **positive fixture health**, **`getFiringAccuracy == 30`**, and **`CompanionSnapshotBuild::buildSnapshot` completes** for unit 81. The process still exits **3** with **no `FAIL:` lines** in the captured filter output and **no harness completion summary**.

**Older runs** (through ~14:07, `ASTER-M1-PREFIRE-VERIFY-02` / `DIAG-03`) show a **different termination class**: **Application Error `0xC0000094`** (divide-by-zero in `BattleUnit::getAccuracyModifier`) with stderr stopping at the prefire step banner only. Those events must **not** be attributed to the **14:39** execution window.

Because the **best** recent run (**terminal 550799**) used a **filtered** stderr pipeline and **no unfiltered artifact** was saved for that exact execution, the failure mode after `after buildSnapshot` is **not proven** to be normal `expect()` / `g_failures` completion. Static analysis narrows the remaining failure to **scenario 1 post-snapshot checks**, **scenarios 2–4**, or **abnormal termination** (uncaught `yaml-cpp` conversion, or SEH) — with **insufficient log proof** to pick one.

**Most likely root cause (post–`ensurePrefire`, latest epoch):** **Test harness observation gap / possible abnormal termination or assertion after successful export**, not fixture health=0 in scenario 1. **Confidence: medium-low** (evidence incomplete).

**Most likely root cause (14:07 epoch, time-aligned WER):** **Fixture `BattleUnit` base health zero** → **`getAccuracyModifier` divide-by-zero** on first `buildSnapshot` in scenario 1. **Confidence: high** for that epoch only.

---

## 1. Evidence reconciliation

### 1.1 Log inventory (complete vs partial)

| Artifact | When (local) | Unfiltered? | Ends at | Exit / notes |
|----------|----------------|-------------|---------|----------------|
| `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-VERIFY-02.log.err` | ~14:07 | Yes (stderr) | Prefire banner only (L61) | Run paired with **WER 0xC0000094** (`DIAG-03`) |
| `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-FIXTURE-04-stderr.txt` | ~14:35 | Yes | Prefire banner only (L61) | No `FAIL:`, no summary in file |
| `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-05-stderr.txt` | ~14:36 | Yes | Prefire banner only (L61) | Captured via `cmd` redirect |
| `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-06-stderr.txt` | ~14:38 | Yes | Prefire banner only (L61) | Binary likely **without** full diag set |
| `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-07-stderr.txt` | ~14:38 | Mostly yes (PowerShell `Tee-Object`; wrapper noise L1–6) | **Truncated** at `prefire diag s1 getFiringAccuracy=30` (L76); **no** `before/after buildSnapshot` | **No** exit code in file; **no** `FAIL:`; **no** summary |
| **Terminal `550799.txt`** (agent shell) | **14:39:04–14:39:22** | **No — filtered** (`Select-String 'prefire diag\|FAIL\|all tests'`, **last 15**) | Last diag: `prefire diag: scenario1 after buildSnapshot` | **`exit_code: 3`** (recorded) |
| `local/m0/audits/.relay-scratch/prefire-direct-run.txt` | earlier session | Yes | Prefire banner (L67) | No summary |

**Limitation (mandatory):** There is **no complete, unfiltered stdout/stderr file** for the **latest** diagnostic execution that logged **`after buildSnapshot`** (terminal **550799**). **Do not infer** “normal test failure” (`g_failures` + `FAIL:` + `N test(s) failed.`) for that run. The filter **excludes** the `N test(s) failed.` summary line (pattern does not match).

### 1.2 Latest bounded execution (terminal 550799)

| Item | Finding |
|------|---------|
| **Last completed operation (observed)** | `prefire diag: scenario1 after buildSnapshot` |
| **`FAIL:` lines** | **None** among filter matches (pattern included `FAIL`) |
| **Assertion / expect summary** | **Not observed** (`all tests` / `N test(s) failed.` not in filter output) |
| **Process exit** | **`3`** (`elapsed_ms` ~18346) |
| **Tests after prefire** | **Not observed** (`testKneeledMovementTuAdvisory` absent) |
| **Scenario 1 fixture probe** | `baseHealth=50 curHealth=50 weapon=ok`; `getFiringAccuracy=30` |
| **Application Error in same window** | **No audit artifact** records WER for **14:39**; **`DIAG-03` WER is ~14:07** only — **do not merge** |

### 1.3 Earlier epoch (14:07, VERIFY-02 + DIAG-03)

| Item | Finding |
|------|---------|
| **Last completed operation** | Harness printed `testPrefireDisplayedFiringAccuracyOnFirearmActions` only |
| **`FAIL:` / summary** | Absent |
| **Application Error** | **1000** / **`0xC0000094`** on `companion_snapshot_serialization_test.exe`, fault offset consistent with `getAccuracyModifier` `idiv` by `baseStats->health` |
| **Interpretation** | **SEH / abnormal termination**, not demonstrated `main()` failure path |

### 1.4 Reconciling two epochs

| Epoch | Scenario 1 health (evidence) | Snapshot build | Likely class |
|-------|------------------------------|----------------|--------------|
| **~14:07** (WER-aligned) | Not measured live; static zero-health theory | Inferred **inside** first `buildSnapshot` | **A** fixture sync / **B** export calls `getFiringAccuracy` with bad stats |
| **~14:39** (550799) | **50 / 50** measured | **Completed** (diag) | **Unknown** — **C** (post-export check / yaml), **B** (later scenario export), or residual **SEH** without logged WER |

---

## 2. Static code trace

### 2.1 Call chain (scenario 1)

```
testPrefireDisplayedFiringAccuracyOnFirearmActions
  seedSoldierFiringStats(soldier)     [companion_snapshot_serialization_test.cpp ~L2041–2048]
  addSoldierUnit                     [~L171–177 copies Soldier stats into BattleUnit::_stats]
  ensurePrefireBattleUnitStats       [~L2051–2071 sets getBaseStats()->health/firing, syncs _health]
  placeUnitOnDiscoveredTile          [~L350–370]
  equipWeaponInRightHand             [~L2021–2028, prefireTwoHandedFirearmRules + R.rightHand]
  findUnitByIdDirect                 [~L433–437]
    CompanionSnapshotBuild::buildSnapshot   [CompanionSnapshotBuild.h ~L19–24]
      appendUnit → appendFriendlyActionCosts [CompanionSnapshot.cpp ~L827–835, ~L785–805]
        appendHandActionCosts → appendActionEntry [~L727–783, ~L703–725]
          optional: displayedFiringAccuracy / twoHandedPenaltyActive [~L713–720]
  findHandAction(entry["actionCosts"]["hands"]["right"], "snap")  [~L2004–2018]
  expect(...) / .as<int>() / .as<bool>()                         [~L2089–2099]
```

**Semantics alignment:** Export and test both use `BattleUnit::getFiringAccuracy(BA_SNAPSHOT, weapon)` for the live unit and the same `RuleItem` in hand. Literal expectations **30 / 24 / 34 / 26** match documented engine math (firing 60, snap 50%, kneel ×1.15, two-hand occupied ×0.8, health 25/50 modifier) when `ensurePrefire` + `seedSoldierFiringStats` hold.

### 2.2 `ensurePrefireBattleUnitStats` (~L2050–2071)

- Writes **`unit->getBaseStats()`** (`BattleUnit::_stats`): `firing`, `health`, `tu`, `stamina`.
- Syncs **`_health`** via `unit->load(YAML health)` when current ≠ desired.
- **`expect`** on positive base and current health (would emit **`FAIL:`** if violated).

**14:39 probe** (`baseHealth=50 curHealth=50`) supports this helper for scenario 1.

### 2.3 Export: `appendActionEntry` (~L703–725)

Firearm snap/auto/aimed/launch only (`companionFirearmDisplayedAccuracyAction`).

Guard:

```713:720:engine/OpenXcom/src/Engine/CompanionSnapshot.cpp
	if (weapon != 0 && weapon->getRules()->getBattleType() == BT_FIREARM && companionFirearmDisplayedAccuracyAction(type))
	{
		const UnitStats *baseStats = unit->getBaseStats();
		if (baseStats != 0 && baseStats->health > 0)
		{
			entry["displayedFiringAccuracy"] = unit->getFiringAccuracy(type, weapon);
			entry["twoHandedPenaltyActive"] = companionTwoHandedPenaltyActive(unit, weapon);
		}
	}
```

`companionTwoHandedPenaltyActive` (~L694–701): true iff two-handed weapon **and** both `STR_RIGHT_HAND` and `STR_LEFT_HAND` items present.

**Export defect (B)** would mean omitted fields or wrong values; omitted `displayedFiringAccuracy` triggers **`FAIL:`** via `expect` (~L2091), not silent pass.

### 2.4 Test assertions — four scenarios

| # | Unit id | Setup delta | Key expects | Literal | Post-snapshot risk |
|---|---------|-------------|-------------|---------|-------------------|
| **1** | 81 | Standing, rifle only | export + match engine + `twoHandedPenaltyActive == false` + **30** | 30 | `.as<bool>()` on `twoHandedPenaltyActive` **without** `IsDefined()` guard (~L2097) throws if field missing |
| **2** | 82 | + grenade left hand | penalty export + match + **24** | 24 | Inner block guarded on `displayedFiringAccuracy` (~L2117); **twoHandedPenaltyActive** `.as<bool>()` inside guard |
| **3** | 83 | Kneel | snap defined; if accuracy defined → **34** + match | 34 | First expect only `snap.IsDefined()` (~L2141); literal checks gated |
| **4** | 84 | `load(health: 25)` | `expected` from `getAccuracyModifier` + match engine | ~26 | `getAccuracyModifier` **before** snapshot (~L2166); safe if base health **50** |

**Accuracy semantics:** Consistent across export and test **when the same `BattleUnit` and weapon are used**. Scenario 4 explicitly recomputes `expected` from engine APIs rather than hard-coding 26.

### 2.5 Category assignment (evidence-bound)

| Category | 14:07 epoch | 14:39 epoch (550799) |
|----------|-------------|----------------------|
| **A — Fixture init** | **Supported** (WER + no post-banner output; `DIAG-03` idiv) | **Weakened** for scenario 1 (health 50, acc 30) |
| **B — Snapshot export** | **Supported** as trigger path into `getFiringAccuracy` | **Possible** in scenarios **2–4** (no per-scenario diag); scenario 1 build **returned** |
| **C — Test expectation** | Possible secondary (cascade failures) if export omits fields | **Plausible** if export omits `twoHandedPenaltyActive` while `displayedFiringAccuracy` exists (would **throw**, no `FAIL:`) — **not observed in YAML dumps** |
| **D — Later harness steps** | **Ruled out** (never left prefire) | **Ruled out** for steps **after** `testTuReservationSnapshotFields` (never reached); **not ruled out** for prefire **scenarios 2–4** |

---

## 3. Source state

### 3.1 Git

**Workspace root is not a git repository** (`git -C "E:\Open X-Com Companion"` fails). Uncommitted change inventory is **filesystem/timestamp only**.

### 3.2 Files affecting prefire P0

| File | Role | Last write (local) |
|------|------|---------------------|
| `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` | Prefire test, `seedSoldierFiringStats`, `ensurePrefireBattleUnitStats` | **2026-11-14 14:39:26** |
| `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | `displayedFiringAccuracy` / `twoHandedPenaltyActive` export | **2026-11-14 14:07:31** |
| `build-isolated-m1-23e/bin/Debug/companion_snapshot_serialization_test.exe` | Last linked test binary | **2026-11-14 14:39:06** |

### 3.3 Binary vs source drift

| In last compiled binary (~14:39:06) | On disk after (~14:39:26) |
|-------------------------------------|---------------------------|
| `ensurePrefireBattleUnitStats` + prefire scenarios | **Same** (helper retained) |
| Temporary **`prefire diag:`** logging (enter / scenario1 / `before/after buildSnapshot` / s1 probe) | **Removed** from source |
| `seedSoldierFiringStats` before `addSoldierUnit` | **Same** |
| Export health guard | **Same** (obj from 14:07 unless relinked) |

**Authorization note:** A future run from **current source** without rebuild would execute **stale** binary (still with diag). A rebuild from current source would **drop** diag lines and change failure observability.

### 3.4 Intended uncommitted test changes (summary)

- `seedSoldierFiringStats` (~L2041).
- `ensurePrefireBattleUnitStats` (~L2051).
- `testPrefireDisplayedFiringAccuracyOnFirearmActions` four scenarios (~L2073–2178).
- Scenario 2 inner guard uses `displayedFiringAccuracy.IsDefined()` (~L2117) (addresses蠕 optional note from `HARNESS-RCA-01`).

**No production accuracy formula edits** in scope.

---

## 4. Focused prefire execution (harness design, static only)

Current `main()` (`companion_snapshot_serialization_test.cpp` ~L2253–2325):

- **No `argc`/`argv`**, **no** test filter.
- **`SNAPSHOT_TEST_STEP`** runs **~60+** steps sequentially before prefire.

**Ways to run only prefire without full harness** (future, not implemented):

1. **New compile target** — minimal `main` calling only `testPrefireDisplayedFiringAccuracyOnFirearmActions()` + shared fixture TU (smallest incremental link).
2. **`#ifdef` / env gate** in existing `main()` — e.g. skip steps unless `COMPANION_SNAPSHOT_TEST_FILTER=prefire` (requires small source + one obj rebuild).
3. **Separate translation unit** linked into existing exe with weak symbol override — **not** present today.

**Verdict:** Focused prefire runs are **possible** with a **small harness product change**; the monolithic exe **cannot** filter today.

---

## 5. Findings, uncertainties, and smallest proposed correction

### 5.1 Evidence-supported findings

1. **Two termination epochs** exist; only **14:07** has **time-aligned WER** (`0xC0000094`).
2. **14:39** evidence proves scenario 1 **fixture health** and **direct `getFiringAccuracy`** are valid **before** snapshot; **`buildSnapshot` returns** for scenario 1 in that run.
3. **Exit `3`** with **no** observed `FAIL:` in 550799 filter matches is **consistent with abnormal termination** or with **`N test(s) failed.` omitted by filter** — **not** sufficient to conclude assertion failure.
4. Export and test **share** the same accuracy API and literals **when fixtures are valid**.
5. Node validator suite for prefire (`companion/m0-publish/test/tactical-prefire-accuracy-export.test.cjs`) is **orthogonal**; it does not substitute for engine harness pass.

### 5.2 Remaining uncertainties

- **No unfiltered stderr** for the 550799 window.
- **No YAML dump** of `actionCosts` for any scenario in artifacts.
- **Whether failure** is scenario **1 post-snapshot**, **2–4**, or **uncaught `yaml-cpp` exception**.
- **Whether 14:39** exit `3` is **`EXIT_FAILURE` from `main()`** (MSVC often **3**) or **exception-mapped** shell code without WER logged to audits.

### 5.3 Most likely root cause and confidence

| Epoch | Root cause | Confidence |
|-------|------------|------------|
| **14:07 (WER)** | Zero `getBaseStats()->health` on soldier-derived `BattleUnit` → `getAccuracyModifier` **÷0** during first export `getFiringAccuracy` | **High** |
| **14:39 (latest diag)** | **Insufficient log proof**; static best-fit: **failure after successful scenario 1 `buildSnapshot`** (assertion mismatch, yaml throw on `.as<>`, or scenario 2+ export), **not** scenario 1 fixture health | **Medium-low** |

### 5.4 Smallest proposed correction (not implemented)

**If next authorized run still shows omission/throw on scenario 1:**

1. **Keep** `ensurePrefireBattleUnitStats` (addresses **14:07** class **A**).
2. **Harden scenario 1** test only: require `twoHandedPenaltyActive.IsDefined()` before `.as<bool>()` (~L2097), or use safe conversion — avoids **silent process exit** from `yaml-cpp` (**C**).
3. **Do not** relax `CompanionSnapshot.cpp` health guard or engine math.

**If next run shows `FAIL:` export messages (fields missing):** inspect **why guard skipped** export despite positive stats (would be **B**, unexpected given 14:39 probe).

**Verification prerequisite:** One **unfiltered** `2>full-stderr.txt` run, note **exe timestamp**, query **Application** log only for **[run start, run end]**, capture full tail including **`FAIL:`** and **`N test(s) failed.`** / **`all tests passed.`**

### 5.5 Focused test recommendation (process)

Before further full-harness loops, add **(2)** env/filter or **(1)** slim target so prefire validates in **&lt;5 s** link/run cycles.

---

## 6. P0 acceptance (unchanged)

| Criterion | Status |
|-----------|--------|
| Build OK | **Met** (historical) |
| Harness exit **0** + `all tests passed.` | **Not met** |
| Four accuracy literals / engine match | **Not demonstrated in artifacts** |
| No new relevant **`0xC0000094`** in **same** execution window as a passing run | **Not met** |

**P0 remains BLOCKED.**

---

## 7. Source reference index

| Symbol | Location |
|--------|----------|
| `expect` | `companion_snapshot_serialization_test.cpp` ~L35–42 |
| `findUnitByIdDirect` | ~L433–437 |
| `prefireTwoHandedFirearmRules` | ~L1982–2001 |
| `testPrefireDisplayedFiringAccuracyOnFirearmActions` | ~L2073–2178 |
| `main` / `SNAPSHOT_TEST_STEP` | ~L2246–2325 |
| `appendActionEntry` | `CompanionSnapshot.cpp` ~L703–725 |
| `appendFriendlyActionCosts` | ~L785–805 |
| `getFiringAccuracy` / `getAccuracyModifier` | `BattleUnit.cpp` ~L1506–1570 |

---

## 8. Related audits

- `ASTER-M1-PREFIRE-HARNESS-RCA-01.md` — formulas, scenario 2 guard note, exit-code discussion  
- `ASTER-M1-PREFIRE-DIAG-03.md` — **14:07** WER, disassembly, **do not** apply to **14:39** without new events  
- `.relay-scratch/ASTER-M1-PREFIRE-RUN-07-stderr.txt` — partial tee, **truncated** before later diag lines  
- Terminal transcript **`550799`** — filtered **14:39** run with **`after buildSnapshot`**