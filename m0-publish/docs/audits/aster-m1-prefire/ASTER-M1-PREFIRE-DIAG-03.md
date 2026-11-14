# ASTER-M1-PREFIRE-DIAG-03

**Mode:** Diagnostic (no production edits, no new harness runs in this pass)  
**Date:** 2026-11-14  
**Scope:** Native exit **3** / abnormal stop after `testPrefireDisplayedFiringAccuracyOnFirearmActions`  
**Workspace:** `E:\Open X-Com Companion`  
**Canonical build tree:** `build-isolated-m1-23e` (workspace root — not `engine\OpenXcom\build-isolated-m1-23e`)

---

## 1. Binary and source freshness

### Sources (intent)

| Artifact | Path | Last write (local) |
|----------|------|-------------------|
| Prefire test | `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` | 2026-11-14 14:07:47 |
| Export guard | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | 2026-11-14 14:07:31 |

Confirmed in source:

- `seedSoldierFiringStats()` at ~L2041; called **before** `addSoldierUnit` in all four scenario blocks (~L2059–L2131).
- `appendActionEntry` guard: `baseStats != 0 && baseStats->health > 0` before `getFiringAccuracy` (~L715–L720).

### Build metadata

| Artifact | Path | Last write |
|----------|------|------------|
| `companion_snapshot_serialization_test.obj` | `build-isolated-m1-23e\src\companion_snapshot_serialization_test.dir\Debug\` | 2026-11-14 14:07:53 |
| `CompanionSnapshot.obj` | same dir | 2026-11-14 14:07:53 |
| `companion_snapshot_serialization_test.exe` | `build-isolated-m1-23e\bin\Debug\` | 2026-11-14 14:07:54 |
| PDB | `build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.pdb` | linked with exe (RSDS in PE) |

`CL.command.1.tlog` records **both** translation units compiled against current paths:

- `ENGINE\OPENXCOM\SRC\TEST\COMPANION_SNAPSHOT_SERIALIZATION_TEST.CPP`
- `ENGINE\OPENXCOM\SRC\ENGINE\COMPANIONSNAPSHOT.CPP`

**Conclusion:** The failing executable **is** built from the current intended sources (not a stale pre-prefire binary). Link-only incremental passes still consume these objects when timestamps are newer than inputs.

### Binary contains expected logic

Disassembly verification (PE, Debug|Win32):

| Symbol / site | Evidence |
|---------------|----------|
| `seedSoldierFiringStats` | Sets `UnitStats::firing` (+0x14), `health` (+0x8), `tu`/`stamina` = 0x50 via `getCurrentStats()`. |
| Four scenario seeds | `call 0045F2D0` at `0045F3AD`, `0045F9FE`, `0045FEE1`, `0046035A`; each followed by `addSoldierUnit`. Scenario 1 pushes `0x32` (50) and `0x3C` (60) before seed. |
| Export guard | `appendActionEntry`: `getBaseStats`, null check, `cmp dword ptr [eax+8], 0` / `jle` skip, then `getFiringAccuracy`. Offset **+8** matches `UnitStats::health` (`tu`, `stamina`, `health`, …). |

**Uncertainty:** Other TUs in the monolithic test exe were not re-validated line-by-line; only the two prefire-related translation units above.

---

## 2. Termination classification

### Native failure (authoritative)

**Windows Application Error** (Event ID **1000**), matching VERIFY-02 run time (~14:07:14):

| Field | Value |
|-------|--------|
| **Exception code** | **`0xC0000094`** (integer divide-by-zero) |
| Decimal (signed) | **-1073741676** |
| **Faulting module** | `companion_snapshot_serialization_test.exe` |
| **Fault offset (RVA)** | **`0x006C2BCF`** (latest event; earlier runs: `0x006C2EFF`, `0x006C559F`) |
| **Faulting image path** | `E:\Open X-Com Companion\build-isolated-m1-23e\bin\Debug\companion_snapshot_serialization_test.exe` |

**Classification:** Unhandled **structured exception (SEH)** — **not** a normal return from `main()` with `g_failures`.

### Faulting instruction

PE image base `0x00400000` → VA `0x00AC2BCF` = RVA `0x006C2BCF`.

In `BattleUnit::getAccuracyModifier`:

```text
00AC2BC5  call  getBaseStats
00AC2BCA  mov   ecx, eax          ; ecx -> UnitStats*
00AC2BCC  mov   eax, esi          ; _health * 25 (esi)
00AC2BCE  cdq
00AC2BCF  idiv  dword ptr [ecx+8] ; divide by baseStats->health
```

This matches source `25 * _health / getBaseStats()->health + 75 - 10 * wounds` when **`getBaseStats()->health == 0`**.

**CRT assert / C++ exception / explicit `main` failure:** Ruled out for the VERIFY-02 stop:

- No `FAIL:` lines and no `N test(s) failed.` / `all tests passed.` in `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-VERIFY-02.log.err`.
- No evidence of `yaml-cpp` throw (would typically be `0xE06D7363` / different faulting IP).

### Exit code **3** (VERIFY-02 / PowerShell)

`main()` returns **`EXIT_FAILURE` on MSVC (numeric 3)** only after printing failures — which did **not** occur.

**Reconciliation:**

- Reported **native exit 3** from `Start-Process` is **not** the same as exception code **`0xC0000094`** in the Application log.
- Treat **0xC0000094** as the definitive termination; exit **3** in the shell is a **misleading wrapper outcome** for this crash (not proof of `g_failures == 3`).

### Debugger / second run

- **cdb.exe / WinDbg:** Not installed (vswhere + filesystem search).
- **This pass:** No additional test execution (prior run preserved in VERIFY-02 artifacts + Event Log).
- **Evidence:** Event Log + PE disassembly + call-site analysis.

### Last completed operation (inferred)

| Stage | Evidence |
|-------|----------|
| Harness reached prefire step | Stderr banner: `testPrefireDisplayedFiringAccuracyOnFirearmActions` (VERIFY-02 log line 61) |
| Scenario | **Standing (unit id 81)** most likely — first block calls `findUnitByIdDirect` → `buildSnapshot` → `appendFriendlyActionCosts` → `appendActionEntry` → `getFiringAccuracy` **before** any `expect()` can emit `FAIL:` |
| vs accuracy math | Termination is **inside** `getAccuracyModifier` (health term), **before** literal compares (30/24/34/26) |

**Health at fault:** Divisor **`[ecx+8] == 0`** ⇒ **`getBaseStats()->health == 0`** on the `BattleUnit` passed into `getFiringAccuracy`.

---

## 3. Call stack (reconstructed, static)

```
testPrefireDisplayedFiringAccuracyOnFirearmActions     [scenario 1]
  findUnitByIdDirect
    CompanionSnapshotBuild::buildSnapshot
      appendUnit → appendFriendlyActionCosts (if exportFriendlyTacticalDetails)
        appendHandActionCosts → appendActionEntry
          BattleUnit::getFiringAccuracy          [if guard passes: baseStats->health > 0]
            BattleUnit::getAccuracyModifier
              idiv by baseStats->health  ← 0xC0000094 at RVA 0x006C2BCF
```

Alternate legal path (same fault IP):

```
testPrefireDisplayedFiringAccuracyOnFirearmActions
  expect(...) comparing YAML to unit->getFiringAccuracy(...)
    BattleUnit::getFiringAccuracy → getAccuracyModifier → idiv
```

Given **no `FAIL:` lines**, the **snapshot export path** (first `findUnitByIdDirect` in scenario 1) is the **stronger** inference.

---

## 4. Zero-health defect status

| Question | Finding |
|----------|---------|
| Original RCA (zero `getBaseStats()->health`) | **Still implicated** — faulting `idiv` is exactly that division. |
| Did `seedSoldierFiringStats` ship in the binary? | **Yes** — four calls, correct argument pattern (50 / 60). |
| Does the production guard prevent this crash? | **Only on the export branch** when `health <= 0`; it **does not** call `getFiringAccuracy` then. **Crash implies either** (a) guard saw `health > 0` but divisor was 0 in the same call (not supported by static analysis), **or** (b) more plausibly **`getFiringAccuracy` ran while `baseStats->health` was 0** on a path where the guard should have skipped — **or** (c) **runtime `BattleUnit::_stats.health` is still 0** despite soldier seed (fixture sync gap between `Soldier::getCurrentStats()` and `BattleUnit` construction not taking effect as expected — **requires owner-approved runtime watch** to confirm). |
| Has the defect “moved”? | **No** — same mechanism as RCA-01; symptoms remain **SEH**, not assertion failures. |

**Production guard:** Present and correct field offset (+8), but **independent of test survival**: tests and other export paths can still invoke `getFiringAccuracy` when stats are invalid; guard **omits YAML** rather than fixing stats.

---

## 5. Smallest justified corrective action (not implemented)

**Single targeted fix (test-side, matches RCA + DIAG):** After `addSoldierUnit`, **synchronously set battle stats** on the live `BattleUnit` (not only `Soldier::getCurrentStats()`), e.g. a helper that sets `unit->getBaseStats()->health`, `->firing`, and `unit` current `_health` to known positives before any `buildSnapshot` / `getFiringAccuracy`.

**Location:** `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` — extend or complement `seedSoldierFiringStats` immediately after each `addSoldierUnit` in `testPrefireDisplayedFiringAccuracyOnFirearmActions` (~L2059–L2135).

**Do not** treat `CompanionSnapshot.cpp` guard as the sole fix for P0 — it does not remove divide-by-zero from direct `getFiringAccuracy` calls.

**Optional follow-up (production, separate approval):** Defensive clamp in `BattleUnit::getAccuracyModifier` when `getBaseStats()->health <= 0` (engine behavior change).

---

## 6. Preserved evidence

| Item | Path |
|------|------|
| VERIFY-02 stderr | `local/m0/audits/.relay-scratch/ASTER-M1-PREFIRE-VERIFY-02.log.err` |
| RCA-01 | `local/m0/audits/ASTER-M1-PREFIRE-HARNESS-RCA-01.md` |
| Disasm snippet | `local/m0/audits/.relay-scratch/prefire-fault-disasm-snippet.txt` |
| Application crashes | Windows Application log, Event ID 1000, 2026-11-14 ~14:00–14:07 |

---

## 7. P0 acceptance status

**BLOCKED.**

Required evidence for P0 (full harness pass, exit 0, four accuracy literals) **does not exist**. Diagnostic evidence **does** establish:

- Fresh binary includes seed + guard.
- Failure is **uncaught `0xC0000094`** in `getAccuracyModifier`, not silent assertion triplets.
- **Exit code 3** from the shell is **not** a substitute for exception code **`0xC0000094`**.

**Bounded verification after owner-approved fix** (unchanged tree):

```powershell
Set-Location "E:\Open X-Com Companion\engine\OpenXcom\build-isolated-m1-23e"
& "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  "E:\Open X-Com Companion\build-isolated-m1-23e\src\companion_snapshot_serialization_test.vcxproj" `
  /p:Configuration=Debug /p:Platform=Win32 /m /v:minimal
$log = "E:\Open X-Com Companion\local\m0\audits\.relay-scratch\prefire-verify-post-fix.txt"
Set-Location "E:\Open X-Com Companion\build-isolated-m1-23e\bin\Debug"
$p = Start-Process -FilePath ".\companion_snapshot_serialization_test.exe" -Wait -PassThru -NoNewWindow `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"
"LASTEXITCODE=$($p.ExitCode)"
```

Also check Application log for absence of new `0xC0000094` for this binary.

---

*End of ASTER-M1-PREFIRE-DIAG-03.*