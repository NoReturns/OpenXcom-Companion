# ASTER-M1-WP9-MEDIKIT-RELEASE-SMOKE-01 — production-ruleset adjacent HEAL smoke

**Owner gate:** STOP — no commit, push, live deployment, or runtime pin changes.

## Verdict

| Item | Result |
|------|--------|
| **Release smoke (adjacent east HEAL)** | **FAIL** |
| **Crash on production path** | **No** (no `0xC0000409`; relay rejects cleanly) |
| **Mis-aim rejection (dir 3), no mutation** | **Partial** — `MEDIKIT_APPLICATION_FAILED`, charges/TU/wound unchanged on exercised path; second command hit `DUPLICATE_COMMAND_ID` after failed east attempt (harness hygiene) |
| **Default WP9 gates** | **Green** (unchanged; synthetic east remains disabled) |
| **Live WP9 deployment** | **Hold** — adjacent facing-correct HEAL not certified on production-ruleset disposable scenario |

## Isolated Release candidate (not deployed)

| Artifact | Path |
|----------|------|
| `openxcom.exe` (Release, WP9 + TileEngine guard in tree) | `local/m0/release-candidates/ASTER-M1-WP9-MEDIKIT-SMOKE-RC-01/bin/openxcom.exe` |
| `companion_medikit_release_smoke_test.exe` (manual smoke) | same folder |
| Build source | `engine/OpenXcom/build-isolated-m1-23e/bin/Release/` |

**Not modified:** `runtime/m0/bin` pin, owner campaign, deployed executable.

## Smoke scenario (bounded)

- **Ruleset:** `Game` + `loadMods()` against `runtime/m0/bin` (xcom1 standard).
- **Items / inventory:** `STR_MEDI_KIT`, `STR_RIGHT_HAND`; research `STR_MEDI_KIT` finished on disposable `SavedGame`.
- **Units:** `STR_SOLDIER` + `STR_PERSONAL_ARMOR_UC`; roster ids 1 (medic) / 2 (patient).
- **Terrain:** Production **DESERT** `MapDataSet` MCD + voxel data (`loadMapResources`); scanned up to 256 walkable floor objects for one that yields `resolveNativeMedikitTarget` → id **2** with medic `(5,5)` facing **2** and patient `(6,5)`.
- **Relay:** Same inbox pattern as WP9 E2E (`wp9_medikit_release_smoke/` beside smoke exe).

## Observed failures (east success path)

1. **No DESERT floor object** in the scan window produced native adjacent target id 2 (`FAIL: DESERT MCD floor supports adjacent native medikit target`).
2. **`resolveNativeMedikitTarget`** did not yield patient id 2 before relay.
3. Relay **`MEDIKIT_APPLICATION_FAILED`** / not `COMPLETED`; gameplay fields unchanged on reject (consistent with native admission).

**Exceptions during setup (fixed in harness):** thrown `getArmor(..., true)` and incomplete patient YAML — caught as `OpenXcom::Exception` / `std::exception`; not production defects.

## Regression gates (this run)

```text
companion_medikit_engine_test.exe          → exit 0
Node WP9 S1 / S3 / S4                      → 14/14 pass
companion_medikit_release_smoke_test.exe   → exit 1 (manual only; not in Node gate)
```

Synthetic `runRelayAdjacentHealEast()` remains **commented out** of default medikit suite (per owner).

## Release readiness opinion

| Scope | Ready? |
|-------|--------|
| Co-tile relay (S4C bounds) | **Yes** (gates green) |
| TileEngine empty-trajectory guard | **Yes** (safe; production desert scan did not crash) |
| Adjacent off-co-tile HEAL on ruleset-backed tactical | **No** — smoke failed native LOS / target resolution on disposable DESERT grid |
| Pin / deploy WP9 for adjacent success claims | **No** — remain on **HOLD** |

## In-tree harness (uncommitted)

- `engine/OpenXcom/src/test/companion_medikit_release_smoke_test.cpp` — manual smoke executable.
- `engine/OpenXcom/src/CMakeLists.txt` — optional target `OPENXCOM_BUILD_COMPANION_MEDIKIT_RELEASE_SMOKE_TEST` (no `add_test`).

**STOP for owner review.**