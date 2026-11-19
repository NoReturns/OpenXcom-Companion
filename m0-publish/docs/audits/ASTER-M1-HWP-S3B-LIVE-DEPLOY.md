# ASTER-M1-HWP-S3B — HWP_MOVE live deployment preparation

**Scope:** Promote `build-s4j-rc` Release `openxcom.exe` containing HWP S3B-03 / 03A / 03B (`HWP_MOVE` relay terminal lifecycle + `final_direction`). **Deploy + local pin update only — no commit or push.**

**Engine version string:** `1.0.eb309eb40-dirty`

---

## Step 1 — Release build

| Field | Value |
|-------|--------|
| Tree | `engine/OpenXcom/build-s4j-rc` |
| Target | `openxcom` (Release) |
| Artifact | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| Size | 4 481 024 bytes |
| SHA-256 | `ae36e683e0801f12edf3eb0685edaf55e7a680885f744b8b6f0d1a7ef6c3d5ab` |

---

## Step 2 — Focused regression gates

| Target | Result |
|--------|--------|
| `companion_hwp_move_relay_terminal_test` | PASS |
| `companion_hwp_move_relay_test` | PASS |
| `companion_tactical_hwp_authority_test` | PASS |
| `companion_tactical_hwp_move_execution_test` | PASS |
| `tactical-command-m1-hwp-s3b-movement.test.cjs` | **8/8 PASS** |

---

## Step 3 — Deploy

**Script:** `runtime/m0/deploy-openxcom.ps1`

| Artifact | SHA-256 |
|----------|---------|
| **Before** `runtime/m0/bin/openxcom.exe` | `1b93b14fe0626df059e4316fd56097681b593f2cd2afdd843f10f3bb963f4c85` (VISUAL-03) |
| **After** runtime | `ae36e683e0801f12edf3eb0685edaf55e7a680885f744b8b6f0d1a7ef6c3d5ab` |

### Backup

- `runtime/m0/bin/openxcom.exe.backup-20261119-104944` → SHA-256 `1b93b14f…` (prior canonical)

### Manifest

- `runtime/m0/bin/openxcom.deploy-manifest.json` — `deployed_at`: `2026-11-19T15:49:44.466Z`

### Local pin (not committed)

`companion/m0-publish/lib/companion-canonical-runtime.cjs`:

```javascript
const VERIFIED_BUILD_SHA256 = 'ae36e683e0801f12edf3eb0685edaf55e7a680885f744b8b6f0d1a7ef6c3d5ab';
```

---

## Step 4 — SHA-256 verification

```text
node companion/m0-publish/scripts/verify-deploy-hash-gate.cjs
  → deployScriptHashGateOk: true
  → buildSha256 == verifiedBuildSha256 == runtime
  → runtime DLL set: ok
```

### Bounded startup

- `runtime/m0/bin/openxcom.exe` with `-data` / `user` — ~3s smoke, clean exit.

**Campaign / saves:** Not modified.

---

## Rollback

```powershell
Copy-Item "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe.backup-20261119-104944" `
  "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe" -Force
# Restore VERIFIED_BUILD_SHA256 to 1b93b14f… if using hash-gated launcher
```

---

## Owner live checklist (post-deploy)

1. AI-owned 2×2 HWP: publish `HWP_MOVE` via relay; confirm `EXECUTING` → terminal `COMPLETED` or `INTERRUPTED`.
2. Terminal result: `final_position`, `remaining_tu`, `destination_reached`, **`final_direction`** match battlescape observation (F6 export `facing` / on-map hull).
3. Human HWP / `HWP_FIRE` / `HWP_TURN` still rejected; roster `MOVE` unchanged.

---

## Status

| Item | Status |
|------|--------|
| Live `openxcom.exe` | **Promoted** @ `ae36e683…` |
| Hash gate | **Aligned** (local `companion-canonical-runtime.cjs`) |
| Commit / push | **Not performed** |

**STOP** — await owner live verification before committing pin + audit docs.