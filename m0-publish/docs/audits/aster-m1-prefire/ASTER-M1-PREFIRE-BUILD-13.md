# ASTER-M1-PREFIRE-BUILD-13

**Mode:** Single targeted build (TRACE-12 instrumentation, no test execution)  
**Date:** 2026-11-14  
**Target:** `build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj`  
**Configuration:** Debug|Win32

---

## 1. TRACE-12 source verification

Present in `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`:

| Construct | Evidence |
|-----------|----------|
| `g_snapshotPrefireOnlyDiag` | ~L37 |
| `prefireTraceAt` / `prefire-trace:` | ~L40–48 |
| Scenario checkpoints (×4) | ~L2096+ |
| Isolated `try` / `catch (std::exception&)` / `catch (...)` | ~L2293+ |

Reference audit: `ASTER-M1-PREFIRE-TRACE-12.md`

---

## 2. MSBuild (one invocation)

```text
MSBuild.exe "E:\Open X-Com Companion\build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj"
  /p:Configuration=Debug /p:Platform=Win32
  /m:1 /nr:false
  /p:CL_MPCount=1 /p:UseMultiToolTask=false
  /v:normal
```

**Full log:** `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-BUILD-13-msbuild.log`

---

## 3. Result

| Field | Value |
|-------|--------|
| **Exit code** | **0** |
| **Outcome** | **Build succeeded.** |
| **Time** | 00:00:01.97 |
| **Errors** | 0 |
| **Warnings** | 1 × `LNK4075` (`/MANIFESTUAC` vs `/MANIFEST:NO`) |

`companion_snapshot_serialization_test.cpp` recompiled (CL in log).

---

## 4. Timestamps

| Artifact | Last write (local) | Size |
|----------|-------------------|------|
| Source | 2026-11-14 **14:49:25** | 100,935 bytes |
| Object | 2026-11-14 **14:50:20** | 3,072,669 bytes |
| Executable | 2026-11-14 **14:50:20** | 10,950,656 bytes |

---

## 5. Constraints

- No test execution  
- No solution / `openxcom.exe` build  
- No source edits during build  
- No retry  
- No commit / push / deploy  

**Next (when authorized):** single `companion_snapshot_serialization_test.exe --prefire-only` with unfiltered stderr (TRACE-12 run).