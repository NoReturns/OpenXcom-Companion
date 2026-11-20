# ASTER-M1-MC-03A — Mind-Controlled Hostile Weapon Firing

**Date:** 2026-11-20  
**Status:** **STOP — owner review** (implementation complete; terminal SNAP completion harness blocked — see below)  
**Scope:** Remote directed fire for AI-owned, X-COM-controlled hostiles (`MC_*_SHOT`). No runtime pin change, no commits in this checkpoint.

## Summary

MC-03A extends MC-02B with **`MC_SNAP_SHOT`**, **`MC_AUTO_SHOT`**, and **`MC_AIMED_SHOT`**, reusing soldier directed-fire shape (`target`, `active_hand`) and native `BattlescapeGame::tryExecuteCompanionDirectedFire`. MC-specific command types preserve actor identity and keep roster `SNAP_SHOT` / `AUTO_SHOT` / `AIMED_SHOT` validation unchanged.

## Command contract (schema v1)

| Field | SNAP / AUTO / AIMED (soldier) | MC hostiles |
|-------|----------------------------------|-------------|
| `command_type` | `SNAP_SHOT` / `AUTO_SHOT` / `AIMED_SHOT` | `MC_SNAP_SHOT` / `MC_AUTO_SHOT` / `MC_AIMED_SHOT` |
| `actor_unit_id` | `player_soldiers` | ≥ `MAX_SOLDIER_ID`, listed in `player_mc_hostiles`, AI-owned |
| `active_hand` | `STR_LEFT_HAND` / `STR_RIGHT_HAND` | Same |
| `target` | `{x,y,z}` map voxel | Same (terrain / wall targeting permitted when stock preflight allows) |
| Binding | `snapshot_sha256`, `session_id`, `turn`, `state_version` | Same (MC authority core) |

**Execution path:** parse → MC authority + weapon contract preflight → `tryExecuteCompanionDirectedFire` → `UnitTurnBState` + `ProjectileFlyBState` (same stack as soldiers). Relay results use `buildSnapShotResultJson` so `command_type` echoes `MC_*`.

**Rejected (representative):** same MC-02B authority codes (`NOT_AI_CONTROLLED`, `STALE_*`, `INVALID_ACTOR`, roster/HWP identity), plus fire contract codes (`WEAPON_NOT_IN_HAND`, `NO_AMMUNITION`, `INSUFFICIENT_TU`, `NO_LINE_OF_FIRE`, `UNSUPPORTED_WEAPON`, `PRIOR_COMMAND_NON_TERMINAL`, `MC_*_START_FAILED`).

## AUTO fire — native interruption semantics

Stock `ProjectileFlyBState` drives bursts: each loop increments `autoShotCounter` and may queue another round while `autoShotCounter < weapon->getRules()->getAutoShots()` and ammunition remains. **Authority loss or `cancelCurrentAction` after acceptance does not roll back rounds already committed** to the state stack; relay may report `INTERRUPTED` with partial TU/ammo spend matching how far the native stack progressed. Do not promise per-projectile mid-flight cancellation beyond stock behavior.

## Implementation

### Engine (`engine/OpenXcom/src`)

| Area | Files |
|------|--------|
| Fire execution | `CompanionTacticalMcHostileFireExecutionCore.{h,cpp}` — contract build, preflight, `tryStartMcDirectedFire` |
| Parsers | `CompanionCommandCore.{h,cpp}` — `parseMcSnapShotCommandJson`, `parseMcAutoShotCommandJson`, `parseMcAimedShotCommandJson` |
| Relay runtime | `CompanionCommandRuntime.cpp` — `KIND_MC_*_SHOT`, inbox handler, in-flight completion (MC authority re-check), projectile notify hooks |
| Stock reuse | `BattlescapeGame::preflightCompanionDirectedFire` / `tryExecuteCompanionDirectedFire` (unchanged) |

### Companion Node (`companion/m0-publish`)

| Area | Files |
|------|--------|
| Binding flags | `mc-hostile-command-binding.cjs` — `mcSnapShotExecutionSupported`, `mcAutoShotExecutionSupported`, `mcAimedShotExecutionSupported` |
| Compose | `command-binding.cjs` — `composeMcSnapShotCommand`, `composeMcAutoShotCommand`, `composeMcAimedShotCommand` |
| Validate | `tactical-command.cjs` — parse + `validateMc*ShotAgainstSnapshot` |
| Tests | `test/tactical-command-m1-mc-s3a-fire.test.cjs` |

### Certification harnesses

| Harness | Role |
|---------|------|
| `companion_tactical_mc_hostile_authority_test` | MC fire JSON parse + relay gate |
| `companion_mc_hostile_move_relay_terminal_test` | MC fire human reject; SNAP terminal case **present but disabled in `main`** (see limitations) |
| `companion_mc_hostile_fire_relay_terminal_test` | Standalone SNAP cert (does not complete — see limitations) |

## Test results (local, Release `build-s4j-rc`, 2026-11-20)

### Node

| Suite | Result |
|-------|--------|
| `tactical-command-m1-mc-s3a-fire.test.cjs` | **3/3 pass** |
| `tactical-command-m1-mc-s2b-execution.test.cjs` | **4/4 pass** (regression) |

### Native

| Target | Result |
|--------|--------|
| `companion_tactical_mc_hostile_authority_test` | **pass** (includes MC fire parse + `mcFireRelayExecutionSupported`) |
| `companion_mc_hostile_move_relay_terminal_test` | **pass** (includes `certMcFireHumanRejected`; MC move / turn / authority regressions) |

### Terminal firing evidence (partial)

| Case | Observed |
|------|----------|
| `MC_SNAP_SHOT` accept + `EXECUTING` | **Yes** — log: `accepted MC fire` + `SNAP_SHOT started`, result JSON `command_type: MC_SNAP_SHOT`, TU accounting extensions present |
| `MC_SNAP_SHOT` `COMPLETED` + ammo/TU terminal | **Blocked** — process exit `0xC0000409` on first `BattlescapeGame::handleState()` after projectile queue (reproducible in harness; not observed for `MC_MOVE`) |
| `MC_SNAP_SHOT` human reject | **Yes** — `NOT_AI_CONTROLLED`, no TU spend (`certMcFireHumanRejected`) |
| `MC_AUTO_SHOT` / `MC_AIMED_SHOT` terminal | **Not run** in harness this checkpoint (parsers + Node validation only) |

Manual log excerpt (pre-crash):

```
[INFO] Companion command: accepted MC fire ... type=MC_SNAP_SHOT
[INFO] Companion command: SNAP_SHOT started ... actor=1000042
```

## Known limitations

1. **Terminal harness crash:** `certMcSnapFireTerminal()` is implemented on the move terminal harness but **commented out of `main`** until `handleState` crash is root-caused. Standalone `companion_mc_hostile_fire_relay_terminal_test` also aborts during init/rules load in this environment.
2. **AUTO/AIMED terminal:** No `companion_mc_hostile_fire_relay_terminal` `COMPLETED` cases yet; contract and runtime paths mirror SNAP.
3. **`mcTacticalCommandExecutionSupported()`:** Still returns `false` (unchanged global gate); per-command `mcFireRelayExecutionSupported()` enables MC fire only.
4. **Runtime pin / deploy:** `companion-canonical-runtime.cjs` unchanged — live MC fire requires owner-approved build promotion after terminal gap is closed.
5. **Scope exclusions (unchanged):** MC grenades, reload, weapon swap, kneel, inventory — not in this slice.

## Outstanding requirements for live testing

1. Owner reproduces **`MC_SNAP_SHOT` terminal `COMPLETED`** on promoted `openxcom.exe` with F6 export + relay (or fix harness crash and re-enable CI case).
2. **`MC_AUTO_SHOT`** and **`MC_AIMED_SHOT`** terminal certification with appropriate alien weapons (burst + aimed TU/ammo).
3. Authority-loss **during** burst: confirm partial ammo/TU matches AUTO semantics above.
4. Friendly-fire / reaction fire spot-check on MC hostiles (stock mechanics only).
5. Optional: terrain/wall target on live UFO map.

---

**STOP for owner review.** No git commit, push, deployment, or canonical runtime pin change in this delivery.