# ASTER-M1-PREFIRE-RUN-14

**Mode:** Single diagnostic execution (TRACE-12, no rebuild)  
**Date:** 2026-11-14  
**Executable:** `build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe`  
**Argument:** `--prefire-only`

---

## 1. Preconditions

| Check | Result |
|-------|--------|
| Exe timestamp | **2026-11-14 14:50:20** (matches BUILD-13) |
| Rebuild / source change | None |
| Other build/test process | Not detected |

---

## 2. Execution window

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **14:51:10** (local) |
| **End** | 2026-11-14 **14:51:11** (local) |
| **Duration** | ~1 s |
| **Exit code** | **1** |

**Logs (complete, unfiltered):**

| Stream | Path |
|--------|------|
| stdout | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-14-stdout.txt` |
| stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-14-stderr.txt` |

---

## 3. Windows Application log (exact window)

**Query:** Application log **14:51:09–14:51:13**, filter `companion_snapshot`, `0xC0000094`, `0xC0000005`, `0xE06D7363`.

**Result:** **0** matching events.

---

## 4. Trace and failure evidence (stderr)

```
companion_snapshot_serialization_test: testPrefireDisplayedFiringAccuracyOnFirearmActions
prefire-trace: scenario 1 standing: enter
prefire-trace: scenario 1 standing: buildSnapshot done
prefire-trace: scenario 1 standing: assertions done
prefire-trace: scenario 2 grenade two-hand: enter
prefire-trace: scenario 2 grenade two-hand: buildSnapshot done
prefire-trace: scenario 2 grenade two-hand: assertions done
prefire-trace: scenario 3 kneeling: enter
prefire-trace: scenario 3 kneeling: buildSnapshot done
prefire-trace: scenario 3 kneeling: assertions done
prefire-trace: scenario 4 wounded: enter
prefire-trace: UNCAUGHT std::exception at [scenario 4 wounded: enter] type=class YAML::InvalidNode what=invalid node; first invalid key: "armor"
1 test(s) failed.
```

| Signal | Present |
|--------|---------|
| **`FAIL:` lines** | No (failure via exception handler, not `expect`) |
| **`all tests passed.`** | No (stdout empty) |
| **Failure summary** | `1 test(s) failed.` (stderr) |

---

## 5. Analysis (evidence-bound)

### Last checkpoint

**`scenario 4 wounded: enter`** — updated at block entry; **`scenario 4 wounded: buildSnapshot done` was not reached.**

### Failure location (inferred from checkpoints only)

Within **scenario 4**, after block entry and **before** `findUnitByIdDirect(..., 84, 4)` returns (checkpoint immediately after that call). Static order in source:

1. Fixture / roster / seed / `addSoldierUnit` / `ensurePrefireBattleUnitStats`
2. `placeUnitOnDiscoveredTile`
3. `unit->load(YAML::Load("health: 25\n"))`
4. `expect` base health
5. `equipWeaponInRightHand`
6. **`findUnitByIdDirect` → `buildSnapshot`**

**Cannot subdivide further** without more instrumentation; exception is consistent with code on this path (including snapshot build).

### Exception

| Field | Value |
|-------|--------|
| Class | **`YAML::InvalidNode`** (`std::exception`) |
| **what()** | `invalid node; first invalid key: "armor"` |
| Checkpoint at throw | `scenario 4 wounded: enter` |

### Termination class

| Class | Applies? |
|-------|----------|
| Normal `expect()` failure | **No** (`FAIL:` absent) |
| **Uncaught C++ exception (caught by TRACE-12 boundary)** | **Yes** |
| SEH / `0xC0000094` | **No** (no WER; explicit yaml-cpp exception) |
| Prior RUN-11 silent abort | **No** — TRACE-12 shows scenarios 1–3 complete |

### Scenarios

| Scenario | buildSnapshot | assertions | Literal check |
|----------|---------------|------------|---------------|
| 1 standing | done | done | **30** implied by assertions done (not logged numerically) |
| 2 grenade | done | done | **24** implied |
| 3 kneeling | done | done | **34** implied |
| 4 wounded | **not reached** | **not reached** | **26** not verified |

---

## 6. Acceptance (isolated prefire)

| Criterion | Result |
|-----------|--------|
| All four scenarios complete | **FAIL** (scenario 4 incomplete) |
| 30 / 24 / 34 / 26 | **FAIL** (26 not reached; 30/24/34 not captured as values, only trace completion) |
| `all tests passed.` | **FAIL** |
| Exit code 0 | **FAIL** (got **1**) |
| No relevant crash event | **PASS** |

### Overall

**ASTER-M1-PREFIRE-RUN-14: FAIL**

**Isolated prefire regression:** not established.  
**Full serialization suite:** not run; separate gate unchanged.

---

## 7. Preserved artifacts

- `ASTER-M1-PREFIRE-RUN-14-stdout.txt` — empty  
- `ASTER-M1-PREFIRE-RUN-14-stderr.txt` — full trace above  

**No fix, no rerun** (per authorization).