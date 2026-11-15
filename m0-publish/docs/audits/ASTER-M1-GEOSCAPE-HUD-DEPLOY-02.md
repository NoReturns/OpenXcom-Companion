# ASTER-M1-GEOSCAPE-HUD-DEPLOY-02 — Geoscape HUD cleanup production deploy

**Date:** 2026-11-15  
**Owner approval:** ASTER-M1-GEOSCAPE-HUD-CLEANUP-01 (provisional)  
**Mode:** Production build, runtime deploy — no live mission  
**Committed:** engine `aster/m0` + companion `main` (pin + this audit); `runtime/m0/README-companion-runtime.md` updated workspace-local (not a git root)

---

## 1. Production build

| Item | Value |
|------|--------|
| Target | `engine/OpenXcom/build-isolated-m1-23e/src/openxcom.vcxproj` **Release \| Win32** |
| Output | `engine/OpenXcom/build-isolated-m1-23e/bin/Release/openxcom.exe` |
| SHA-256 | `596c056e6d108b8d0211352684329f04e339fae5f23dc3a0903a5d5deb66d5fc` |
| Size (bytes) | 4,344,832 |

**Prior runtime pin:** `c247a89ba486c93f8a9c65eea5c88dabcfb9266dc4931e7b3fa119df631d6793`

---

## 2. Focused tests (Release unless noted)

| Test | Result |
|------|--------|
| `companion_on_demand_relay_test.exe` | **OK** (includes `testGeoscapeRelayChromeSuppressed`, reconcile, layout) |
| `companion_github_quota_hud_test.exe` | **OK** |
| `companion_manual_upload_hud_test.exe` (Release) | **Not run** — link error (pre-existing missing deps in isolated Release test target) |

Relay preservation for **Basescape** and **Battlescape** is covered by relay test layout/hit-test/auto-retrieve cases; **Geoscape** reconcile paths unchanged in `CompanionOnDemandRelayOverlay::tick()`.

---

## 3. Deployment

| Step | Result |
|------|--------|
| OpenXcom running | **No** |
| Pin updated (local) | `companion/m0-publish/lib/companion-canonical-runtime.cjs` |
| `deploy-openxcom.ps1` | **OK** — rollback `openxcom.exe.backup-20261115-084424` (prior `c247a89b…`) |
| `verify-deploy-hash-gate.cjs` | **OK** — build, pin, runtime, manifest aligned |
| Deployed runtime SHA-256 | `596c056e6d108b8d0211352684329f04e339fae5f23dc3a0903a5d5deb66d5fc` |
| Manifest `deployed_at` | `2026-11-15T13:44:24.661Z` |

---

## 4. Owner visual acceptance (out of scope for deploy)

- Geoscape: no SEND, RETRIEVE, relay status, GitHub quota text.
- Basescape: SEND + quota HUD present.
- Battlescape: full relay bar unchanged.