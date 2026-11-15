# ASTER-M1-WP8E-LIVE-FIX-DEPLOY-03

**Date:** 2026-11-15  
**Authorization:** Owner — LIVE-FIX-02 accepted  
**Mode:** Controlled runtime + Node sidecar deploy — no game launch, no missile fire

---

## Pre-deploy

| Check | Result |
|-------|--------|
| OpenXcom / daemon | **Stopped** |
| Backup bundle | `local/m0/backups/pre-wp8e-livefix-deploy-20261115-101757/` |
| Runtime rollback exe | `openxcom.exe.backup-20261115-101807` (prior `48c0340b…`) |

## LIVE-FIX-02 scope deployed

**Engine:** `BattlescapeState.cpp` — Battlescape **Ctrl+Shift+R** rules export (plus prior WP8E binary).

**Companion Node:** `rules-reference-sidecar-consumer.cjs`, `command-relay-watcher.cjs`, `companion-relay-launcher.cjs` (plus prior WP8E relay modules).

**Excluded from this promotion:** scratch (`err.txt`, `out.txt`, `*.wip-full`), unrelated BI test dirs, equipment audit doc only.

## Hashes

| Layer | SHA-256 |
|-------|---------|
| Pin / build / runtime / manifest | `763d8dbf73ff5e6ab4702bf4b8f0816deff25a3ac989d11cb2fefa819cdd5cdc` |
| Size | 4,344,320 bytes |
| Manifest `deployed_at` | `2026-11-15T15:18:07.525Z` |

## Post-deploy tests

| Suite | Result |
|-------|--------|
| `verify-deploy-hash-gate.cjs` | exit **0** |
| rules-reference-sidecar + watcher + WP8E Node (47 tests) | **47/47 pass** |
| Launcher hash precheck | **ok** |

**Live `local/m0`:** `companion-rules-reference.json` still **missing** (expected until owner **Ctrl+Shift+R** in mission).

## Operator next steps (not done here)

1. Start game via `Start-CompanionOpenXcom.ps1` when ready (picks up new `openxcom.exe`).
2. **Restart on-demand relay daemon** so Node loads sidecar wiring (daemon was stopped for deploy).
3. **Ctrl+Shift+R** on Battlescape → verify rules JSON for campaign `624067d2038b6f2d36f27cd0d94b8d03`.
4. Re-issue / retrieve `GUIDED_LAUNCH` — no live missile test in this deploy.