# ASTER-M1-WP9-MEDIKIT-LIVE-DEPLOY-01 — live WP9 medikit deployment

**Authorization:** Owner — live WP9 deploy
**Mode:** Production `runtime/m0/bin` promotion — **no git commit/push** in this pass.

## Deployment status: **COMPLETE**

| Layer | SHA-256 | Size |
|-------|---------|------|
| **Prior runtime** | `763d8dbf73ff5e6ab4702bf4b8f0816deff25a3ac989d11cb2fefa819cdd5cdc` | 4,344,320 |
| **Live runtime / pin / build** | `9b6be18848a90d1fae6a4daf45735054a2973ef25e7a713df7625537841269f1` | 4,363,264 |
| Manifest `deployed_at` | `2026-11-15T19:35:28.917Z` | |

**Verified:** `verify-deploy-hash-gate.cjs` **ok**; `runtime/m0/bin/openxcom.exe` matches `VERIFIED_BUILD_SHA256` in `companion-canonical-runtime.cjs`.

## Backups (pre-replace)

| Artifact | Path |
|----------|------|
| Bundle | `local/m0/backups/pre-wp9-live-deploy-20261115-143500/` |
| Runtime rollback exe | `runtime/m0/bin/openxcom.exe.backup-20261115-143528` |
| Rollback card | `runtime/m0/bin/openxcom.promotion-rollback-wp9-live-20261115.json` |

## Scope in promoted binary

- **M1-WP9 medikit** relay + native apply (S1–S4E engine/Node integration in tree).
- **TileEngine** `canTargetUnit` empty-`_trajectory` guard (defensive; no gameplay change when trajectory populated).

**Not certified (unchanged):** **Adjacent off-co-tile HEAL** with correct facing — do **not** treat live deploy as certifying adjacent success.

## Focused tests (pre-deploy)

| Gate | Result |
|------|--------|
| `companion_medikit_engine_test.exe` | **exit 0** |
| Node WP9 S1 / S3 / S4 | **14/14 pass** |
| `companion-canonical-runtime.test.cjs` | **pass** (included in 27-test run) |
| `verify-deploy-hash-gate.cjs` | **exit 0** |

No new default test infrastructure enabled for deploy.

## Companion Node

- WP9 publish/validate/relay modules are the **workspace** `companion/m0-publish/` tree (unchanged layout vs prior deploys).
- **Runtime pin** updated locally: `companion/m0-publish/lib/companion-canonical-runtime.cjs`.
- **Operator:** restart on-demand relay daemon when convenient so long-lived Node picks up any in-memory assumptions (engine binary is already on disk).

## Preserved

- `local/m0/user` campaign saves, options, relay inbox/result under `local/m0/` (not overwritten by deploy).
- No commit, push, or isolated RC promotion in this step.

## Known residual risks

| Risk | Note |
|------|------|
| **Adjacent HEAL** | **Uncertified** — live relay for co-tile + validated rejections; adjacent success not proven |
| **BATTLE_BUSY / full UI stack** | Co-tile harness only; live busy-state not re-certified here |
| **Uncommitted tree** | Pin/README updates local until owner commits |

## Operator next steps

1. Start game via `Start-CompanionOpenXcom.ps1` (launcher enforces pin).
2. Restart relay daemon if running.
3. Exercise **HEAL / STIMULANT / PAINKILLER** on **co-tile** or mission layouts where native medikit targeting already works — **not** as proof of adjacent HEAL.

**STOP** — owner live verification.