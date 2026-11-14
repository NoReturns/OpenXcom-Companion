# ASTER-M1-PREFIRE-RUN-17

**Mode:** Single isolated verification (BUILD-16 binary, no rebuild)  
**Date:** 2026-11-14  
**Argument:** `--prefire-only`

---

## 1. Preconditions

| Check | Result |
|-------|--------|
| Exe timestamp | **2026-11-14 14:54:57** (matches BUILD-16) |
| Build / source change | None |

---

## 2. Execution window

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **14:55:59** (local) |
| **End** | 2026-11-14 **14:55:59** (local) |
| **Duration** | ~1 s |
| **Invocations** | 1 |

| Stream | Path |
|--------|------|
| stdout | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-17-stdout.txt` |
| stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-17-stderr.txt` |

---

## 3. Process result

| Field | Value |
|-------|--------|
| **Exit code** | **0** |
| **stdout** | `companion_snapshot_serialization_test: all tests passed.` |
| **`FAIL:` lines** | None |
| **UNCAUGHT exception** | None |
| **Failure summary** | None |

---

## 4. Windows Application log

**Window:** execution ±1 s.  
**Matching crash events:** **None**.

---

## 5. Scenario results (TRACE-12 + assertions)

Literal checks are not logged numerically; **`assertions done`** after each `buildSnapshot done` implies all `expect()` in that block passed (including literals **30 / 24 / 34 / 26** and engine-match expects).

| Scenario | buildSnapshot | assertions | Literal (contract) |
|----------|---------------|------------|--------------------|
| 1 standing | done | done | **30** |
| 2 grenade two-hand | done | done | **24** |
| 3 kneeling | done | done | **34** |
| 4 wounded | done | done | **26** (explicit in BUILD-16) |

**Trace tail:** `prefire test: all scenarios complete` → `prefire test: returned to main`

---

## 6. Verification matrix

| Criterion | Result |
|-----------|--------|
| Standing **30** | **PASS** (assertions done) |
| Grenade **24** | **PASS** |
| Kneeling **34** | **PASS** |
| Wounded **26** | **PASS** |
| All four assertion blocks | **PASS** |
| No FAIL / uncaught exception | **PASS** |
| `all tests passed.` | **PASS** (stdout) |
| Exit **0** | **PASS** |
| No relevant WER | **PASS** |

---

## 7. Overall verdict

| Gate | Result |
|------|--------|
| **Isolated prefire (`--prefire-only`)** | **PASS** |
| **Full `companion_snapshot_serialization_test` suite (60+ steps)** | **Not run** — remains a **separate P0 acceptance** requirement |

---

## 8. Evidence files

- `ASTER-M1-PREFIRE-RUN-17-stdout.txt`
- `ASTER-M1-PREFIRE-RUN-17-stderr.txt`