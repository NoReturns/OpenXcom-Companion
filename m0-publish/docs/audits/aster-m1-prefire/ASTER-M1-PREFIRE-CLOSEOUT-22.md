# ASTER-M1-PREFIRE-CLOSEOUT-22

**Mode:** Final full-suite verification (BUILD-20, no rebuild)  
**Date:** 2026-11-14  

---

## 1. Binary precheck

| Field | Value |
|-------|--------|
| **Path** | `build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe` |
| **Timestamp** | **2026-11-14 15:04:18** (local) |
| **SHA-256** | **12F0E4744015724023872D4D37B828549A79233C75ED9BF6727478292D7C0DBC** |
| **Build reference** | ASTER-M1-PREFIRE-BUILD-20 (CLEANUP-19 source) |

---

## 2. Execution

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **15:06:28** (local) |
| **End** | 2026-11-14 **15:06:29** (local) |
| **Duration** | ~1 s |
| **Argument** | *(none — full suite)* |
| **Runs** | **1** |

| Stream | Path |
|--------|------|
| stdout | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-CLOSEOUT-22-stdout.txt` |
| stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-CLOSEOUT-22-stderr.txt` |

| Field | Value |
|-------|--------|
| **Exit code** | **0** |
| **Step banners (stderr lines)** | **63** |
| **stdout** | `companion_snapshot_serialization_test: all tests passed.` |

---

## 3. Windows Application log

**Window:** execution ±1 s.  
**Relevant events:** **0**

---

## 4. Acceptance

| Criterion | Result |
|-----------|--------|
| Complete serialization suite | **PASS** (`testHealthySoldierWp2Fields` → `testTuReservationSnapshotFields`) |
| **63** step banners | **PASS** |
| Prefire step present | **PASS** (line 61: `testPrefireDisplayedFiringAccuracyOnFirearmActions`) |
| Prefire accuracy **30/24/34/26** | **PASS** (implied: exit 0, no FAIL; literals in source at BUILD-20) |
| No FAIL / exceptions | **PASS** |
| `all tests passed.` | **PASS** |
| Exit **0** | **PASS** |
| No relevant WER | **PASS** |

---

## 5. Cross-reference

| Audit | Role | Result |
|-------|------|--------|
| **FINAL-21** | Isolated `--prefire-only` on same SHA | **PASS** |
| **CLOSEOUT-22** | Full suite on same SHA | **PASS** |
| RUN-17 / FULL-18 | Pre-cleanup binary (14:54:57) | Historical PASS; superseded by BUILD-20 |

---

## 6. Final P0 disposition

**Recommendation: P0 CLOSED** for:

- Prefire **`displayedFiringAccuracy` / `twoHandedPenaltyActive`** engine export regression (`companion_snapshot_serialization_test` four scenarios, literals **30 / 24 / 34 / 26**).
- **Verified artifact:** source after CLEANUP-19 + executable **SHA-256 `12F0E474…C0DBC`** (BUILD-20).

**Scope of closure:** Test-harness / serialization integration verification on this workstation build tree. **Not** a claim of:

- Git commit / push / CI green elsewhere
- **`openxcom.exe`** or live F6 runtime deployment
- Node `tactical-prefire-accuracy-export.test.cjs` re-run in this closeout (previously 3/3; not re-executed here)

---

## 7. Remaining unverified (explicit)

| Item | Status |
|------|--------|
| Production game binary deployment | Out of scope |
| Remote GitHub / relay inbox | Out of scope |
| Removing audit-only `prefire-only` exception try/catch | Optional future hygiene; not required for P0 |

---

## 8. Verdict

**ASTER-M1-PREFIRE-CLOSEOUT-22: PASS**  
**P0 (prefire accuracy serialization regression): CLOSED** on verified BUILD-20 binary.