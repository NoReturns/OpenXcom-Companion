# ASTER-M1-MC-03A-FIX-01 — MC terminal SNAP harness repair

**Date:** 2026-11-20  
**Status:** **STOP — owner review**  
**Scope:** Harness-only fixture parity with certified HWP fire relay bootstrap; re-enable `certMcSnapFireTerminal()` in default `main`. No production firing changes, no deploy/pin, no commits in this checkpoint.

## Executive summary

Terminal **`MC_SNAP_SHOT`** certification is **unblocked in-tree** on `companion_mc_hostile_move_relay_terminal_test.exe` after aligning battle bootstrap and fire tick loop with `companion_hwp_fire_relay_test.cpp` (S5-1CH / S5-1CI). The prior `0xC0000409` abort was **not** reproduced with the repaired fixture.

**AUTO / AIMED** terminal cases remain **out of scope** for this slice (per owner direction).

---

## Fixture changes (exact)

**File:** `engine/OpenXcom/src/test/companion_mc_hostile_move_relay_terminal_test.cpp`

| Before (CRASH-01) | After (FIX-01) |
|-------------------|----------------|
| `battle->setTestMod(&fixtureMod)` + `initUtilities(&fixtureMod)` | `Mod *rules = game->getMod()`; `setTestMod(rules)`; `initUtilities(rules)` |
| No `loadMapResources` | `battle->loadMapResources(rules)` **before** floor wire |
| Synthetic `certFloorTile()` / `mc_relay_terminal_floor` (no `SurfaceSet`) | `renderableFloorTile(rules)` + `wireFloor(battle, rules, w, h)` with assert (S5-1CI) |
| Fire completion: `handleState()` loop only | `CertHarness::advanceUntilTerminal()` — `battlescape->think()` + `tickRelay()` (HWP parity) |
| `certMcSnapFireTerminal()` disabled in `main` | **Re-enabled** in default regression `main` |
| — | `CompanionCommandRuntime::abandonInFlightCommandForTestHarness()` at `setupBattle` start |
| — | `setTUReserved(BA_NONE)` / `setKneelReserved(false)` (HWP parity) |

Removed: `certFloorSet()`, `certFloorTile()`, two-argument `wireFloor(battle, w, h)`.

Diagnostic env `OPENXCOM_MC_FIRE_CRASH_DIAG` retained from CRASH-01 (optional forensics only).

---

## Reproduction before / after

| Run | Floor audit | Relay after accept | Process exit | Terminal |
|-----|-------------|--------------------|--------------|----------|
| **Before** (`OPENXCOM_MC_FIRE_CRASH_DIAG=relay`, broken floor) | `renderableSurfaceset=no` `mc_relay_terminal_floor` | `EXECUTING` logged | `0xC0000409` / `-1073741787` | **No** `COMPLETED` |
| **After** (default `main`, repaired fixture) | `wireFloor: dataset=URBAN surfaceset=yes` | `EXECUTING` → stack run | **0** | **`COMPLETED`** |

Bare `tryExecuteCompanionDirectedFire` (no relay) also benefited from the same `setupBattle()` when run under diagnostic modes; default certification path is relay terminal.

---

## Terminal SNAP evidence (Release, `runtime/m0/bin`, 2026-11-20)

### Engine observations (`certMcSnapFireTerminal`)

| Check | Result |
|-------|--------|
| Accept + `EXECUTING` | **Pass** — `command_type: MC_SNAP_SHOT` |
| Native stack completion | **Pass** — `advanceUntilTerminal` ~3784–4225 ticks, no crash/hang |
| Relay terminal | **Pass** — `status: COMPLETED` |
| Shooter position | **(4,4,0)** unchanged |
| Actor id | **1000042** (`MC_HOSTILE_ID`) |
| TU (engine) | **80 → 69** (**11** spent) |
| Ammo (pistol clip) | **12 → 11** (exactly **one** round) |
| Battle idle after terminal | **Pass** |

### Terminal result JSON (representative)

```json
{
  "schema_version": 1,
  "command_id": "cert-mc-snap-fire",
  "command_type": "MC_SNAP_SHOT",
  "status": "COMPLETED",
  "actor_unit_id": 1000042,
  "starting_position": { "x": 4, "y": 4, "z": 0 },
  "final_position": { "x": 4, "y": 4, "z": 0 },
  "remaining_tu": 69,
  "kneeled": false,
  "destination_reached": false,
  "completed_at": "engine-local"
}
```

**Note:** MC SNAP completion uses `buildSnapShotResultJson` (soldier-shaped schema). Harness asserts **engine** TU/ammo and relay `remaining_tu` / positions; it does **not** require HWP-only fields (`projectile_launched`, `tu_spent`, `ammo_remaining`) on the JSON — those are future relay enrichment if desired, not part of this harness slice.

### TU / ammunition accounting

| Metric | Value |
|--------|--------|
| TU at accept (shooter) | 80 |
| TU after terminal | 69 |
| **TU spent** | **11** |
| Pistol rounds before | 12 |
| Pistol rounds after | 11 |
| **Rounds fired** | **1** |

EXECUTING payload includes `tu_accounting` extensions (facing estimate + snap action TU); terminal completion records `remaining_tu: 69`.

---

## Regression results (same checkpoint)

| Suite | Result |
|-------|--------|
| `companion_mc_hostile_move_relay_terminal_test.exe` (default, diag env unset) | **Pass** — includes **SNAP terminal** + MC_MOVE, TURN_FACE, authority, posture rejects |
| `companion_tactical_mc_hostile_authority_test.exe` | **Pass** |
| Node `tactical-command-m1-mc-s3a-fire.test.cjs` | **Pass** |
| Node `tactical-command-m1-mc-s2b-execution.test.cjs` | **Pass** |
| `companion_hwp_fire_relay_test` full matrix | **Not re-run** this slice (HWP unchanged; fixture pattern copied from certified harness) |

---

## Remaining certification (not in FIX-01)

| Item | Status |
|------|--------|
| `MC_AUTO_SHOT` terminal harness | **Not run** — owner: after SNAP acceptance |
| `MC_AIMED_SHOT` terminal harness | **Not run** — owner: after SNAP acceptance |
| Live F6 / promoted runtime pin | **Still blocked** until owner accepts harness + live checklist |
| `companion_mc_hostile_fire_relay_terminal_test.cpp` standalone | **Not updated** — still duplicate skeleton; recommend delete or point at shared bootstrap |
| Relay JSON: `projectile_launched` / ammo fields for MC | **Optional** future relay parity with `buildHwpFireResultJson`; not required for SNAP terminal proof |

---

## Unresolved defects

None blocking **in-tree SNAP terminal** certification after this harness repair.

**Known limitations:**

- High tick count (~4k) reflects real `BattlescapeState` timer + projectile playback at muted speed — acceptable for certification, not a gameplay defect.
- MC relay completion JSON is leaner than HWP_FIRE; engine TU/ammo are authoritative in harness assertions.

---

## Production code

**No changes** to MC fire execution, `CompanionCommandRuntime` MC inbox, or Battlescape combat in this checkpoint — **harness-only** delta.

---

## Owner review

1. Accept FIX-01 as sufficient for **MC SNAP** terminal certification gate.
2. Authorize follow-on slice for **MC_AUTO_SHOT** / **MC_AIMED_SHOT** terminal cases (same fixture + `advanceUntilTerminal`).
3. Decide whether to enrich MC directed-fire **relay JSON** with HWP-style `projectile_launched` / ammo observability (separate from harness FIX).