# ASTER-M1-MC-03A-LIVE-DEPLOY-01 — Runtime promotion + live drill gate

**Date:** 2026-11-20  
**Status:** **STOP** — deployed and ready for owner live drill; **no live MC fire executed**  
**Owner authorization:** APPROVED (bounded; no push; no simulated live COMPLETED)

---

## 1. HWP rocket harness repair

| Item | Result |
|------|--------|
| Harness changes | `companion_hwp_fire_relay_test.cpp` — blast-flash pump + `setTurretType` on rocket mount |
| Full relay matrix | **PASS** (`companion_hwp_fire_relay_test: PASS (S5-1CD relay certification)`) |
| Production code | **Unchanged** (`ExplosionBState`, projectile, HWP executor) |
| Engine git commit | See `engine/OpenXcom` log — harness-only focused commit (not pushed) |
| S5-1CH discrepancy | **Preserved** in [ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01](ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01.md) |

---

## 2. MC-03A runtime promotion

### Engine capability (working tree `build-s4j-rc`)

- `CompanionTacticalMcHostileFireExecutionCore` — `MC_SNAP_SHOT` / `MC_AUTO_SHOT` / `MC_AIMED_SHOT`
- `mcFireRelayExecutionSupported()` enabled
- `CompanionCommandRuntime` MC fire kinds wired

**Note:** Deployed binary built from **current engine working tree** (includes uncommitted MC-03A production sources beside prior `6907b6a13` HEAD). MC fire is in the **runtime exe**, not yet in a single engine git revision commit on `aster/m0` until owner authorizes that tranche.

### Pre-deploy regressions (Release)

| Suite | Result |
|-------|--------|
| `companion_hwp_fire_relay_test.exe` | Pass |
| `companion_mc_hostile_move_relay_terminal_test.exe` | Pass |
| `companion_tactical_mc_hostile_authority_test.exe` | Pass |
| `companion_hwp_fire_engine_test.exe` | Pass |
| `companion_directed_fire_preflight_test.exe` | Pass |
| Node `m1-mc-s3a-fire` + `m1-mc-s2b-execution` + `companion-canonical-runtime` | **20/20 pass** |

### Build and hash

| Field | Value |
|-------|--------|
| Build root | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| **SHA-256** | `987b1dbf2bd909dbb9478fe60271637731c09e1380cfb0493719316369599797` |
| Size | 4,609,536 bytes |
| OpenXcom running at deploy | **No** (verified) |

### Rollback

`runtime/m0/bin/openxcom.exe.backup-20261120-111815` (prior canonical exe before this promotion)

### Pin and manifest

| Artifact | Value |
|----------|--------|
| `companion-canonical-runtime.cjs` `VERIFIED_BUILD_SHA256` | `987b1dbf…799797` (updated; companion tree **not** in git — workspace file) |
| `runtime/m0/bin/openxcom.exe` | Same SHA-256 as pin |
| `openxcom.deploy-manifest.json` | `deployed_at` **2026-11-20T16:18:15.942Z**; `source_exe` → build-s4j-rc Release |
| `verify-deploy-hash-gate.cjs` | **Pass** against repo root |

---

## 3. Live drill readiness (not executed)

Follow [ASTER-M1-MC-03A-LIVE-PREP-01](ASTER-M1-MC-03A-LIVE-PREP-01.md).

**Owner actions required:**

1. Launch canonical `runtime/m0/bin/openxcom.exe` (promoted build above).
2. Establish mind-controlled alien with firearm; press **F6** for fresh snapshot.
3. Agent (separate instruction): mandatory status review → `mc_hostile_assignments` AI → dry-run/publish **`MC_SNAP_SHOT`** via CLI only.

**Live SNAP (2026-11-20):** `mc03a-live-snap-wall-1000001-03` → **COMPLETED** at wall `(3,10,0)` on session `4818805fe837902d69ad89b306a0deb7` turn 3. Sidecar `actionCosts` fix documented in [LIVE-CLOSEOUT-01](ASTER-M1-MC-03A-LIVE-CLOSEOUT-01.md).

**MC-03A remains open** until live **AUTO** and **AIMED** drills complete (see LIVE-CLOSEOUT-01).

**Not done in this slice:** live command publish, RETRIEVE, simulated COMPLETED claims, git push.

---

## 4. STOP summary

| Deliverable | State |
|-------------|--------|
| HWP harness commit (engine) | **Done** (local; not pushed) |
| Runtime deploy + pin | **Verified** |
| Live MC SNAP | **Awaiting owner battle + F6** |