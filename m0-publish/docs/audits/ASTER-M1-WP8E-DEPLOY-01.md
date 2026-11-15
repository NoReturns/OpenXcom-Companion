# ASTER-M1-WP8E-DEPLOY-01 — Guided launch production deploy

**Date:** 2026-11-15  
**Authorization:** Stage 3 accepted; owner deploy authorization  
**Mode:** Runtime + Node relay integration — **no live mission, no ammunition consumed**

---

## 1. Pre-deploy

| Check | Result |
|-------|--------|
| `openxcom` / `OpenXcom` process | **None** |
| On-demand relay `node` daemon | **None** (no matching command line) |
| Verified build source | `engine/OpenXcom/build-wp8-isolated/bin/Release/openxcom.exe` promoted to `build-isolated-m1-23e/bin/Release/` (canonical deploy path) |
| Pre-deploy backups | `local/m0/backups/pre-wp8e-deploy-20261115-100043/` (runtime exe, manifest, pin, prior m1-23e build) |

---

## 2. WP8E scope review (unrelated / out of scope)

**In scope (engine `aster/m0` working tree):** `BattlescapeGame`, `CompanionCommandCore`, `CompanionCommandRuntime`, `companion_command_test`, `companion_guided_launch_engine_test`, `companion_inventory_move_engine_test` (OOB fixture), `CMakeLists.txt`.

**In scope (companion working tree):** `tactical-command.cjs`, `command-binding.cjs`, `guided-launch-result-consumer.cjs`, `companion-relay-notify.cjs`, WP8E tests, notify test extension.

**Excluded from deploy (present in companion tree, not promoted):** `tactical-publish.cjs.staging-base`, `tactical-publish.cjs.wip-full`, `err.txt` / `out.txt`, stray `companion_bi1_test_*` dirs, equipment audit doc (informational only).

---

## 3. Deployment

| Step | Result |
|------|--------|
| Pin updated | `companion/m0-publish/lib/companion-canonical-runtime.cjs` |
| `deploy-openxcom.ps1` | **OK** — rollback `openxcom.exe.backup-20261115-100054` (prior `596c056e…`) |
| `verify-deploy-hash-gate.cjs` | exit **0**, `deployScriptHashGateOk: true`, `assessDeployReadiness.ok: true` |
| Manifest `deployed_at` | `2026-11-15T15:00:54.694Z` |

| Artifact | SHA-256 |
|----------|---------|
| Pin `VERIFIED_BUILD_SHA256` | `48c0340bc0a8b6cce73865b9860d7efd0e4839680c887fcfb6594501dcd5a2d9` |
| `runtime/m0/bin/openxcom.exe` | **same** |
| `openxcom.deploy-manifest.json` | **same** |
| `build-isolated-m1-23e/.../openxcom.exe` | **same** |

**Size:** 4,344,320 bytes

**Prior pin:** `596c056e6d108b8d0211352684329f04e339fae5f23dc3a0903a5d5deb66d5fc`

---

## 4. Post-deploy validation (no mission)

| Test | Result |
|------|--------|
| WP8E Node suite (18 + 5 + 5) | **28/28 pass** |
| `companion_command_test.exe` (isolated) | exit **0** |
| Runtime binary string spot check | `GUIDED_LAUNCH`, `INVALID_WAYPOINT`, `GUIDED_LAUNCH_START_FAILED` present |
| Launcher hash precheck (`verifyExecutableHashAgainstPin` on runtime exe) | **ok: true** |
| Relay Node modules load (`guided-launch-result-consumer`, `companion-relay-notify`) | **OK** |

**Not run (by design):** `companion_guided_launch_engine_test` against live runtime (would consume ammo / run battlescape harness).

---

## 5. Launcher

`Start-CompanionOpenXcom.ps1` uses:

- `runtime/m0/bin/openxcom.exe` — matches pin above unless `-SkipDeployVerify`
- `companion/m0-publish/companion-on-demand-relay-daemon.cjs` — loads repo `m0-publish/lib/*` including WP8E relay consumer

---

## 6. Remaining limitations

- Live blaster firing in owner session not exercised in this deploy.
- Pin/README/canonical-runtime updates are workspace-local until companion commit/push (per owner).
- `build-isolated-m1-23e` Release exe was **replaced** with the WP8-isolated verified binary for hash-gate alignment; rebuild m1-23e from source when convenient.