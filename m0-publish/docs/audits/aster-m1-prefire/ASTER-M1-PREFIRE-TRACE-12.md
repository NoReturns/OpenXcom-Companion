# ASTER-M1-PREFIRE-TRACE-12

**Mode:** Minimal test-only diagnostic patch (no builds, no execution)  
**Date:** 2026-11-14  
**File modified:** `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`

---

## Objective

Next `--prefire-only` run should show **where** execution stops and surface **uncaught standard C++ exceptions** (not SEH).

---

## Mechanism

| Piece | Lines (approx.) | Behavior |
|-------|-----------------|----------|
| `g_snapshotPrefireOnlyDiag` | 37 | Set `true` only in `--prefire-only` branch |
| `g_prefireTraceCheckpoint` | 38 | Last trace label for exception messages |
| `prefireTraceAt(label)` | 40–50 | If diag enabled: update checkpoint, `prefire-trace: …` on stderr, **`flush()`** |
| Scenario checkpoints | 2093–2193 | Four scenarios × enter / buildSnapshot done / assertions done + final complete |
| Isolated `main` path | 2293–2322 | Manual banner (same text as `SNAPSHOT_TEST_STEP`), `try` / `catch (std::exception&)` / `catch (...)`, `++g_failures`, then `snapshotTestFinish()` |

**Full suite path:** unchanged — `g_snapshotPrefireOnlyDiag` stays false; `prefireTraceAt` is a no-op; prefire still invoked via `SNAPSHOT_TEST_STEP` without the try/catch wrapper.

**Includes added:** `<exception>`, `<typeinfo>`

---

## Diagnostic coverage

| Checkpoint label | When |
|------------------|------|
| `prefire test invoke` | Before test call (`main`) |
| `scenario 1 standing: enter` | Start scenario 1 block |
| `scenario 1 standing: buildSnapshot done` | After `findUnitByIdDirect(..., 81, 4)` |
| `scenario 1 standing: assertions done` | End scenario 1 (literals **30** unchanged) |
| `scenario 2 grenade two-hand: enter` | Start scenario 2 |
| `scenario 2 grenade two-hand: buildSnapshot done` | After `findUnitByIdDirect(..., 82, 4)` |
| `scenario 2 grenade two-hand: assertions done` | End scenario 2 (**24**) |
| `scenario 3 kneeling: enter` | Start scenario 3 |
| `scenario 3 kneeling: buildSnapshot done` | After `findUnitByIdDirect(..., 83, 4)` |
| `scenario 3 kneeling: assertions done` | End scenario 3 (**34**) |
| `scenario 4 wounded: enter` | Start scenario 4 |
| `scenario 4 wounded: buildSnapshot done` | After `findUnitByIdDirect(..., 84, 4)` |
| `scenario 4 wounded: assertions done` | End scenario 4 (**26** via `expected`) |
| `prefire test: all scenarios complete` | Normal return tail of test function |
| `prefire test: returned to main` | After successful test return (`main`) |

**Exception output (isolated path only):**

- `prefire-trace: UNCAUGHT std::exception at [<checkpoint>] type=<typeid.name()> what=<ex.what()>`
- `prefire-trace: UNCAUGHT non-std exception at [<checkpoint>]`
- Increments `g_failures` → `snapshotTestFinish()` returns **nonzero**; never prints success if exception caught.

**Explicitly not covered:** Windows **SEH** (`0xC0000094`, etc.) — no `/EH` changes, no vectored handlers, `catch(...)` does not claim SEH coverage.

---

## Preserved (unchanged)

- All `expect()` messages and literals **30 / 24 / 34 / 26**
- `ensurePrefireBattleUnitStats`, `seedSoldierFiringStats`, export/production code
- Default full-suite order and `SNAPSHOT_TEST_STEP` for prefire in full run
- No YAML field suppression

---

## Source diff summary

```diff
+#include <exception>
+#include <typeinfo>
+
+static bool g_snapshotPrefireOnlyDiag;
+static const char *g_prefireTraceCheckpoint;
+static void prefireTraceAt(const char *label);  // gated + flush

 testPrefireDisplayedFiringAccuracyOnFirearmActions:
+  prefireTraceAt per scenario (enter / buildSnapshot done / assertions done)
+  prefireTraceAt("prefire test: all scenarios complete");

 main --prefire-only branch:
-  SNAPSHOT_TEST_STEP(testPrefire...);
+  g_snapshotPrefireOnlyDiag = true;
+  try { testPrefire...(); prefireTraceAt("returned to main"); }
+  catch (std::exception&) { report checkpoint + typeid + what; ++g_failures; }
+  catch (...) { report checkpoint; ++g_failures; }
+  g_snapshotPrefireOnlyDiag = false;
   return snapshotTestFinish();
```

---

## Next authorized step (not in this pass)

1. Single target rebuild of `companion_snapshot_serialization_test.vcxproj` (per BUILD-10 constraints if desired).  
2. One `--prefire-only` run with **unfiltered** stderr — last `prefire-trace:` line bounds failure; exception line if C++ throw.

**Current on-disk binary (RUN-11)** does **not** include this patch until rebuilt.