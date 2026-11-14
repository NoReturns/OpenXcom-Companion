# ASTER-M1-PREFIRE-BUILD-10

**Mode:** Single targeted build only (no test execution)  
**Date:** 2026-11-14  
**Workspace:** `E:\Open X-Com Companion`  
**Target:** `build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj`  
**Configuration:** Debug|Win32

---

## 1. Source verification (`--prefire-only`)

Present in `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp`:

| Symbol / token | Line (approx.) |
|----------------|----------------|
| `snapshotTestPrefireOnlyRequested` | 2254 |
| `"--prefire-only"` | 2258 |
| Early branch in `main(int argc, char **argv)` | 2279–2282 |
| `snapshotTestFinish()` | 2266–2274 |

---

## 2. MSBuild invocation (single run)

**Command (one invocation):**

```text
MSBuild.exe "E:\Open X-Com Companion\build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj"
  /p:Configuration=Debug
  /p:Platform=Win32
  /m:1
  /nr:false
  /p:CL_MPCount=1
  /p:UseMultiToolTask=false
  /v:normal
```

- **No** solution-wide build  
- **No** `openxcom.exe`  
- **No** test binary execution  
- **No** retry on success path  

**Full log:** `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-BUILD-10-msbuild.log`

---

## 3. Result

| Metric | Value |
|--------|--------|
| **MSBuild exit code** | **0** |
| **Outcome** | **Build succeeded.** |
| **Wall time** | 00:00:02.61 |
| **Errors** | 0 |
| **Warnings** | 2 (linker only, see below) |

### Warnings

```
LINK : warning LNK4075: ignoring '/MANIFESTUAC' due to '/MANIFEST:NO' specification
```

(Reported twice in summary for the same project link step — pre-existing project setting, not introduced by harness change.)

### Compile activity

- **Recompiled:** `companion_snapshot_serialization_test.cpp` (CL.exe line in log ~L25–26).  
- **No** compiler `warning C####` or `error` lines in the log.

---

## 4. Timestamps (freshness)

| Artifact | Last write (local) | Size |
|----------|-------------------|------|
| Source `companion_snapshot_serialization_test.cpp` | 2026-11-14 **14:43:42** | 99,061 bytes |
| Object `...\companion_snapshot_serialization_test.dir\Debug\companion_snapshot_serialization_test.obj` | 2026-11-14 **14:46:02** | 3,066,566 bytes |
| Binary `...\bin\Debug\companion_snapshot_serialization_test.exe` | 2026-11-14 **14:46:02** | 10,950,656 bytes |

Source → obj/exe ordering confirms this build consumed the **ISOLATION-09** harness sources.

---

## 5. Authorization note (next step — not run here)

When approved:

```text
E:\Open X-Com Companion\build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe --prefire-only
```

Capture **complete** stdout, stderr, and process exit code. A passing isolated run validates **prefire assertions only**; full-suite P0 remains a separate gate.

---

## 6. Constraints

- No source modifications during this build pass  
- No commits / pushes / deployment  
- No background jobs  