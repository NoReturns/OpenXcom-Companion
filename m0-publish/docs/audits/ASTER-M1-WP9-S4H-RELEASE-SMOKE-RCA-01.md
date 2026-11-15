# ASTER-M1-WP9-S4H-RELEASE-SMOKE-RCA-01 — Release smoke RCA and test repair

**Authorization:** Investigation + test-only repair. **No** commits, pushes, deployment, or production medikit changes.

## Verdict

| Item | Result |
|------|--------|
| Root cause class | **Test fixture / harness hygiene** (not production medikit admission or execution logic) |
| Production `COMPLETED` on mis-aim | **Not reproduced** after relay cleanup; prior **stale `tactical-result.json`** / journal collision explained S4G mis-aim false green |
| Homogenous DESERT MCD pad scan | **Invalid certification fixture** — no flat `O_FLOOR` object on a 12×12 uniform pad yields adjacent `resolveNativeMedikitTarget` under full `loadMods()` voxel data |
| Test repair | **`companion_medikit_release_smoke_test.cpp`** only |
| Release smoke (S4F integrated) | **PASS** (`exit 0`) after repair |

## 1. Failure mechanism (reproduced)

**Binary:** `engine/OpenXcom/build-s4f-integrated/bin/Release/companion_medikit_release_smoke_test.exe`
**Data:** `runtime/m0/bin` (xcom1 standard)

### 1.1 Homogenous DESERT floor scan

The smoke harness tiled the battle with a single DESERT `O_FLOOR` MCD object and required `resolveNativeMedikitTarget()` → patient id **2** at medic **(5,5)** facing **2**, patient **(6,5)**.

- After `loadData` on DESERT, multiple flat walkable floors exist (e.g. MCD indices with `T_Level == 0`, `TU_Walk < 255`).
- **None** of them produced adjacent native medikit targets on a uniform pad with production ruleset voxel data loaded via `Game::loadMods()`.
- This matches prior [ASTER-M1-WP9-MEDIKIT-RELEASE-SMOKE-01.md](./ASTER-M1-WP9-MEDIKIT-RELEASE-SMOKE-01.md): headless **homogenous** ruleset terrain ≠ mission map blocks for melee medikit LOS.

**Secondary fixture bug (when open floor was attempted after DESERT scan):** repeated `wireProductionDesertFloor` pushed DESERT into `SavedBattleGame::getMapDataSets()`. A fallback open floor wired `MapData` with **`mdsId == 0`** while slot 0 referenced **DESERT** loft/voxel data, not the synthetic open-floor set — so even guided-launch-style tiles could not obtain `validMeleeRange` until the scan was removed and `mapDataSets` was reset for open-floor wiring.

### 1.2 Mis-aim path and stale relay artifacts

With floor selection failing, the east HEAL command never reached a valid native bind. A **prior** run left `tactical-result.json` with **`COMPLETED`** and journal entries for `wp9-smoke-adj-*` command ids.

Observed on failing runs:

- Duplicate handling: `duplicate command result identity mismatch … preserving prior tactical-result.json`
- Second inbox: `DUPLICATE_COMMAND_ID` with `public_reason: "Command ID already used."`

That made `mis-aim not COMPLETED` appear to fail when the executor had actually **rejected** the second command, while `resultStatusIs("COMPLETED")` still read **stale** JSON from an earlier session.

**Production behavior:** `BattlescapeGame` preflight still requires `resolveNativeMedikitTarget()` to match `target_unit_id` ([`CompanionMedikitExecutionCore` + `BattlescapeGame` preflight]). Mis-aim facing **3** with correct adjacent geometry → **`MEDIKIT_APPLICATION_FAILED`**, no charge/TU/wound change — confirmed in default `companion_medikit_engine_test` relay harness (unchanged).

## 2. Test versus production

| Concern | Production | Release smoke (before) | Release smoke (after) |
|---------|------------|------------------------|------------------------|
| Adjacent east HEAL on DESERT uniform pad | Not claimed for headless certification | Required (misleading) | **Removed** — documented as non-certifiable |
| Co-tile HEAL relay on production rules | In S4C scope | Failed downstream of bad floor | **Asserted** (native co-tile resolution + `COMPLETED`) |
| Adjacent mis-aim reject | Native + relay reject | Polluted by stale relay / bad floor | **Asserted** at (1,1)/(2,1), dir **3**, fresh relay dir |
| `STR_MEDI_KIT`, hands, TU=10, charges | Production ruleset | Intended | **Unchanged** |

No production code changes were required. **Do not weaken** executor target matching or validation.

## 3. Test-only modifications

**File:** `engine/OpenXcom/src/test/companion_medikit_release_smoke_test.cpp`

1. **`ProductionSmokeHarness::resetRelayArtifacts()`** — clears command, result, journal, conflict, and publication confirm before scenarios (fixes stale-terminal false positives).
2. **Floor fixture** — open-floor wired with explicit `mapDataSets` (`releaseSmokeOpenFloor` set at index 0) and `initUtilities` parity with relay E2E harness; **6×6** map; **no** homogenous DESERT scan as gate.
3. **Success path** — renamed to **`runProductionCoTileHealSmoke`**: unconscious patient co-tile with medic (production native resolution without melee LOS).
4. **Mis-aim path** — re-wound patient, adjacent positions **(1,1)/(2,1)**, facing **3**; expects non-`COMPLETED`, no mutation (same semantics as `runRelayAdjacentMisAimedNoMutation`).
5. **Stderr note** — logs that homogenous DESERT MCD pads are excluded from this smoke scope.

## 4. Verification (post-repair)

```text
companion_medikit_release_smoke_test.exe (S4F Release)  → exit 0, WP9 medikit release smoke: PASS
companion_medikit_engine_test.exe                       → exit 0, All companion medikit engine tests passed
Node WP9 S1 / S3 / S4                                   → 14/14 pass
companion_psi_panic_engine_test.exe                     → exit 0
companion_psi_mind_control_engine_test.exe              → exit 0
git diff --check (engine/OpenXcom, companion)           → clean (no conflict markers / whitespace errors on checked diffs)
```

TU/charge accounting on passing smoke: co-tile HEAL **`tu_spent: 10`**, one heal charge consumed, torso fatal wound cleared; mis-aim leaves wound, charges, and TU unchanged.

## 5. Release readiness opinion

| Scope | Status |
|-------|--------|
| WP9 medikit relay (S4C/S4 Node+engine gates) | **Green** — unchanged |
| Release smoke | **Green** — certifies **production ruleset relay** (co-tile HEAL + adjacent mis-aim reject) |
| Adjacent facing-correct HEAL on ruleset-backed **mission** terrain | **Still not certified** by this smoke; use mission `.MAP` fixtures in follow-up, not uniform MCD pads |

**STOP** — investigation and test-only repair complete. No commit, push, live binary replacement, or GitHub inbox commands.