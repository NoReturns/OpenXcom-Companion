# ASTER-M1-HWP-S2A — Friendly HWP ownership and command binding

**Status:** Implementation complete (local only — no commit, push, or runtime deploy)  
**Bases:** Engine `1ca8f1955…`, Companion `50f248d…`  
**Scope:** Ownership publication + relay mirror + `commandBinding.player_hwps` preparation only. No HWP MOVE/TURN/FIRE execution.

---

## Files changed

### Engine (`OpenXcom`, `aster/m0`)

| File | Change |
|------|--------|
| `src/Savegame/SavedBattleGame.h` / `.cpp` | `_companionTacticalAiHwpIds`, assign/reclaim tactical HWP AI set (battle-scoped; no geoscape seed) |
| `src/Engine/CompanionSoldierOwnershipCore.h` / `.cpp` | Control doc schema **1/2**; parse `hwp_assignments`; `isAiControlledHwpUnit()`; roster/HWP id band validation |
| `src/Engine/CompanionSoldierControlPublishCore.h` / `.cpp` | Emit schema **2** + `hwp_assignments` when friendly HWPs on battlescape |
| `src/Engine/CompanionSnapshot.cpp` | `collectPublishableFriendlyHwpUnitIds()`; pass HWP ids into control publish |
| `src/test/companion_soldier_control_publish_test.cpp` | `testHwpAiPublishesHwpAssignments` |

### Companion (`OpenXcom-Companion`, `main`)

| File | Change |
|------|--------|
| `m0-publish/lib/hwp-command-binding.cjs` | **New** — `player_hwps` rows, control mode resolution, assignment disjointness checks |
| `m0-publish/lib/command-binding.cjs` | Binding schema **2**; `player_hwps[]`; parse accepts v1/v2 |
| `m0-publish/lib/soldier-control-relay.cjs` | Parse/mirror `hwp_assignments`; `soldierControl.hwps[]`; validation |
| `m0-publish/lib/tactical-publish.cjs` | Build `soldierControl` before `commandBinding` (HWP control modes) |
| `m0-publish/docs/M1-wp2-unit-state-schema.md` | S2a contract note |
| `m0-publish/test/tactical-command-m1-hwp-s2a-ownership.test.cjs` | **New** — S2a gate suite |

---

## Ownership schema

### Local file: `companion-soldier-control.json`

| Field | v1 (soldiers only) | v2 (+ HWP) |
|-------|-------------------|------------|
| `schema_version` | `1` | `2` when any publishable friendly HWP on map |
| `session_id` | 32 hex | unchanged |
| `campaign_id` / `tactical_battle_id` | 32 hex durable battle scope | unchanged |
| `assignments` | roster ids `< 1_000_000` → `"ai"` only | unchanged |
| `hwp_assignments` | — | HWP ids `≥ 1_000_000` → `"ai"` only; **omitted = human** |

**Rules**

- Individual HWP human/AI: tactical `_companionTacticalAiHwpIds` (default **human**, no auto-AI).
- Soldier assignments remain independent (`assignments` vs `hwp_assignments`).
- Stale battle/mission: durable `tactical_battle_id` + `campaign_id` must match relay context (same as soldiers); wrong battle → mirror `unavailable`.
- Unknown HWP id in file → mirror `unavailable` (`unknown_assignment_hwp_id`).
- Roster id in `hwp_assignments` or HWP id in `assignments` → parse/reject.

### Relay mirror: `soldierControl`

```json
{
  "schema_version": 2,
  "availability": "available",
  "session_id": "f6e5d4c3b2a19081726354433221100a",
  "soldiers": [{ "id": 1, "controlMode": "ai" }],
  "hwps": [
    { "id": 1000000, "controlMode": "ai" },
    { "id": 1000001, "controlMode": "human" }
  ]
}
```

---

## Example mixed squad assignment

**Control file (beside tactical export):**

```json
{
  "schema_version": 2,
  "session_id": "f6e5d4c3b2a19081726354433221100a",
  "campaign_id": "0123456789abcdef0123456789abcdef",
  "tactical_battle_id": "fedcba9876543210fedcba9876543210",
  "assignments": { "1": "ai", "2": "ai" },
  "hwp_assignments": { "1000000": "ai" }
}
```

- Soldiers **1, 2** → AI via `assignments`.  
- HWP **1000000** → AI via `hwp_assignments`.  
- HWP **1000001** (if on map, not listed) → **human**.

---

## Binding example

`commandBinding` schema **2** (relay envelope; **does not** change tactical YAML `snapshot_sha256` / digest):

```json
{
  "schema_version": 2,
  "snapshot_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "state_version": 0,
  "session_id": "f6e5d4c3b2a19081726354433221100a",
  "turn": 1,
  "player_soldiers": [
    { "id": 1, "position": [1, 1, 0], "kneeled": false, "name": "Roster Anchor", "timeUnits": 60 }
  ],
  "player_hwps": [
    {
      "id": 1000000,
      "position": [5, 5, 0],
      "controlMode": "ai",
      "commandExecutionSupported": false,
      "observationPresent": true,
      "hwpUnitType": "STR_TANK_CANNON",
      "friendlyHwpObservationV1": {
        "schemaVersion": 1,
        "unitId": 1000000,
        "hwpUnitType": "STR_TANK_CANNON",
        "position": { "x": 5, "y": 5, "z": 0 },
        "timeUnits": 70,
        "bodyFacing": { "direction": 2, "label": "east", "vector": { "dx": 1, "dy": 0 } },
        "fixedWeapons": [{ "itemType": "STR_TANK_CANNON", "loaded": { "ammoType": "STR_TANK_CANNON_SHELL", "rounds": 6 } }]
      }
    }
  ],
  "hwp_binding_schema_version": 1
}
```

Soldier command composers still require `player_soldiers` only; HWP id in `actor_unit_id` continues to fail Node/engine validation for existing command types.

---

## Test results

| Gate | Result |
|------|--------|
| `node --test test/tactical-command-m1-hwp-s2a-ownership.test.cjs` | **9/9 PASS** |
| `node --test test/friendly-hwp-observation-v1.test.cjs` | **3/3 PASS** (S1 preserved) |
| `node --test test/publish-tactical.test.cjs` | **PASS** (incl. sparse HWP v5) |
| `node --test test/soldier-control-relay-p1b.test.cjs` | **11/11 PASS** (soldier regression) |
| `companion_soldier_control_publish_test.exe` | **PASS** (+ HWP publish case) |

**Not run:** Full relay/mission simulators, runtime deploy, `openxcom.exe` link (canonical SHA unchanged).

---

## Compatibility checklist

| Requirement | Status |
|-------------|--------|
| Sparse HWP unit rows (S1) | Preserved — `player_hwps` is binding-only |
| `friendlyHwpObservationV1` additive | Referenced in binding row, not top-level roster fields |
| HWP ∉ `player_soldiers` | Enforced in binding build + tests |
| Soldier command authority | Unchanged — composers/bind validators roster-only |
| Hostile/neutral HWP | Never in publishable HWP set or binding |
| Snapshot digest rules | Unchanged — HWP data on relay envelope only |

---

## Remaining authority and execution blockers

1. **Engine relay gate** — `CompanionCommandRuntime` still checks roster `tacticalAiSoldierIds` + soldier control `assignments`; no HWP command dispatch path.
2. **`tryExecuteCompanion*`** — No HWP MOVE/TURN/FIRE/B_FIRE entry points; `isLiveCampaignPlayerSoldierUnit()` unchanged.
3. **`tactical-command.cjs`** — No HWP `command_type`; validation still requires actor ∈ `player_soldiers`.
4. **`commandExecutionSupported: false`** — Binding flag only; must not be treated as authorization until a future WP enables it together with engine checks.
5. **Battlescape UI** — No in-game HWP AI toggle yet; tactical AI HWP set is API-only (`assignCompanionTacticalHwpToAi`).
6. **Deployed runtime** — Pin `1b93b14f…` has no S2a engine bits until owner promotes a new build (observation S1 on deployed binary likewise pending prior promotion).

---

**STOP** — owner review before commit/checkpoint.