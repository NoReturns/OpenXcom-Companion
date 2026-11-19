# ASTER-M1-HWP-S4-1D — HWP_TURN live deployment preparation

**Scope:** Promote `build-s4j-rc` Release `openxcom.exe` containing HWP S4-1c (`HWP_TURN` synchronous relay + `hwpTurnRelayExecutionSupported`). Node binding `hwpTurnExecutionSupported` already in repo. **Deploy + local pin update only — no commit or push.**

---

## Step 1 — Release build

| Field | Value |
|-------|--------|
| Tree | `engine/OpenXcom/build-s4j-rc` |
| Target | `openxcom` (Release, Win32) |
| Artifact | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| Size | 4 499 456 bytes |
| SHA-256 | `e4f6a4d9ee4b53a74b2eda08362fec76d1b48526f70c4e5e8896fafdbdb497b4` |

---

## Step 2 — Focused regression gates (post-link)

| Target | Result |
|--------|--------|
| `companion_hwp_turn_relay_test` | PASS |
| `companion_hwp_move_relay_test` | PASS |
| `companion_hwp_turn_engine_test` | PASS |
| `companion_turn_face_engine_test` | PASS |
| `companion_tactical_hwp_authority_test` | PASS |
| Node: S4 + S3B + WP-TURN-1a | **29/29 PASS** |

---

## Step 3 — Pre-deploy safety

| Check | Result |
|-------|--------|
| OpenXcom running | **No** (deploy permitted) |
| Campaign / saves touched | **No** |

---

## Step 4 — Deploy

**Script:** `runtime/m0/deploy-openxcom.ps1`

| Artifact | SHA-256 |
|----------|---------|
| **Before** `runtime/m0/bin/openxcom.exe` | `ae36e683e0801f12edf3eb0685edaf55e7a680885f744b8b6f0d1a7ef6c3d5ab` (HWP-S3B, 4 481 024 bytes) |
| **After** runtime | `e4f6a4d9ee4b53a74b2eda08362fec76d1b48526f70c4e5e8896fafdbdb497b4` |

### Backup

- `runtime/m0/bin/openxcom.exe.backup-20261119-115204` → SHA-256 `ae36e683…` (prior canonical)

### Manifest

- `runtime/m0/bin/openxcom.deploy-manifest.json` — `deployed_at`: `2026-11-19T16:52:04.241Z`

### Local pin (not committed)

`companion/m0-publish/lib/companion-canonical-runtime.cjs`:

```javascript
const VERIFIED_BUILD_SHA256 = 'e4f6a4d9ee4b53a74b2eda08362fec76d1b48526f70c4e5e8896fafdbdb497b4';
```

---

## Step 5 — Hash gate & DLL readiness

```text
node companion/m0-publish/scripts/verify-deploy-hash-gate.cjs
  → deployScriptHashGateOk: true
  → buildSha256 == verifiedBuildSha256 == runtime
  → runtime DLL set: ok
```

---

## Step 6 — Relay daemon

| Item | Value |
|------|--------|
| Prior daemon | None running |
| Action | `companion/m0-publish/scripts/ensure-on-demand-daemon.cjs` |
| PID | **9484** |
| Health | `state: ready` (`.companion-on-demand-daemon-health.json`) |
| Snapshot env | `local/m0/tactical-live.yaml` |

Node modules (including `hwpTurnExecutionSupported: true`) load from live `companion/m0-publish` at process start.

---

## Step 7 — Bounded startup smoke

- `runtime/m0/bin/openxcom.exe` with `-data` / `-user` — ~3s, **clean exit** (no game left running).

---

## Rollback

```powershell
Copy-Item "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe.backup-20261119-115204" `
  "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe" -Force
# Restore VERIFIED_BUILD_SHA256 to ae36e683… in companion-canonical-runtime.cjs
```

---

## Owner live acceptance (tank battle)

**Launcher:** `runtime/m0/Start-CompanionOpenXcom.ps1` (binds play session + relay; preferred over raw `openxcom.exe` for live relay).

**Strafe (required for independent turret turns):** `local/m0/user/options.cfg` currently has `strafe: false`. **Enable “Strafe” in OpenXcom Advanced Options** before turret tests (1 & 3). Not changed during deploy.

| # | Tank | Command | Expected |
|---|------|---------|----------|
| 1 | Cannon | `turn_part: turret` | Hull unchanged; turret East |
| 2 | Cannon | `turn_part: body` | Hull turns; turret coupled |
| 3 | Laser | `turn_part: turret` | Hull fixed; turret independent |
| 4 | Laser | `turn_part: body` | Hull turns; footprint unchanged |

Verify per command: `tu_spent`, `remaining_tu`, `final_direction`, `final_turret_direction` (when applicable), positions unchanged, terminal `COMPLETED`. **One command at a time.**

**Capability:** Relay and Node now agree `HWP_TURN` is supported; runtime binary matches pin `e4f6a4d9…`.

---

## Status

| Item | Status |
|------|--------|
| Live `openxcom.exe` | **Promoted** @ `e4f6a4d9…` |
| Hash gate | **Aligned** |
| Relay daemon | **Ready** (PID 9484) |
| Commit / push | **Not performed** |

**STOP** — await owner live HWP_TURN acceptance; next engineering tranche: **HWP_FIRE** (+ `nestedAmmo` normalization).