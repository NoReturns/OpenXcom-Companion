# ASTER-M1-PREFIRE-WOUND-FIX-15

**Mode:** Minimal source correction (test harness only)  
**Date:** 2026-11-14  
**Evidence:** `ASTER-M1-PREFIRE-RUN-14.md`

---

## 1. Confirmed exception cause

### Failing path

`BattleUnit::load(const YAML::Node &node)` in `engine/OpenXcom/src/Savegame/BattleUnit.cpp`:

```331:334:engine/OpenXcom/src/Savegame/BattleUnit.cpp
	for (int i=0; i < 5; i++)
		_currentArmor[i] = node["armor"][i].as<int>(_currentArmor[i]);
	for (int i=0; i < 6; i++)
		_fatalWounds[i] = node["fatalWounds"][i].as<int>(_fatalWounds[i]);
```

Scenario 4 (previously ~L2186) called:

```cpp
unit->load(YAML::Load("health: 25\n"));
```

With no `armor` (or `fatalWounds`) key, yaml-cpp subscripting `node["armor"][i]` yields **`YAML::InvalidNode`** with **`first invalid key: "armor"`** — matching RUN-14.

**When it ran:** After scenario 4 `enter`, before `buildSnapshot done` (during `unit->load`, not during snapshot export).

### Why scenarios 1–3 were unaffected

`ensurePrefireBattleUnitStats` only called `unit->load` when `getHealth() != currentHealth`. For scenarios 1–3, `currentHealth == 50` and the unit already had **50**, so the **health-only** load path was **skipped**. Scenario 4 explicitly invoked health-only `load` to wound the unit.

### API search

`BattleUnit` exposes **`getHealth()`** but **no `setHealth()`**. **`heal()`** adjusts health only in a fatal-wound context. **`setTimeUnits()`** exists for TU only.  
**Conclusion:** No supported setter for arbitrary current health without `load()`.

---

## 2. Exact source change (test file only)

**File:** `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`

| Change | Location |
|--------|----------|
| Add `setBattleUnitCurrentHealthForTest(BattleUnit *unit, int currentHealth)` | After `seedSoldierFiringStats` (~L2066–2074) |
| `ensurePrefireBattleUnitStats`: replace health-only `YAML::Node` + `load` | ~L2089–2091 |
| Scenario 4: replace `unit->load(YAML::Load("health: 25\n"))` | ~L2194 |

**Helper (test-only):**

```cpp
static void setBattleUnitCurrentHealthForTest(BattleUnit *unit, int currentHealth)
{
	YAML::Node n;
	n["health"] = currentHealth;
	n["armor"] = YAML::Load("[0,0,0,0,0]");
	n["fatalWounds"] = YAML::Load("[0,0,0,0,0,0]");
	unit->load(n);
}
```

Same **`armor` / `fatalWounds`** pattern already used elsewhere in this test TU (e.g. unconscious fixtures ~L579, ~L613).

**Unchanged:**

- `getBaseStats()->health` remains **50** (set in `ensurePrefireBattleUnitStats` / `seedSoldierFiringStats`).
- Firing **60**, literals **30/24/34/26** (scenario 4 uses dynamic `expected` from engine modifier, still **26** at snap 50%).
- Scenarios **1–3** logic, TRACE-12, `--prefire-only`, production / `CompanionSnapshot.cpp`.

---

## 3. Why replacement is safe

- Uses the **existing** `BattleUnit::load` contract: supplies keys the implementation **always** reads.
- Sets **only** current `_health` to the requested value; **`_stats.health` (base)** untouched (load does not rewrite `_stats`).
- Armor/fatal wound arrays set to **zeros** — wounded accuracy test intent is **health fraction**, not crit wounds (aligns with prior fixture design).
- Matches established **serialization test** save-snippet style; **no** production changes.

---

## 4. Expected wounded scenario state (after fix)

| Field | Value |
|-------|--------|
| `getBaseStats()->health` | **50** |
| `getHealth()` | **25** |
| `getBaseStats()->firing` | **60** |
| `getAccuracyModifier` (standing, rifle) | **87** (`25*25/50+75`, integer division) |
| Snap weapon acc 50% | **30** pre-mod → **26** displayed (`60*50/100 * 87/100`) |
| Literal assert in scenario 4 | Via **`expected`** + engine match (not hard-coded **26** in source, same as before) |

---

## 5. Remaining verification requirements

**Not run in this pass** (per authorization):

1. **One** incremental build of `companion_snapshot_serialization_test.vcxproj` (BUILD-10/13 settings).
2. **One** `companion_snapshot_serialization_test.exe --prefire-only` with **unfiltered** stderr.
3. **Acceptance (isolated prefire):**
   - All four scenarios: `buildSnapshot done` + `assertions done`
   - `prefire test: all scenarios complete` / `returned to main`
   - No `UNCAUGHT std::exception`
   - `all tests passed.` on stdout (if `g_failures == 0`)
   - Exit code **0**
   - WER none in run window
4. **Separate gate:** full serialization suite still required for broader P0.

---

## 6. Blocker status

**No blocker** — safe test-only correction applied without new production APIs or `BattleUnit::load()` edits.