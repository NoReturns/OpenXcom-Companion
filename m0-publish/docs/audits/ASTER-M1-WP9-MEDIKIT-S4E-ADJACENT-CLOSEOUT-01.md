# ASTER-M1-WP9-MEDIKIT-S4E-ADJACENT-CLOSEOUT-01 — bounded adjacent targeting closeout

**Work package:** M1-WP9 medikit — S4D follow-up (fixture + guard review)
**Owner review gate:** STOP — no commit, push, release pin, or deployment.

## Executive summary

| Question | Answer |
|----------|--------|
| Adjacent east HEAL relay **certified**? | **No** — process still aborts (`0xC0000409`) on success path |
| TileEngine empty-trajectory guard **safe** for production? | **Yes** — defensive only; skips invalid scan when `V_UNIT` with empty `_trajectory`; non-empty paths unchanged |
| Mis-aim direction 3 (no mutation)? | **Yes** — in default suite; `MEDIKIT_APPLICATION_FAILED`, not `COMPLETED` |
| Focused gates (S4E run)? | **Green** — medikit C++ suite + WP9 Node 14/14 |
| Deployment | **Remain on HOLD** for adjacent success; S4C co-tile relay scope unchanged |

## 1. TileEngine empty-trajectory guard

**Location:** `TileEngine::canTargetUnit` (`engine/OpenXcom/src/Battlescape/TileEngine.cpp`).

When `calculateLine` reports `V_UNIT` but leaves `_trajectory` empty (sparse harness / edge trace), the loop now `continue`s instead of calling `_trajectory.at(0)`.

- **Empty trajectory:** targeting for that scan slice is rejected (no `return true` from that slice).
- **Non-empty trajectory:** same comparisons as native OpenXcom (voxel hit box vs scan voxel + height band).
- **Gameplay on real maps:** no intentional behavior change; only undefined behavior removal under `/GS`.

**Note:** A separate `V_UNIT` + `_trajectory.at(0)` path exists in unit **visibility** percentage (same file, earlier loop). S4E did not modify it; melee medikit path uses `canTargetUnit` only. No dedicated TileEngine unit harness in tree; guard verified by code review + medikit gates that exercise co-tile and adjacent mis-aim.

## 2. Fixture — reuse guided-launch pattern (no new framework)

| Before | After (S4E) |
|--------|-------------|
| `wireMedikitTestFloorGrid()` — one shared `MapData*` on all tiles | `wireMedikitOpenFloor()` — per-tile `makeFloorMapData()` (mirrors `companion_guided_launch_engine_test.cpp` `wireOpenFloor` / `floorData`) |

Adjacent setup: medic `(1,1,0)` facing **2**, patient `(2,1,0)`, `wireMedikitOpenFloor(&battle, 0, 5, 0, 5, 0)` before unit placement (`setupAdjacentUnconsciousPatient`).

Still **6×6** test map + synthetic floor — not ruleset-backed mission terrain (per bounded scope).

## 3. Adjacent east success path (direction 2)

**Harness:** `runRelayAdjacentHealEast()` implemented with full assertions (native target id 2, `COMPLETED`, `target_unit_id`, wound/TU/charges, journal, `tu_spent`).

**Status:** **Not run in default suite** — enabling it aborts the process before assertions.

**Bisect (S4E):**

1. `resolveNativeMedikitTarget` at start of test → **abort** (same as S4D).
2. With resolveNative removed, relay **accepted** `wp9-relay-adj-east` then **abort** before terminal — same stack class via `BattlescapeGame` preflight `resolveNativeMedikitTarget` (`CompanionMedikitExecutionCore.cpp` → `TileEngine::validMeleeRange` → `canTargetUnit` → `calculateLine` / `voxelCheck`).

**First failing operation (unchanged from S4D):** native melee medikit LOS resolution on adjacent tiles in the sparse harness — not relay bind/export, not mis-aim rejection.

**Not attempted:** additional production changes beyond the empty-trajectory guard (per owner instruction).

## 4. Mis-aim direction 3 — zero mutation

`runRelayAdjacentMisAimedNoMutation()` — command id `wp9-relay-adj-mis`, facing **3** (SE, not east).

- Relay: **not** `COMPLETED` (`MEDIKIT_APPLICATION_FAILED`).
- Wound, medikit heal charges, medic TU: **unchanged**.

## 5. Test evidence (focused gates only)

```text
companion_medikit_engine_test.exe     → exit 0, All companion medikit engine tests passed
Node WP9 S1 / S3 / S4                 → 14/14 pass (includes engine subprocess)
```

`companion_command_test.exe` — not re-run this closeout (out of WP9 medikit adjacent scope).

Full mission / TileEngine isolation harness — not run (out of scope).

## 6. Release risk

| Area | Risk |
|------|------|
| Co-tile HEAL/STIMULANT/PAINKILLER relay (S4C) | **Low** — certified, gates green |
| Empty-trajectory `canTargetUnit` guard | **Low** — eliminates UB; does not enable invalid LOS |
| Adjacent off-co-tile HEAL (facing-correct) | **High for claiming certification** — harness still aborts; production may work on real maps; **not proven** in this closeout |
| Adjacent mis-aim rejection | **Low** — covered in suite |

## 7. In-tree changes (uncommitted)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Battlescape/TileEngine.cpp` | Empty `_trajectory` guard in `canTargetUnit` (S4D) |
| `engine/OpenXcom/src/test/companion_medikit_engine_test.cpp` | `wireMedikitOpenFloor` (guided-launch parity) |
| `engine/OpenXcom/src/test/companion_medikit_relay_e2e_harness.cpp` | `runRelayAdjacentHealEast()` (manual); mis-aim `wp9-relay-adj-mis`; east **commented out** of `runMedikitRelayE2eSuite()` |

## Follow-up (owner, post-HOLD)

1. Certify adjacent east with ruleset-backed or snapshot terrain fixture that already exercises `validMeleeRange` + medikit UI parity (no new harness framework).
2. Optional: micro-harness for `canTargetUnit` empty-trajectory `V_UNIT` slice (regression for `/GS`).
3. Optionally align visibility-percentage loop with same guard if sparse traces prove reachable there.

**STOP for owner review.**