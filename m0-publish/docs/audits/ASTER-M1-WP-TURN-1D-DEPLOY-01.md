# ASTER-M1-WP-TURN-1D — TURN_FACE live deployment

**Authorization:** Owner acceptance of WP-TURN-1a/1b/1c + FAILFAST-01 harness lifecycle  
**Scope:** Duplicate guard harness fix, regression gates, Release build, deploy to `runtime/m0/bin/openxcom.exe`  
**No commit / push / campaign mutation.**

## Executive summary

| Item | Result |
|------|--------|
| Duplicate guard (harness) | **PASS** — idempotent re-inbox replay (WP9/WP10 contract) |
| Required native + Node gates | **PASS** (see table; one pre-existing Node failure noted) |
| Release build | **PASS** — `build-s4j-rc` Release `openxcom.exe` |
| TURN_FACE in binary | **Confirmed** (`TURN_FACE`, `TURN_FACE started`, reject strings) |
| Deploy | **SUCCESS** — runtime hash matches verified build |
| Bounded startup | **PASS** — process launch 3s smoke (no mission) |

---

## Step 1 — Duplicate guard

### Change (harness only)

**Before:** `testRelayTurnFaceDuplicateCommandId` hand-wrote malformed `tactical-command-journal.json` (`["turn-face-relay-dup"]`), forcing `JOURNAL_MALFORMED` — not representative of production duplicate handling.

**After:** Mirrors `runRelayDuplicateIdempotent()` in `companion_medikit_relay_e2e_harness.cpp` and WP10 PSI suites:

1. Publish binding-valid inbox → `tickRelay()` → **COMPLETED**
2. Capture `tactical-command.json`, actor TU, facing, and terminal `tactical-result.json`
3. Re-publish the **same** inbox JSON (mtime bump + sleep)
4. Assert **no second mutation** (TU, facing unchanged) and `resultJson() == firstResult`

**Production:** unchanged (`evaluateDuplicateInboxObservation` / journal append path).

### Relay evidence (Release log)

- First leg: `accepted` → `TURN_FACE started` → `terminal … status=COMPLETED`
- Replay leg: inbox observed (no second TU spend); harness assertions on TU, facing, and identical terminal JSON **PASS**
- Full suite exit **0** including duplicate + stale binding scenarios

---

## Step 2 — Regression results

| Gate | Result |
|------|--------|
| `node --test companion/m0-publish/test/tactical-command-m1-wp-turn-1a.test.cjs` | **PASS** (11/11) |
| `companion_turn_face_engine_test.exe` | **PASS** |
| `companion_turn_face_relay_test.exe` | **PASS** (6 scenarios incl. idempotent duplicate) |
| `companion_command_test.exe` | **PASS** (incl. TURN_FACE parse/validate) |
| `tactical-command-m1-stand.test.cjs` | **PASS** |
| `tactical-command-m1-wp4.test.cjs` | **PASS** |
| `tactical-command-m1-wp3.test.cjs` | **FAIL** (1/5) — `composeAutoShotCommand` / `actorUnitId must be a listed player_soldier`; **pre-existing fixture issue**, unrelated to TURN_FACE |

**Note:** WP3 failure does not block this deploy per owner scope (TURN_FACE only); track separately if WP3 Node gate is required globally.

---

## Step 3 — Release build

| Field | Value |
|-------|--------|
| Build tree | `engine/OpenXcom/build-s4j-rc` |
| Configuration | **Release** |
| Target | `openxcom` (+ test exes for gates) |
| Build artifact | `build-s4j-rc/bin/Release/openxcom.exe` (4 445 184 bytes) |

### SHA-256

| Artifact | SHA-256 |
|----------|---------|
| **Previous** `runtime/m0/bin/openxcom.exe` (pre-deploy) | `69012052542ef4dd32c65dd155e6ccf75b76bef8112dc270812a71b87bdbec66` |
| **New** build + deployed runtime | `8b697b9db9e9baf4bcd5d8cf8aa834bf84bb51964b3a3c51497e39aa9ee1c3a0` |

### Backup

- `runtime/m0/bin/openxcom.exe.backup-20261119-064824` (hash `69012052…`)

### Local pin (uncommitted)

`VERIFIED_BUILD_SHA256` in `companion/m0-publish/lib/companion-canonical-runtime.cjs` updated to `8b697b9db9e9baf4bcd5d8cf8aa834bf84bb51964b3a3c51497e39aa9ee1c3a0` for deploy hash gate.

### Campaign / saves

**Not modified.** Deploy copied executable only.

---

## Step 4 — Deploy

| Check | Result |
|-------|--------|
| OpenXcom running at deploy | **No** |
| `runtime/m0/deploy-openxcom.ps1` | **SUCCESS** |
| `verify-deploy-hash-gate.cjs` | **ok** — build ↔ pin ↔ runtime aligned |
| Runtime DLL set | **Complete** |
| Manifest | `runtime/m0/bin/openxcom.deploy-manifest.json` (`deployed_at`: 2026-11-19T11:48:24.768Z) |

### Bounded startup verification

- Launched `runtime/m0/bin/openxcom.exe` with `-data` / `-user` under `bin` for **3 seconds**, then terminated — **no mission load, no save I/O beyond normal startup path**.
- Process remained healthy for the smoke window.

---

## Step 5 — Live runtime status

| Item | Status |
|------|--------|
| Canonical exe | `runtime/m0/bin/openxcom.exe` @ `8b697b9d…` |
| `TURN_FACE` relay dispatch | **Present** in deployed binary |
| Companion command executor | Default launcher sets `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` (unchanged) |

---

## Remaining manual verification (owner)

1. **Cooperative tactical session:** F6 export → publish `TURN_FACE` via CLI (`publish-tactical-command-once.cjs`) for an AI-owned soldier; confirm **COMPLETED** / **REJECTED** terminal result and facing change without movement.
2. **Duplicate inbox:** Republish the same `command_id` + body after terminal result; expect **idempotent replay** (no double TU spend) per medkit/psi contract.
3. **Stale binding:** Deliberately stale `state_version` / `snapshot_sha256` → **REJECTED** without mutation.
4. **Regression hygiene (optional):** Fix or exempt `tactical-command-m1-wp3.test.cjs` actor fixture if WP3 Node gate is required repo-wide.

### Rollback

```powershell
Copy-Item "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe.backup-20261119-064824" `
  "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe" -Force
```

Restore `VERIFIED_BUILD_SHA256` to `69012052542ef4dd32c65dd155e6ccf75b76bef8112dc270812a71b87bdbec66` in `companion-canonical-runtime.cjs`.

---

## Files touched (local, uncommitted)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/test/companion_turn_face_relay_e2e_harness.cpp` | Idempotent duplicate scenario |
| `companion/m0-publish/lib/companion-canonical-runtime.cjs` | Deploy SHA-256 pin |
| `runtime/m0/bin/openxcom.exe` | Deployed binary |
| `runtime/m0/bin/openxcom.deploy-manifest.json` | Deploy manifest |

**STOP** — deployment report complete; owner manual tactical verification outstanding.