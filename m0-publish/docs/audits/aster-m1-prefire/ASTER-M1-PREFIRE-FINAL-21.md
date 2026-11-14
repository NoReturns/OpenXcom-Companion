# ASTER-M1-PREFIRE-FINAL-21

**Mode:** Single isolated verification (BUILD-20 / CLEANUP-19, no rebuild)  
**Date:** 2026-11-14  
**Argument:** `--prefire-only`

---

## 1. Precheck

| Check | Result |
|-------|--------|
| Exe timestamp | **2026-11-14 15:04:18** — OK |
| SHA-256 | **12F0E4744015724023872D4D37B828549A79233C75ED9BF6727478292D7C0DBC** — OK |
| Competing build/test | None observed |

---

## 2. Execution window

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **15:05:27** (local) |
| **End** | 2026-11-14 **15:05:27** (local) |
| **Duration** | ~1 s |
| **Runs** | **1** |

| Stream | Path |
|--------|------|
| stdout | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-FINAL-21-stdout.txt` |
| stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-FINAL-21-stderr.txt` |

---

## 3. Process result

| Field | Value |
|-------|--------|
| **Exit code** | **0** |
| **stdout** | `companion_snapshot_serialization_test: all tests passed.` |
| **stderr** | Step banner only: `testPrefireDisplayedFiringAccuracyOnFirearmActions` |
| **`FAIL:`** | None |
| **`prefire-trace:` / `UNCAUGHT`** | None (CLEANUP-19) |

---

## 4. Windows Application log

**Execution window ±1 s:** **0** relevant events (`companion_snapshot`, `0xC0000094`, `0xC0000005`).

---

## 5. Accuracy verification

Literals are enforced in-source (**30 / 24 / 34 / 26**); isolated run does not log numeric values. **Exit 0** + **no FAIL** ⇒ all `expect()` in four scenario blocks passed.

| Scenario | Contract | Result |
|----------|----------|--------|
| 1 standing | **30** | **PASS** |
| 2 grenade two-hand | **24** | **PASS** |
| 3 kneeling | **34** | **PASS** |
| 4 wounded | **26** | **PASS** |

---

## 6. Acceptance checklist

| Criterion | Result |
|-----------|--------|
| No FAIL lines | **PASS** |
| No uncaught exceptions | **PASS** |
| `all tests passed.` | **PASS** |
| Exit **0** | **PASS** |
| No relevant WER | **PASS** |

---

## 7. Overall verdict

**ASTER-M1-PREFIRE-FINAL-21: PASS**

BUILD-20 executable (`SHA-256` above) passes isolated prefire regression after TRACE-12 removal.

**Note:** FULL-18 validated the **prior** binary (14:54:57). A one-time full harness on BUILD-20 is optional if a single SHA must cover both gates.