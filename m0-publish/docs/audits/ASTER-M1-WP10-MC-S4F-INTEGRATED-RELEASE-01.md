# ASTER-M1-WP10-MC-S4F — integrated WP9 + WP10 Release verification

**Stage:** S4F integrated build and focused gates
**Authorization:** Verification only — **no commit, push, live executable replacement, or live relay.**

## Executive summary

| Item | Result |
|------|--------|
| Tracked CMake includes both execution cores | **Yes** (working tree: `CompanionMedikitExecutionCore.cpp` added beside `CompanionPsiExecutionCore.cpp`) |
| Clean CMake configure (`build-s4f-integrated`) | **Success** (`DEV_BUILD=ON`, VS2022 Win32 Release) |
| `openxcom.exe` link | **Success** — no LNK2019 on medikit or psi symbols |
| Native tactical gates (medikit, panic, MC, command, snapshot) | **All exit 0** |
| Node WP9 + WP10 focused suites | **37 / 37 pass** |
| Three capabilities coexist | **Yes** — shared `BattlescapeGame` / `CompanionCommandRuntime` path; no missing symbols in integrated link |

**Production runtime unchanged:** `runtime\m0\bin\openxcom.exe` SHA differs from S4F artifact (see §7).

---

## 1. CMake correction (uncommitted)

**File:** `engine/OpenXcom/src/CMakeLists.txt`
**Change:** `Engine/CompanionMedikitExecutionCore.cpp` in `openxcom_src`.

Regenerated `build-s4f-integrated` lists medikit in `openxcom.vcxproj` and companion test `vcxproj` files **without** hand-editing generated projects.

---

## 2. WP9 uncommitted inventory (pre-commit review)

### Engine (`engine/OpenXcom`) — committed base `0562d5504`

| Path | State | Role |
|------|--------|------|
| `src/Engine/CompanionMedikitExecutionCore.{cpp,h}` | **Untracked** | WP9 native medikit apply + target resolve |
| `src/test/companion_medikit_engine_test.cpp` | **Untracked** | Engine + relay E2E harness entry |
| `src/test/companion_medikit_relay_e2e_harness.cpp` | **Untracked** | Inbox terminal medikit matrix |
| `src/test/companion_medikit_release_smoke_test.cpp` | **Untracked** | Release smoke (optional gate) |
| `src/Battlescape/ActionMenuState.cpp` | **Modified** | Medikit UI / companion interaction |
| `src/Battlescape/TileEngine.cpp` | **Modified** | Trajectory / medikit-adjacent guard |
| `src/CMakeLists.txt` | **Modified** | S4F medikit `openxcom_src` line |

**Already committed (WP10, prior checkpoints):** `CompanionPsiExecutionCore`, psi/MC relay runtime, `BattlescapeGame::tryExecuteCompanionPsi*`, panic/MC tests + relay harness tile teardown (`0562d5504`).

**Exclude from WP9 bundle:** `build-*` trees, relay scratch, local temp under `engine/OpenXcom/`.

### Companion (`companion`) — committed base `0df449df`

| Path | State | Role |
|------|--------|------|
| `m0-publish/lib/companion-canonical-runtime.cjs` | **Modified** | Runtime SHA / capability wiring |
| `m0-publish/lib/tactical-equipment-brief.cjs` | **Modified** | Equipment brief (medikit fields) |
| `m0-publish/docs/M1-wp2-unit-state-schema.md` | **Modified** | Schema doc alignment |
| `m0-publish/test/tactical-command-m1-wp9-medikit-s*.test.cjs` | **Untracked** | S1/S3 contract + relay |
| `m0-publish/test/tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs` | **Untracked** | Node medikit relay E2E (not in S4F gate set) |
| `m0-publish/test/medikit-s0-observation.test.cjs` | **Untracked** | S0 observation |
| `m0-publish/test/helpers/medikit-wp9-fixture.cjs` | **Untracked** | Shared fixture |
| `m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-*.md` | **Untracked** | WP9 audit trail |

**Exclude from commit hygiene:** `m0-publish/err.txt`, `out.txt`, `.staging-base` / `.wip-full` publish copies, `companion_bi1_test_*` dirs.

---

## 3. Build configuration

| Setting | Value |
|---------|--------|
| Build root | `engine/OpenXcom/build-s4f-integrated` (fresh directory) |
| Generator | Visual Studio 17 2022, Win32 |
| Configuration | Release |
| `DEV_BUILD` | ON (allows dirty-tree dev package version) |
| CMake version string | `1.0.0562d5504-dirty` |

**Targets built:** `openxcom`, `companion_medikit_engine_test`, `companion_psi_panic_engine_test`, `companion_psi_mind_control_engine_test`, `companion_command_test`, `companion_snapshot_serialization_test`.

---

## 4. Native regression gates

**Binary dir:** `build-s4f-integrated\bin\Release`
**Psi relay:** clean `wp10_psi_*_relay_e2e` dirs before psi test runs (single pass each).

| Executable | Exit | Notes |
|------------|------|--------|
| `companion_medikit_engine_test.exe` | **0** | Includes medikit relay COMPLETED paths |
| `companion_psi_panic_engine_test.exe` | **0** | Harness tile teardown + full panic relay |
| `companion_psi_mind_control_engine_test.exe` | **0** | Full MC relay matrix |
| `companion_command_test.exe` | **0** | Parse/validate across command types |
| `companion_snapshot_serialization_test.exe` | **0** | WP9 medikit + WP10 psi export fields |

---

## 5. Node regression gates

```text
tactical-command-m1-wp9-medikit-s1.test.cjs
tactical-command-m1-wp9-medikit-s3-relay.test.cjs
medikit-s0-observation.test.cjs
tactical-command-m1-wp10-psi-panic-s1.test.cjs
tactical-command-m1-wp10-psi-mind-control-s1.test.cjs
tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs
tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs
```

**Result:** **37 tests, 0 failures.**

**Not run (out of focused S4F scope):** `tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs`, `companion_medikit_release_smoke_test.exe`, repeated 10× psi relay stress.

---

## 6. Coexistence / command conflicts

| Capability | Engine executor | Relay command types |
|------------|-----------------|---------------------|
| WP9 Medikit | `tryExecuteCompanionMedikit*` → `CompanionMedikitExecutionCore` | `MEDIKIT_*` family |
| WP10 Panic | `tryExecuteCompanionPsiPanic` → `CompanionPsiExecutionCore` | `PSI_PANIC` |
| WP10 Mind control | `tryExecuteCompanionPsiMindControl` | `PSI_MIND_CONTROL` |

Integrated link compiles **one** `openxcom.exe` and **one** shared `BattlescapeGame.cpp` with all three families. `companion_command_test` exercises distinct parse/validate paths without symbol or dispatch conflicts in this build.

---

## 7. Executable identity and source revisions

### S4F integrated `openxcom.exe`

| Property | Value |
|----------|--------|
| Path | `engine/OpenXcom/build-s4f-integrated/bin/Release/openxcom.exe` |
| Size | 4,395,008 bytes |
| SHA-256 | `E1206276FDDA9CDDFB3E1D8759E27006D79B2A6DC7B2FCE3DABA98BD88C996E8` |

### Live runtime (unchanged)

| Property | Value |
|----------|--------|
| Path | `runtime/m0/bin/openxcom.exe` |
| SHA-256 | `1B08EB6854F400EB486D8B378292CD5D1C67C4281769EA310D1C3FDEC60EBAB2` |

### Git revision pins (working tree at verification time)

| Repo | HEAD | Dirty |
|------|------|-------|
| `engine/OpenXcom` | `0562d55046e1c7c66540b2265efa9ee42749e561` | **Yes** — CMake, ActionMenuState, TileEngine, untracked WP9 sources |
| `companion` | `0df449df6cac5bc56fa23464d323d15e9fd321f1` | **Yes** — Node lib/schema + untracked WP9 tests/audits |

---

## 8. Outstanding risks

| Risk | Severity | Mitigation before deploy |
|------|----------|---------------------------|
| WP9 + CMake **not committed** | **High** | Owner-approved bundle commit (engine + companion) |
| Dirty working tree | **Medium** | Commit only inventoried WP9/WP10 files; exclude scratch |
| `DEV_BUILD=ON` artifact | **Low** | Production promotion may require `DEV_BUILD=OFF` clean tree per root `CMakeLists.txt` |
| S4E TU atomicity edge | **Low** | No counterexample; no change in S4F |
| Live runtime SHA mismatch | **Expected** | Do not copy S4F exe until deploy authorization + hash pin update |
| Node medikit S4 relay E2E | **Unverified in S4F** | Run once in pre-deploy gate if owner requires parity with native medikit E2E |

---

## 9. Recommended next commit bundle (owner approval — not executed)

1. **Engine:** `CMakeLists.txt` medikit line + WP9 untracked sources/tests + `ActionMenuState.cpp` + `TileEngine.cpp`.
2. **Companion:** WP9 Node tests, fixture, lib/schema edits, WP9 audits.
3. **Verification replay:** Reconfigure `build-s4f-integrated` (or promote dir), one pass each native + Node gate; record new `openxcom.exe` SHA for `VERIFIED_BUILD_SHA256` when deploy is authorized.

---

## STOP — S4F complete

Integrated Release verification **passed** on focused gates. **No commit, push, or live replacement** performed.