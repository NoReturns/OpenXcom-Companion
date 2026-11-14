# ASTER-M1-PREFIRE-RUN-11

**Mode:** Single isolated test execution (no rebuild)  
**Date:** 2026-11-14  
**Workspace:** `E:\Open X-Com Companion`  
**Binary:** `build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe`  
**Arguments:** `--prefire-only`

---

## 1. Executable

| Field | Value |
|-------|--------|
| Path | `E:\Open X-Com Companion\build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe` |
| Exists | Yes |
| Last write (local) | **2026-11-14 14:46:02** |
| Size | 10,950,656 bytes |
| Built under | ASTER-M1-PREFIRE-BUILD-10 (harness includes `--prefire-only`) |

---

## 2. Execution window

| Field | Value |
|-------|--------|
| **Start** | 2026-11-14 **14:47:16** (local) |
| **End** | 2026-11-14 **14:47:19** (local) |
| **Duration** | ~3 s |
| **Invocations** | **1** (authorized single run) |
| **MSBuild / recompile** | None |

**Capture method:** `cmd /c` with separate redirects (unfiltered).

| Stream | Path |
|--------|------|
| **stdout** | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-11-stdout.txt` |
| **stderr** | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-RUN-11-stderr.txt` |

---

## 3. Process result

| Field | Value |
|-------|--------|
| **Exit code** | **3** |
| **stderr summary line** | `companion_snapshot_serialization_test: testPrefireDisplayedFiringAccuracyOnFirearmActions` |
| **stdout** | **(empty file)** |
| **`FAIL:` lines** | **None** |
| **`N test(s) failed.`** | **None** |
| **`all tests passed.`** | **None** |

---

## 4. Windows Application log (execution window only)

**Query:** Application log from **14:47:15** through **14:47:21** (±1 s padding), filter: `companion_snapshot`, `0xC0000094`, `0xC0000005`, `0xE06D7363`.

**Result:** **No matching events** in this window.

Older **14:07** `0xC0000094` events (see `ASTER-M1-PREFIRE-DIAG-03.md`) are **not** attributed to this run.

---

## 5. Verification matrix (requested vs observed)

| Check | Expected | Observed | Status |
|-------|----------|----------|--------|
| Standing displayed accuracy | 30 | *(not reached — no YAML/assert output)* | **Not verified** |
| Two-hand grenade penalty | 24 | *(not reached)* | **Not verified** |
| Kneeling accuracy | 34 | *(not reached)* | **Not verified** |
| Wounded accuracy | 26 | *(not reached)* | **Not verified** |
| No unexpected missing YAML fields | Asserted in test | No `FAIL:` naming export omissions | **Inconclusive** |
| `all tests passed.` | Present | Absent | **FAIL** |
| Process exit code | 0 | **3** | **FAIL** |
| No relevant new crash event | None in window | None in window | **PASS** (WER) |

---

## 6. Last completed operation

1. `main` parsed `--prefire-only` and entered isolated branch (inferred — only prefire banner emitted, not full suite).
2. **`SNAPSHOT_TEST_STEP` printed:** `companion_snapshot_serialization_test: testPrefireDisplayedFiringAccuracyOnFirearmActions`.
3. **Process terminated** before any `expect()`-emitted **`FAIL:`**, before **`snapshotTestFinish()`** summary on stdout/stderr.

**Inferred stop location:** Inside `testPrefireDisplayedFiringAccuracyOnFirearmActions` (likely scenario 1, first `findUnitByIdDirect` / post-snapshot assertions, or abnormal termination without `expect` output). **No per-scenario evidence** in this run (isolated mode had no temporary diag lines).

**Termination class:** **Abnormal or early exit** consistent with prior full-harness prefire stops **without** `FAIL:` trail; **not** demonstrated as normal `g_failures` completion (no failure count line). **No WER** in this window.

---

## 7. Prefire-only verdict

| Gate | Result |
|------|--------|
| **ASTER-M1-PREFIRE-RUN-11 (`--prefire-only`)** | **FAIL** |
| **Full serialization suite P0** | **Still required separately** — not exercised; remains **BLOCKED** from prior audits |

---

## 8. Failure evidence (preserve)

- `ASTER-M1-PREFIRE-RUN-11-stdout.txt` — empty  
- `ASTER-M1-PREFIRE-RUN-11-stderr.txt` — single banner line  
- Exit code **3**  
- Cross-reference static RCA: `ASTER-M1-PREFIRE-STATIC-RCA-08.md`, build: `ASTER-M1-PREFIRE-BUILD-10.md`

**Per run authorization:** No fix applied, **no second execution**.

---

## 9. Next authorized work (not performed here)

Static or minimally invasive diagnosis of failure **inside** prefire after isolation (e.g. unfiltered run with safe logging, or debugger) — **only when explicitly authorized**. Do not infer pass from faster loop; this run **did not** validate accuracy literals.