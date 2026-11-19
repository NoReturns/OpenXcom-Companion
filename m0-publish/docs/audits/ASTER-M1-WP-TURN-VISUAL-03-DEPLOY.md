# ASTER-M1-WP-TURN-VISUAL-03 — TURN_FACE sprite cache deploy

**Authorization:** VISUAL-02 + FOV-01 accepted.  
**Scope:** Promote VISUAL-02 sprite refresh (+ FOV-01 harness tests in binary build tree) to `runtime/m0/bin/openxcom.exe`. **No commit, push, or campaign/save mutation.**

## Executive summary

| Step | Result |
|------|--------|
| Preflight | **PASS** — OpenXcom not running; deploy-scope files only (see below) |
| Gates | **PASS** — engine, relay, `companion_command_test`, Node TURN_FACE contract |
| Release build | **PASS** — `build-s4j-rc` Release `openxcom.exe` |
| Deploy | **SUCCESS** — backup + manifest + hash gate aligned |
| Smoke | **PASS** — 3s launch/exit (no mission) |

---

## Step 1 — Preflight

### Scope verification (approved VISUAL-02 / FOV-01)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` | Post-success `unit->setCache(0)` + `map->cacheUnit(unit)` in `tryExecuteCompanionTurnFace` (guarded `getMap() != 0`) |
| `engine/OpenXcom/src/test/companion_turn_face_engine_test.cpp` | Map-cache presentation test; FOV discovery tests (`testTurnFaceNoFovWithoutTileEngine`, `testTurnFaceFovDiscoversTerrain`) |
| `companion/m0-publish/lib/companion-canonical-runtime.cjs` | **This deploy** — `VERIFIED_BUILD_SHA256` pin only |

**No new FOV logic, animations, or unrelated engine edits** in deploy scope.

**Repository note:** Workspace root is not a git checkout on this machine; scope verified by direct file inspection (no broad working-tree scan).

### Process check

| Check | Result |
|-------|--------|
| `openxcom` / `OpenXcom` running | **No** — safe to replace runtime |

---

## Step 2 — Tests (pre-build gates)

| Target | Result |
|--------|--------|
| `companion_turn_face_engine_test.exe` | **PASS** (incl. map cache + FOV bounded tests) |
| `companion_turn_face_relay_test.exe` | **PASS** |
| `companion_command_test.exe` | **PASS** |
| `node --test test/tactical-command-m1-wp-turn-1a.test.cjs` | **PASS** (11/11) |

Build tree: `engine/OpenXcom/build-s4j-rc`, Configuration **Release**.

---

## Step 3 — Release build

| Field | Value |
|-------|--------|
| Project | `engine/OpenXcom/build-s4j-rc/src/openxcom.vcxproj` |
| Artifact | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| Size | 4 445 184 bytes |
| SHA-256 | `1b93b14fe0626df059e4316fd56097681b593f2cd2afdd843f10f3bb963f4c85` |

**TURN_FACE presence:** Binary strings include `TURN_FACE`, `TURN_FACE started`, companion command runtime symbols (same family as prior TURN-1D deploy, plus VISUAL-02 executor path in linked `BattlescapeGame.cpp`).

---

## Step 4 — Deploy

### Runtime hashes

| Artifact | SHA-256 |
|----------|---------|
| **Before** `runtime/m0/bin/openxcom.exe` | `8b697b9db9e9baf4bcd5d8cf8aa834bf84bb51964b3a3c51497e39aa9ee1c3a0` (WP-TURN-1D) |
| **After** build + runtime | `1b93b14fe0626df059e4316fd56097681b593f2cd2afdd843f10f3bb963f4c85` |

### Backup

- `runtime/m0/bin/openxcom.exe.backup-20261119-071247` (hash `8b697b9d…`)

### Pin

`companion/m0-publish/lib/companion-canonical-runtime.cjs`:

```javascript
const VERIFIED_BUILD_SHA256 = '1b93b14fe0626df059e4316fd56097681b593f2cd2afdd843f10f3bb963f4c85';
```

### Verification

```text
node companion/m0-publish/scripts/verify-deploy-hash-gate.cjs
  → deployScriptHashGateOk: true
  → buildSha256 == verifiedBuildSha256 == runtime (post-copy)
  → runtime DLL set: ok
```

**Manifest:** `runtime/m0/bin/openxcom.deploy-manifest.json` (`deployed_at`: 2026-11-19T12:12:47.922Z).

**Campaign / saves:** Not modified.

### Bounded startup

- Launched `runtime/m0/bin/openxcom.exe` with `-data` / `-user` for ~3s — process exited cleanly (smoke window).

---

## Step 5 — Deployment status

| Item | Status |
|------|--------|
| Canonical exe | `runtime/m0/bin/openxcom.exe` @ `1b93b14f…` |
| VISUAL-02 sprite refresh | **In deployed binary** |
| FOV turn-loop behavior | **Unchanged** (FOV-01; no new engine FOV code in this promote) |
| Commit / push | **Not performed** (owner constraint) |

### Rollback

```powershell
Copy-Item "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe.backup-20261119-071247" `
  "E:\Open X-Com Companion\runtime\m0\bin\openxcom.exe" -Force
# Restore pin to 8b697b9d… if rolling back hash gate
```

---

## Remaining live-test checklist (owner)

1. **Sprite (primary):** AI-owned soldier `TURN_FACE` via relay; confirm iso sprite **immediately** matches new facing (e.g. West→North case) without waiting for another action.
2. **TU / relay:** Terminal `COMPLETED`, TU decrement unchanged; F6 `facing` matches on-map orientation after fix.
3. **Terrain (FOV-01 closure):** Where a **genuinely undiscovered** tile lies in the new facing arc, confirm map fog clears and F6 terrain export gains cells (optional; not required if arc was already explored).
4. **No animation regression:** Turn still **snaps** (no `UnitTurnBState`); no extra TU beyond turn steps.
5. **Duplicate / stale binding:** Quick relay hygiene spot-check (idempotent replay, `STALE_STATE_VERSION` reject).

---

## Related audits

- [ASTER-M1-WP-TURN-VISUAL-02.md](./ASTER-M1-WP-TURN-VISUAL-02.md) — implementation  
- [ASTER-M1-WP-TURN-FOV-01.md](./ASTER-M1-WP-TURN-FOV-01.md) — FOV audit  
- [ASTER-M1-WP-TURN-1D-DEPLOY-01.md](./ASTER-M1-WP-TURN-1D-DEPLOY-01.md) — prior runtime pin  

**STOP** — deploy complete; owner live verification pending.