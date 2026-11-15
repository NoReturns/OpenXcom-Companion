# ASTER-M1-WP9-MEDIKIT-S0-OBSERVATION-01

**Date:** 2026-11-15
**Scope:** Stage S0 only — additive snapshot observation (no relay commands, no gameplay changes)
**Stop:** Owner review before S1 command schema.

## Verdict

S0 **complete** in canonical `engine/OpenXcom` + `companion/m0-publish`. Additive fields validate on schema v5; focused C++ and Node tests pass.

## Source files touched

| Area | File |
|------|------|
| Export | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` |
| Condition / wounds | `engine/OpenXcom/src/Engine/CompanionSnapshotUnitState.{h,cpp}` |
| Node schema | `companion/m0-publish/lib/tactical-publish.cjs` |
| Equipment brief | `companion/m0-publish/lib/tactical-equipment-brief.cjs` |
| Schema doc | `companion/m0-publish/docs/M1-wp2-unit-state-schema.md` |
| C++ tests | `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` (`testWp9MedikitS0Observation`) |
| Node tests | `companion/m0-publish/test/medikit-s0-observation.test.cjs` |

## Snapshot shape (before → after)

**Live roster friendly soldiers only** (`isLiveRosterFriendlyUnit`):

| Field | Before | After |
|-------|--------|-------|
| `fatalWounds` | absent | `[w0…w5]` always when live roster (zeros allowed) |
| `condition.maxHealth` | absent | base max HP from `BattleUnit` stats |
| `actionCosts.hands.{right,left}.actions[]` | no medikit `use` | row `{ id: "use", actionType: 9, tuCost, canAffordTu, usable }` when hand holds `BT_MEDIKIT` |

**Unchanged:** hostiles / neutrals omit `fatalWounds`, `condition`, and full friendly detail. Medikit in belt/backpack only — no hand `use` row until wielded. Medikit gameplay, targeting, and charge rules unchanged.

**TU:** `tuCost` = `BattleUnit::getActionTUs(BA_USE, item)` (ruleset `tuUse` + `flatRate` semantics).

## Tests run

| Suite | Result |
|-------|--------|
| `node --test test/medikit-s0-observation.test.cjs` | 5/5 pass |
| `companion_snapshot_serialization_test.exe` (rebuild `build-isolated-m1-23e`) | pass (includes `testWp9MedikitS0Observation`) |

## Build note

Incremental rebuild: `companion_snapshot_serialization_test.vcxproj` under `engine/OpenXcom/build-isolated-m1-23e`. No `openxcom.exe` link required for S0.

## Backward compatibility

- **Additive:** existing consumers ignoring unknown unit keys continue to work; strict validators accept new optional fields on roster rows only.
- **Fair-play:** no alien wound/HP leak; `fatalWounds` rejected by Node on non-roster units.
- **No command surface:** `tactical-command.cjs` command types unchanged.

## Next (not in this change)

S1–S3: `HEAL` / `STIMULANT` / `PAINKILLER` relay commands and `tryExecuteCompanionMedikit*` per `ASTER-M1-WP9-MEDIKIT-AUDIT-01.md`.