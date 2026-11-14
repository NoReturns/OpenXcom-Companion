# ASTER-M1-PREFIRE-ISOLATION-09

**Mode:** Test harness modification only (no builds, no executions)  
**Date:** 2026-11-14  
**Workspace:** `E:\Open X-Com Companion`

---

## Summary

Added optional CLI flag **`--prefire-only`** to `companion_snapshot_serialization_test` so developers can run **only** `testPrefireDisplayedFiringAccuracyOnFirearmActions` with the same `expect()` / `g_failures` reporting and exit behavior as the full suite.

---

## Files modified

| File | Lines (approx.) | Change |
|------|-----------------|--------|
| `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` | L27 | `#include <cstring>` |
| same | L2254–2281 | `snapshotTestPrefireOnlyRequested`, `snapshotTestFinish` |
| same | L2283–2288 | Early branch: `--prefire-only` → single `SNAPSHOT_TEST_STEP` |
| same | L2290–2348 | Default branch: **unchanged** step list and order |
| same | L2348 | `return snapshotTestFinish();` (replaces inlined exit block) |

**Production / export / prefire assertions / fixtures:** not modified.

---

## Isolation mechanism

1. `main(int argc, char **argv)` scans arguments for exact match `--prefire-only` (no bundled flags).
2. If present:
   - `SNAPSHOT_TEST_STEP(testPrefireDisplayedFiringAccuracyOnFirearmActions)` — same banner and function call as in the full suite.
   - `snapshotTestFinish()` — same `g_failures` count, `FAIL:` lines (from `expect`), stderr summary, stdout `all tests passed.`, `EXIT_FAILURE` / `EXIT_SUCCESS`.
3. If absent: entire historical `SNAPSHOT_TEST_STEP` sequence runs in the **same order**, then `snapshotTestFinish()`.

**Invocation (after rebuild, not run in this pass):**

```text
companion_snapshot_serialization_test.exe --prefire-only
```

---

## Initialization requirements (static review)

| Dependency | How satisfied in isolated mode |
|------------|-------------------------------|
| `fixtureMod()` | Lazy static; first use from `TacticalFixture` inside prefire test |
| `wp8Rules()` | Lazy static; called at start of `testPrefireDisplayedFiringAccuracyOnFirearmActions` |
| `prefireTwoHandedFirearmRules()` | Lazy static; same test |
| `g_failures` | File scope, zero-initialized |
| Prior harness tests | **Not required** — prefire does not read global state set by other tests |

**`main()` does not perform extra global init** in full-suite mode today; isolated mode matches that (no new hidden init).

---

## Dependencies blocking isolation

| Blocker | Assessment |
|---------|------------|
| Monolithic link | Still links full test TU; **runtime** runs one test only — acceptable |
| Hidden coupling to test order | **None identified** for prefire |
| argv on Windows | CRT passes `argc`/`argv` to `main` — standard for console subsystem |

---

## Default execution unchanged

- Without `--prefire-only`, every `SNAPSHOT_TEST_STEP` from `testHealthySoldierWp2Fields` through `testTuReservationSnapshotFields` runs **unchanged in order**.
- Exit path semantics preserved via shared `snapshotTestFinish()` (same messages and return codes as before).

---

## Constraints honored

- No production engine / `CompanionSnapshot.cpp` edits  
- No accuracy or literal changes  
- No assertion or fixture changes  
- No YAML exception suppression  

---

## Source diff (harness only)

```diff
+#include <cstring>

+static bool snapshotTestPrefireOnlyRequested(int argc, char **argv) { ... }
+static int snapshotTestFinish() { ... same as former main tail ... }

-int main()
+int main(int argc, char **argv)
 {
+	if (snapshotTestPrefireOnlyRequested(argc, argv)) {
+		SNAPSHOT_TEST_STEP(testPrefireDisplayedFiringAccuracyOnFirearmActions);
+		return snapshotTestFinish();
+	}
 	SNAPSHOT_TEST_STEP(testHealthySoldierWp2Fields);
 	...
-	if (g_failures != 0) { ... return EXIT_FAILURE; }
-	std::cout << "all tests passed." ...
-	return EXIT_SUCCESS;
+	return snapshotTestFinish();
 }
```