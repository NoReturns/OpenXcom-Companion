# ASTER-M1-PREFIRE-CLEANUP-19

**Mode:** Test harness cleanup only (no build, no tests)  
**Date:** 2026-11-14  
**Basis:** RUN-17 PASS, FULL-18 PASS, BUILD-16 binary

---

## 1. Removed (TRACE-12 diagnostics)

| Item | Location (prior) |
|------|------------------|
| `g_snapshotPrefireOnlyDiag` | File scope |
| `g_prefireTraceCheckpoint` | File scope |
| `prefireTraceAt()` | Helper + all call sites (13 checkpoints in prefire test) |
| `prefire-trace:` stderr lines | Scenario enter / buildSnapshot / assertions / complete |
| Checkpoint in exception messages | Replaced with `prefire-only:` prefix without checkpoint label |

**Includes retained:** `<exception>`, `<typeinfo>` (isolated-path exception reporting).

---

## 2. Preserved

| Behavior | Status |
|----------|--------|
| `--prefire-only` CLI | `snapshotTestPrefireOnlyRequested()` unchanged |
| Isolated run runs **only** `testPrefireDisplayedFiringAccuracyOnFirearmActions` | Yes |
| `try` / `catch (std::exception&)` / `catch (...)` on isolated path | Yes — logs `prefire-only: UNCAUGHT …`, `++g_failures`, `snapshotTestFinish()` → nonzero |
| Full suite order | Unchanged `SNAPSHOT_TEST_STEP` list |
| `snapshotTestFinish()` | Unchanged |
| `setBattleUnitCurrentHealthForTest()` + armor/fatalWounds | Yes (FIX-15) |
| `ensurePrefireBattleUnitStats` / `seedSoldierFiringStats` | Yes |
| Literals **30 / 24 / 34 / 26** + engine-match expects | Yes |
| Four scenario blocks | Unchanged logic |

**Production / `CompanionSnapshot.cpp`:** not touched.

---

## 3. Exact source changes

**File:** `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`

```diff
- static bool g_snapshotPrefireOnlyDiag;
- static const char *g_prefireTraceCheckpoint;
- static void prefireTraceAt(const char *label) { ... }

 testPrefireDisplayedFiringAccuracyOnFirearmActions:
- all prefireTraceAt(...) lines (14 calls)

 main (--prefire-only):
- g_snapshotPrefireOnlyDiag = true/false;
- prefireTraceAt after successful return;
- "prefire-trace: UNCAUGHT ... at [checkpoint]"

+ "prefire-only: UNCAUGHT std::exception type=... what=..."
+ "prefire-only: UNCAUGHT non-std exception"
```

No other files modified.

---

## 4. Unintended-change review

| Check | Result |
|-------|--------|
| Other tests | Unmodified |
| Prefire assertions/fixtures | Only trace lines removed |
| Full-suite prefire invocation | Still `SNAPSHOT_TEST_STEP` (no try/catch — same as before TRACE-12 full path) |
| grep `prefireTrace` / `prefire-trace` | **No matches** |

---

## 5. Remaining verification (not done in this pass)

BUILD-16 exe (**14:54:57**) does **not** include this cleanup. Before relying on tree state:

1. **One** incremental build of `companion_snapshot_serialization_test.vcxproj`.
2. **One** `--prefire-only` run (expect exit **0**, no trace noise, same accuracy behavior).
3. **One** full harness run (expect exit **0**, same as FULL-18).

Optional: remove TRACE-12 references from audit docs only (no code requirement).

---

## 6. Summary

Temporary TRACE-12 instrumentation removed; **regression contract** from RUN-17/FULL-18 retained in source, with a slimmer isolated path that still surfaces C++ exceptions without per-scenario trace spam.