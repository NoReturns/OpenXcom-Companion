# ASTER-M1-MC-02B — Live runtime deploy

**Date:** 2026-11-20  
**Scope:** Promote MC-02B `build-s4j-rc` Release to `runtime/m0/bin/openxcom.exe` and align hash gate.

## Build

| Field | Value |
|-------|--------|
| Engine commit | `6907b6a1393196039ed6612157273835192fc5ed` (`aster/m0`) |
| Tree | `engine/OpenXcom/build-s4j-rc` |
| Configuration | Release |
| Artifact | `build-s4j-rc/bin/Release/openxcom.exe` |
| Size | 4 598 272 bytes |
| SHA-256 | `13837594ecbf3b1b57c50497546360c32d7c1c21d4f3138f538015fd78664bd9` |

**Pre-deploy gates (exit 0):** `companion_tactical_mc_hostile_authority_test`, `companion_mc_hostile_move_relay_terminal_test`.

## Deploy

| Step | Result |
|------|--------|
| Backup | `runtime/m0/bin/openxcom.exe.backup-20261120-095651` (prior pin `997a968b…`) |
| Runtime exe | SHA-256 matches build artifact |
| Manifest | `openxcom.deploy-manifest.json` — `deployed_at` `2026-11-20T14:56:51.128Z` |
| `verify-deploy-hash-gate.cjs` | **PASS** — `deployScriptHashGateOk: true`, `assessDeployReadiness.ok: true` |

## Pin

`companion/m0-publish/lib/companion-canonical-runtime.cjs`:

```js
const VERIFIED_BUILD_SHA256 = '13837594ecbf3b1b57c50497546360c32d7c1c21d4f3138f538015fd78664bd9';
```

## Rollback

```powershell
Copy-Item "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe.backup-20261120-095651" `
  "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe" -Force
# Restore VERIFIED_BUILD_SHA256 to 997a968b9b6407e6f0b0ff96d0d89399ddfc8896f63fc369d19603c90c4462dd
```