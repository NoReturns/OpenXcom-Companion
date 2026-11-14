# ASTER-M1-PREFIRE-BUILD-16

**Mode:** Minimal assertion patch + one build (no test execution)  
**Date:** 2026-11-14  
**Target:** `build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj` (Debug|Win32)

---

## 1. FIX-15 confirmation

| Requirement | Status | Location |
|-------------|--------|----------|
| `setBattleUnitCurrentHealthForTest()` | Present | ~L2067–2074 |
| `armor` + `fatalWounds` in load node | Present | ~L2071–2072 |
| Scenario 4 current health **25** | `setBattleUnitCurrentHealthForTest(unit, 25)` | ~L2194 |
| Base health **50** | `seedSoldierFiringStats(..., 50)`, `ensurePrefireBattleUnitStats(..., 50)` | ~L2190–2192 |
| Firing **60** | `seed` + `ensurePrefire` | ~L2190–2192 |

---

## 2. Assertion correction (scenario 4 only)

**Added** inside `if (snap.IsDefined() && snap["displayedFiringAccuracy"].IsDefined())`:

```cpp
expect(snap["displayedFiringAccuracy"].as<int>() == 26,
    "wounded snap 25/50 health at snap 50%");
```

**Retained:**

- `expected` from `getAccuracyModifier` / engine formula
- Match to `unit->getFiringAccuracy(...)`
- All scenarios 1–3 assertions unchanged

---

## 3. Build

**Single MSBuild** (`/m:1`, `/nr:false`, `CL_MPCount=1`, `UseMultiToolTask=false`).

| Metric | Value |
|--------|--------|
| **Exit code** | **0** |
| **Outcome** | Build succeeded |
| **Time** | 00:00:03.20 |
| **Errors** | 0 |
| **Warnings** | 2 × `LNK4075` |

**Log:** `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-BUILD-16-msbuild.log`

---

## 4. Timestamps

| Artifact | Last write (local) | Size |
|----------|-------------------|------|
| Source | 2026-11-14 **14:54:52** | 101,382 bytes |
| Object | 2026-11-14 **14:54:55** | 3,095,890 bytes |
| Executable | 2026-11-14 **14:54:57** | 10,954,240 bytes |

---

## 5. Current source diff (vs BUILD-13 baseline)

**FIX-15 (WOUND-FIX-15):**

```diff
+static void setBattleUnitCurrentHealthForTest(BattleUnit *unit, int currentHealth) { ... armor/fatalWounds ... }
- unit->load(YAML::Load("health: 25\n"));
+ setBattleUnitCurrentHealthForTest(unit, 25);
  ensurePrefire: setBattleUnitCurrentHealthForTest instead of health-only YAML::Node
```

**BUILD-16:**

```diff
+ expect(snap["displayedFiringAccuracy"].as<int>() == 26,
+     "wounded snap 25/50 health at snap 50%");
```

No production or `CompanionSnapshot.cpp` changes.

---

## 6. Next step (not executed)

One authorized run:

```text
companion_snapshot_serialization_test.exe --prefire-only
```

Unfiltered stdout/stderr; verify literals **30 / 24 / 34 / 26**, full TRACE-12 trail, exit **0**.

**P0 (full suite):** still separate.