# ASTER-M1-HWP-S3B-01 — HWP movement contract (Node + engine validation)

**Date:** 2026-11-19  
**Engine base:** `0038d282deddd180c523b4c5c31109d4de6d9baa` (+ local S3B delta, uncommitted)  
**Companion base:** `2c5994e0047e74cd7b9a1be4ce5af91eda771eb0` (+ local S3B delta, uncommitted)  
**Scope:** `HWP_MOVE` Node contract, engine parse/contract validation, native movement investigation. **No live HWP movement execution.**

---

## 1. Native HWP movement (human battlescape)

### Call path (reuse target for future S3 execution)

| Stage | Location | Role |
|-------|----------|------|
| Selection | `SavedBattleGame::selectUnit` / `BattlescapeState` | Friendly HWP selected like soldiers (`BattleUnit`, not geoscape `Soldier`). |
| Path preview | `BattlescapeGame` click-move (`_currentAction.target = pos`) | `SavedBattleGame::getPathfinding()->calculate(actor, target)` |
| Path engine | `Pathfinding::calculate` → `bresenhamPath` or `aStarPath` | Uses `unit->getArmor()->getSize()` for **2×2 footprint**; `getMovementType()` walk vs `MT_FLY`. |
| Destination check | `Pathfinding::calculate` (lines ~128–159) | Corner tiles, diagonal doors, visible occupant rejection for large units. |
| Confirm walk | `BattlescapeGame` / `statePushBack(UnitWalkBState)` | `BattleAction.type = BA_WALK`, `playerOrdered = true`. |
| Companion soldier MOVE | `BattlescapeGame::tryExecuteCompanionMove` | **Same** `calculate` + `UnitWalkBState` queue; no parallel pathfinder. |
| Step execution | `UnitWalkBState::think` | `keepWalking`, multi-tile `setUnit`/`setUnit(0)` on all footprint corners; hull/turret `lookAt(..., getTurretType() != -1)`. |
| TU spend | `Pathfinding` path cost + `BattleUnit::keepWalking` | Native TU/energy; Node does not estimate path TU for HWPs. |
| Doors / walls | `Pathfinding::isBlocked`, door checks on 2×2 corners | Engine-only; destructible terrain via normal walk/burn rules, **not** remote MOVE wall-break. |
| Partial / interrupt | `UnitWalkBState` | Reaction fire, proximity grenade, hostile spotted, path blocked → `abortPath`, `CompanionWalkStopTokens` on `playerOrdered` walks. |
| Final pose | End of walk segment | `STATUS_STANDING`, position/facing on leading tile; footprint occupancy updated on all corners. |

### Safe reuse for remote HWP (future execution WP)

- **`Pathfinding::calculate(unit, dest)`** — authoritative path, footprint, doors, TU.
- **`BattlescapeGame::tryExecuteCompanionMove`** (or thin wrapper `tryExecuteCompanionHwpMove`) — already selects unit, cancels action, queues `UnitWalkBState` with `playerOrdered`.
- **Do not** duplicate A* / corridor logic in Companion code.

### Footprint / pathfinding findings

- Size from **armor** (`getArmor()->getSize()`): 2 for tanks; loops in `Pathfinding` and `UnitWalkBState` use `(size+1)²` tiles.
- Flying HWPs use `MT_FLY`; skipping floor fall logic where applicable.
- Strafe (`CTRL`) is **size == 1 only** in vanilla click path — not applicable to 2×2 HWPs.
- Incomplete snapshot terrain must **not** be used to promise reachability (relay terrain brief is partial).

---

## 2. `HWP_MOVE` schema (command schema v1)

```json
{
  "schema_version": 1,
  "command_id": "hwp-move-example",
  "command_type": "HWP_MOVE",
  "actor_unit_id": 1000000,
  "destination": { "x": 6, "y": 5, "z": 0 },
  "snapshot_sha256": "<64-hex>",
  "session_id": "<32-hex>",
  "turn": 1,
  "state_version": 42
}
```

| Rule | Detail |
|------|--------|
| Envelope | Same binding fields as roster `MOVE` (`schema_version`, `command_id`, freshness quadruple). |
| Actor | `actor_unit_id >= 1_000_000`; **listed in `commandBinding.player_hwps`** with `controlMode: "ai"`; never in `player_soldiers`. |
| Destination | Integer `destination.{x,y,z}` within `tactical.map`; **no path validation** in Node. |
| Roster `MOVE` | `composeMoveCommand` rejects HWP ids; requires `player_soldiers` only. |
| Execution | `player_hwps[].commandExecutionSupported` remains **`false`**; engine `hwpTacticalCommandExecutionSupported()` → **`false`**. |
| Relay | `CompanionCommandRuntime` still treats `HWP_MOVE` as **unsupported** (`UNSUPPORTED_COMMAND_TYPE`) — not dispatched. |

---

## 3. Files changed

| Path | Change |
|------|--------|
| `companion/m0-publish/lib/command-binding.cjs` | `composeHwpMoveCommand`; `composeMoveCommand` HWP id guard |
| `companion/m0-publish/lib/tactical-command.cjs` | `parseHwpMoveCommand`, `validateHwpMoveAgainstSnapshot`, dispatcher |
| `companion/m0-publish/lib/tu-composite-advisory.cjs` | `buildHwpMovePlanningHint` (advisory only) |
| `companion/m0-publish/test/tactical-command-m1-hwp-s3b-movement.test.cjs` | **New** Node tests |
| `engine/OpenXcom/src/Engine/CompanionCommandCore.{h,cpp}` | `parseHwpMoveCommandJson` |
| `engine/OpenXcom/src/Engine/CompanionTacticalHwpAuthorityCore.{h,cpp}` | `validateHwpMoveCommand`, `validateHwpMoveExecutionPreflight` |
| `engine/OpenXcom/src/test/companion_tactical_hwp_authority_test.cpp` | S3B parse/contract tests |
| `companion/m0-publish/docs/audits/ASTER-M1-HWP-S3B-01-MOVEMENT-CONTRACT.md` | This report |

**Not changed:** `CompanionCommandRuntime.cpp` (no `HWP_MOVE` branch), soldier `validateMoveCommand`, runtime deploy pin.

---

## 4. Safety checklist

| Requirement | Status |
|-------------|--------|
| No HWP command execution | `validateHwpMoveExecutionPreflight` → `HWP_EXECUTION_NOT_SUPPORTED` |
| No runtime dispatch | `HWP_MOVE` ∉ runtime inbox type allowlist |
| Soldier MOVE unchanged | Regression in Node + engine authority mix test |
| No wall destruction via MOVE | No engine change; vanilla walk only |
| No turret/fire commands | Out of scope; not added |
| No hidden terrain disclosure | Node checks bounds only; no LOS/path |

---

## 5. Recommended engine execution integration (S3+)

1. Extend `CompanionCommandRuntime::tick` inbox allowlist with `HWP_MOVE` **only when** `hwpTacticalCommandExecutionSupported()` flipped by owner.
2. Parse via `parseHwpMoveCommandJson`; preflight `validateHwpMoveExecutionPreflight` then `validateHwpMoveCommand`.
3. On accept, call `tryExecuteCompanionMove(aiHwp, dest)` (or dedicated wrapper that first runs `evaluateHwpRemoteCommandAuthority`).
4. Journal / event log: reuse MOVE completion patterns; map `UnitWalkBState` stop tokens for interrupts.
5. Keep **separate** command type so soldier MOVE validators never see HWP actors.

### Architectural blockers (none critical)

- **2×2 goal tile:** Destination in JSON is a single tile (engine anchor); OpenXcom already interprets this for large units in `Pathfinding::calculate`.
- **VTOL / flying HWPs:** Movement type from armor rules; same `calculate` entry point.
- **Partial terrain in relay:** Operators must not treat Node validation as path proof (documented in `destination_note` / planning hint).

---

## 6. Test results

| Suite | Result |
|-------|--------|
| `tactical-command-m1-hwp-s3b-movement.test.cjs` | **8/8 PASS** |
| `tactical-command-m1-24b.test.cjs` (MOVE compose regression) | **12/12 PASS** |
| `companion_tactical_hwp_authority_test` (Release) | **PASS** (13 scenarios incl. S3B parse/contract) |
| `companion_tactical_authority_test` (Release) | **PASS** |
| `companion_soldier_control_publish_test` (Release) | **PASS** |

Owner: run from `companion/m0-publish`:

```bash
node --test test/tactical-command-m1-hwp-s3b-movement.test.cjs test/tactical-command-m1-24b.test.cjs
```

Engine (Release, `build-s4j-rc`):

```bash
companion_tactical_hwp_authority_test.exe
companion_tactical_authority_test.exe
```

---

## 7. STOP — owner review

No commit, push, or runtime deployment in this package. Enable execution only after a follow-on work package flips the execution lock and wires runtime dispatch with full interrupt/journal behavior.