# ASTER-M1-PREFIRE-FULL-18

**Mode:** One full-suite verification (no `--prefire-only`, no rebuild)  
**Date:** 2026-11-14  
**Binary:** Same as RUN-17 / BUILD-16 (`14:54:57`)

---

## 1. Preconditions

| Check | Result |
|-------|--------|
| Exe timestamp | **2026-11-14 14:54:57** |
| Same binary as RUN-17 | Yes |
| Rebuild / source change | None |

---

## 2. Execution window

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **14:58:20** (local) |
| **End** | 2026-11-14 **14:58:21** (local) |
| **Duration** | ~1 s |
| **Invocations** | **1** (no argument → full suite) |

| Stream | Path |
|--------|------|
| stdout | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-FULL-18-stdout.txt` |
| stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-FULL-18-stderr.txt` (63 step lines) |

---

## 3. Process result

| Field | Value |
|-------|--------|
| **Exit code** | **0** |
| **stdout** | `companion_snapshot_serialization_test: all tests passed.` |
| **`FAIL:` / `failed.`** | None |
| **Uncaught exception** | None (full suite does not wrap prefire in TRACE-12 try/catch) |

---

## 4. Windows Application log

**Execution window ±1 s:** **0** matching `companion_snapshot` / `0xC0000094` / `0xC0000005` events.

---

## 5. Sequence coverage

Stderr step banners run from:

1. `testHealthySoldierWp2Fields`  
… through …  
61. `testPrefireDisplayedFiringAccuracyOnFirearmActions`  
62. `testKneeledMovementTuAdvisory`  
63. `testTuReservationSnapshotFields` (final step before success summary)

**Note:** Full-suite prefire runs without `--prefire-only`, so **TRACE-12 checkpoints are disabled** (only the standard `SNAPSHOT_TEST_STEP` banner for prefire). Pass/fail is via `g_failures` / stdout summary.

---

## 6. Verification

| Criterion | Result |
|-----------|--------|
| Complete harness sequence | **PASS** (first → last step present) |
| `all tests passed.` | **PASS** |
| Exit **0** | **PASS** |
| No FAIL lines | **PASS** |
| No relevant WER | **PASS** |

---

## 7. Overall verdict

| Gate | Result |
|------|--------|
| **Full serialization harness (P0 suite)** | **PASS** |
| **Isolated prefire (RUN-17)** | Already **PASS** (unchanged) |

Together: **BUILD-16 binary** passes both **isolated prefire** and **full** `companion_snapshot_serialization_test` on this workstation run.

---

## 8. Evidence

- `ASTER-M1-PREFIRE-FULL-18-stdout.txt`
- `ASTER-M1-PREFIRE-FULL-18-stderr.txt`