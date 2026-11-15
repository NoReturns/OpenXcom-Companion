# ASTER-M1-AAR-DEPLOY-05 — Automatic battle AAR production deploy

**Date:** 2026-11-15  
**Owner approval:** ASTER-M1-AAR-COMPACT-VALIDATE-04 accepted  
**Mode:** Production build, runtime deploy, relay integration commit — no live mission, no synthetic GitHub publish

---

## 1. Preflight

### Repositories (pre-deploy)

| Repo | Branch | HEAD (pre) | Remote |
|------|--------|------------|--------|
| `engine/OpenXcom` | `aster/m0` | `614bbf7ec` | `origin` |
| `companion` | `main` | `26a6ad3` | `origin/main` |

### Runtime pin (pre)

| Field | Value |
|-------|--------|
| `runtime/m0/bin/openxcom.exe` SHA-256 | `8bb612ff1b19f5c4aed053786e8652feb023d18f8173d5ef3ae7c02b3b61c08b` |
| Manifest | Matched pre-deploy pin |

### AAR implementation scope (included)

| Layer | Components |
|-------|------------|
| **Capture** | `CompanionBattleAarCapture*`, debrief hooks, `buildAarTacticalTerminal`, `aar-produced/` durability |
| **Compact** | `battle-aar-compact-project.cjs` (debrief-screen projection, no tactical leakage) |
| **Durability** | `discoverProducedAarArtifacts`, queue journals, archive path `m0/aar/<campaign>/<battle>/<mission_statistics_id>.json` |
| **Relay** | `battle-aar-relay-publish.cjs`, `processBattleAarRelayTick` in on-demand daemon, `m0/battle-aar.json` + archive |

**Excluded from commits:** build trees, WIP `tactical-publish.cjs.*`, test scratch dirs, unrelated engine build outputs.

---

## 2. Production build

| Item | Value |
|------|--------|
| Toolchain | VS BuildTools MSBuild **18.5.4** (`vswhere` → `MSBuild\Current\Bin\MSBuild.exe`) |
| CMake regen | `engine/OpenXcom/build-isolated-m1-23e` (generator VS 2022 Win32) |
| Target | `build-isolated-m1-23e/src/openxcom.vcxproj` **Release \| Win32** |
| Output | `engine/OpenXcom/build-isolated-m1-23e/bin/Release/openxcom.exe` |

### Regression tests

| Test | Result |
|------|--------|
| `companion_battle_aar_capture_test.exe` (isolated Release) | **PASS** |
| `companion_snapshot_serialization_test.exe` (isolated Release) | **PASS** (full suite) |
| Node compact + relay + durability | **18/18 PASS** |

---

## 3. Deployment

| Step | Result |
|------|--------|
| OpenXcom running | **No** (process check) |
| Hash gate (`verify-deploy-hash-gate.cjs`) | **OK** after pin update |
| `deploy-openxcom.ps1` | **OK** |
| Rollback backup | `runtime/m0/bin/openxcom.exe.backup-20261115-060106` (prior `8bb612ff…`) |

### Executable hashes

| | SHA-256 | Size (bytes) |
|--|---------|----------------|
| **Previous runtime** | `8bb612ff1b19f5c4aed053786e8652feb023d18f8173d5ef3ae7c02b3b61c08b` | 4,297,728 |
| **New build (source)** | `c247a89ba486c93f8a9c65eea5c88dabcfb9266dc4931e7b3fa119df631d6793` | 4,344,320 |
| **Deployed runtime** | `c247a89ba486c93f8a9c65eea5c88dabcfb9266dc4931e7b3fa119df631d6793` | 4,344,320 |

Manifest `runtime/m0/bin/openxcom.deploy-manifest.json`: **matches deployed exe** (`deployed_at` 2026-11-15T11:01:06Z).

Pin updated: `companion/m0-publish/lib/companion-canonical-runtime.cjs` → `VERIFIED_BUILD_SHA256 = c247a89b…`.

### Binary sanity

Strings present in deployed `openxcom.exe`: `companion-battle-aar.json`, `aar-produced`, battle AAR log messages.

---

## 4. Relay readiness (sidecar)

The **on-demand relay daemon** (`companion-on-demand-relay.cjs`) is the sidecar; no separate relay binary deploy.

| Check | Status |
|-------|--------|
| `processBattleAarRelayTick` wired before on-demand work | **Yes** (existing daemon tick) |
| Ingest + `aar-produced` discovery | **Verified** (durability tests) |
| Compact publish to `m0/battle-aar.json` + `m0/aar/...` archive | **Verified** (relay tests, mock publishers) |
| Retry / dedup / journal | **Verified** (relay + durability suites) |
| Live GitHub publish during deploy | **No** (tests use `bypassGhAuth` / mocks) |

**Operator:** restart relay via `Start-CompanionOpenXcom.ps1` (or existing daemon restart) so Node loads committed relay modules.

---

## 5. Version control

See §6 for commit IDs after push.

**Engine commit scope:** debrief capture, AAR core/capture, snapshot terminal builder, CMake test target.  
**Companion commit scope:** relay + compact + durability modules, tests, audits, runtime SHA pin.

---

## 6. Post-push record

| Repo | Branch | Commit | Remote verification |
|------|--------|--------|---------------------|
| OpenXcom | `aster/m0` | `657707f13` | `git push origin aster/m0` → `614bbf7ec..657707f13` |
| OpenXcom-Companion | `main` | `14ba72e` | `git push origin main` → `26a6ad3..14ba72e` |

Local `git status`: clean on staged paths; untracked build/scratch dirs remain intentionally uncommitted.

---

## 7. Rollback

1. Stop OpenXcom.  
2. Copy `runtime/m0/bin/openxcom.exe.backup-20261115-060106` → `openxcom.exe`.  
3. Restore `VERIFIED_BUILD_SHA256` to `8bb612ff…` and rewrite manifest via `write-deploy-manifest.cjs` or manual manifest edit.  
4. Revert engine/companion commits if needed.

---

## 8. Remaining items

- **First live debrief** after deploy: confirm `local/m0/aar-produced/<report_id>.json` and daemon ingest (optional spot-check; not required for this deploy step).  
- **Daemon restart** on operator machine if a long-lived Node process predates this companion commit.