# ASTER-M1-MC-03A-CRASH-01 — Native MC SNAP terminal crash isolation

**Date:** 2026-11-20  
**Status:** **STOP — owner review** (diagnosis complete; terminal SNAP cert still blocked)  
**Build:** `engine/OpenXcom/build-s4j-rc` Release / RelWithDebInfo, `companion_mc_hostile_move_relay_terminal_test.exe`  
**Constraint honored:** No production firing changes, no deploy/pin, no commits in this checkpoint.

## Executive summary

The `certMcSnapFireTerminal()` process abort (`NTSTATUS 0xC0000409` / exit `-1073741787`, and in some runs `0xC0000005` / `-1073741819`) occurs on the **first** `BattlescapeGame::handleState()` tick after a successful directed-fire accept. The failure is **not** caused by MC-specific command parsing, authority, or a separate alien combat path — bare `tryExecuteCompanionDirectedFire()` on the MC harness crashes the same way without the relay.

**Primary root cause (confirmed):** MC terminal harness map wiring uses synthetic `certFloorTile()` / `mc_relay_terminal_floor` tiles with **no loaded `SurfaceSet`**. When the native battle stack advances into projectile execution, `Map::draw()` → `Map::drawTerrain()` → `Tile::getSprite(O_FLOOR)` dereferences a null `MapDataSet::getSurfaceset()` (same defect class as [ASTER-M1-HWP-S5-1CH](ASTER-M1-HWP-S5-1CH-1CJ-CERTIFICATION-COMPLETION.md)).

**Harness parity gap (confirmed):** `companion_mc_hostile_move_relay_terminal_test` `setupBattle()` does **not** match the certified HWP relay pattern (`loadMapResources(game->getMod())`, mod-backed `renderableFloorTile()` / `wireFloor(battle, mod, …)`, `initUtilities` on the live ruleset). MC **walk** certification can pass without a full terrain redraw; **directed fire** cannot.

**Production MC-03A fire code:** **Not implicated** as the defect source. Accept + `EXECUTING` + native `UnitTurnBState` / `ProjectileFlyBState` queueing behave correctly up to the first animation draw.

---

## Exact reproduction

### A. Default (blocked) SNAP cert

1. Build:  
   `MSBuild engine/OpenXcom/build-s4j-rc/src/companion_mc_hostile_move_relay_terminal_test.vcxproj /p:Configuration=Release`
2. Data: `runtime/m0/bin` (standard xcom1).
3. Enable SNAP cert in harness `main` **or** run diagnostic relay mode (see below).
4. Observe: relay reaches `EXECUTING` with `command_type: MC_SNAP_SHOT`, then hard abort on first `handleState()`.

### B. Diagnostic modes (harness only, no assertion weakening)

Set `OPENXCOM_MC_FIRE_CRASH_DIAG` before launching the exe:

| Value | Behavior |
|--------|-----------|
| `relay` | `certMcSnapFireTerminal()` only (default broken floor) |
| `bare` | `tryExecuteCompanionDirectedFire()` only (no relay) |
| `bare-renderable` | Bare fire after `wireRenderableFloor()` (mod URBAN floor) |
| `verifyfloor` | Relay SNAP cert on renderable floor (skip inner `setupBattle`) |
| `1` | Bare + relay sequence (historical) |

Example (PowerShell):

```powershell
$env:OPENXCOM_MC_FIRE_CRASH_DIAG = "relay"
& engine/OpenXcom/build-s4j-rc/bin/Release/companion_mc_hostile_move_relay_terminal_test.exe
```

**Clear the env var** after diagnostics — a leftover value changes `main` behavior.

---

## Exception details

| Observation | Value |
|---------------|--------|
| Primary exit code | **`-1073741787`** → `0xC0000409` (`STATUS_STACK_BUFFER_OVERRUN` / fast-fail) |
| Alternate exit code | **`-1073741819`** → `0xC0000005` (`STATUS_ACCESS_VIOLATION`) |
| SEH wrap of `handleState()` | Often **does not catch** fast-fail; process terminates (expected for `/GS` + null deref chains) |
| First-chance native PDB stack | **Not captured** in this environment (Windows Debugger / `cdb` not installed). Inferred stack below from code path + S5-1CH precedent. |

### Inferred call stack (first failing draw path)

Same as documented HWP cancel/redraw fault chain:

1. `BattlescapeGame::handleState()` → `BattleState::think()` (`UnitTurnBState` and/or `ProjectileFlyBState`)
2. End of `handleState`: `Map::invalidate()` → eventually `Map::draw()` when redraw required (projectile FOV / selected unit visibility)
3. `Map::draw()` → `Map::drawTerrain()`
4. `Tile::getSprite(O_FLOOR)` → `MapData::getDataset()->getSurfaceset()->getFrame(...)` with **`getSurfaceset() == nullptr`**

Faulting source operation:

```673:674:engine/OpenXcom/src/Savegame/Tile.cpp
	return _objects[part]->getDataset()->getSurfaceset()->getFrame(_objects[part]->getSprite(_currentFrame[part]));
```

### Active Battlescape state at failure

| Field | At crash (relay diagnostic) |
|--------|------------------------------|
| Relay `status` | `EXECUTING` (`MC_SNAP_SHOT`) |
| Native stack | Busy after accept (`UnitTurnBState` front, `ProjectileFlyBState` queued) — same as soldier `tryExecuteCompanionDirectedFire` |
| Last completed engine op | Inbox accept + `SNAP_SHOT started` / `tryExecuteCompanionDirectedFire=true` |
| First failing op | First `BattlescapeGame::handleState()` advancing turn/projectile animation with map redraw |

---

## Evidence log (2026-11-20, local)

### Floor audit (default harness)

```
[cert-evidence] floor-audit: pos=4,4 floorMapData=yes renderableSurfaceset=no dataset=mc_relay_terminal_floor surfaceset=no
```

### Relay accept (then abort)

```
[INFO] Companion command: accepted MC fire ... type=MC_SNAP_SHOT
[INFO] Companion command: SNAP_SHOT started ...
[cert-evidence] mc-snap-fire-executing: { "status": "EXECUTING", "command_type": "MC_SNAP_SHOT", ... }
```

Process exit: `0xC0000409` without `COMPLETED` or ammo/TU terminal checks.

### Bare directed fire (no relay)

```
[cert-evidence] crash-diag: tryExecuteCompanionDirectedFire=true
```

Same abort on first `handleState()` — **MC command types and relay runtime not required to reproduce**.

### Renderable-floor diagnostic (partial mitigation, still aborts)

```
[cert-evidence] wireFloor-renderable: dataset=URBAN surfaceset=yes
[cert-evidence] floor-audit: pos=4,4 ... renderableSurfaceset=yes dataset=URBAN surfaceset=yes
```

Relay still reaches `EXECUTING` then aborts (`0xC0000005` in this run). **Floor-only rewiring is insufficient** without full HWP-style battle bootstrap (`loadMapResources` before floor wire, live `Mod` utilities, etc.).

### Regression harness (SNAP disabled in `main`)

With `OPENXCOM_MC_FIRE_CRASH_DIAG` unset:

```
companion_mc_hostile_move_relay_terminal_test: all tests passed.
```

(`certMcSnapFireTerminal()` remains commented out in `main`.)

---

## Comparison: MC vs soldier/HWP paths

| Aspect | MC terminal harness | HWP fire relay harness (certified) |
|--------|----------------------|-------------------------------------|
| Fire entry | `tryExecuteCompanionDirectedFire` (MC inbox → same API) | Same API (`HWP_FIRE` inbox) |
| Authority | MC-02B (`player_mc_hostiles`, AI assignment) | HWP AI assignment |
| Map floor | `certFloorTile()` synthetic, **no SurfaceSet** | `renderableFloorTile(mod)` + assert |
| `loadMapResources` | **Not called** | Called before `wireFloor` |
| `initUtilities` | `&fixtureMod` | `game->getMod()` |
| MC_MOVE / turn cert | Passes (no full terrain bullet draw) | N/A |

Soldier roster `SNAP_SHOT` relay certification uses different harnesses; MC hostiles correctly reuse stock directed-fire state machine — the gap is **fixture**, not MC fire semantics.

---

## Production code implicated?

| Layer | Implicated? | Notes |
|-------|-------------|--------|
| `CompanionTacticalMcHostileFireExecutionCore` / MC inbox | **No** | Accept + queue through stock `tryExecuteCompanionDirectedFire` |
| `BattlescapeGame::tryExecuteCompanionDirectedFire` | **No** | Same path as HWP/soldier |
| `ProjectileFlyBState` / `UnitTurnBState` | **No** | Expected behavior; crash on **draw**, not on preflight |
| `Tile::getSprite` / harness map data | **Harness defect** | Null `SurfaceSet` on synthetic floor |
| `companion_mc_hostile_fire_relay_terminal_test` (standalone) | **Harness duplicate** | Same synthetic floor; aborts during rules/init in this tree — treat as same fixture class |

---

## Recommended minimal correction (harness only — not applied here)

Align `companion_mc_hostile_move_relay_terminal_test` `setupBattle()` with `companion_hwp_fire_relay_test.cpp` (S5-1CI):

1. `Mod *rules = game->getMod();`
2. `battle->initUtilities(rules);`
3. `battle->loadMapResources(rules);` **before** wiring floor tiles.
4. Replace `wireFloor(battle, w, h)` / `certFloorTile()` with `wireFloor(battle, rules, w, h)` using `renderableFloorTile(rules)` + `mapDataHasRenderableSurfaces` assert.
5. Re-enable `certMcSnapFireTerminal()` in `main` only after terminal `COMPLETED` + TU/ammo assertions pass.

Optional: share the HWP floor helpers via a small test-only header to avoid a third copy.

**Do not** weaken terminal assertions or accept queued-projectile-only evidence for MC-03A certification.

---

## Existing test results and remaining blockers

| Suite | Result |
|-------|--------|
| Node `tactical-command-m1-mc-s3a-fire.test.cjs` | **Pass** (unchanged) |
| `companion_tactical_mc_hostile_authority_test` | **Pass** |
| `companion_mc_hostile_move_relay_terminal_test` (SNAP disabled) | **Pass** |
| `certMcSnapFireTerminal` terminal `COMPLETED` | **BLOCKED** — process abort |
| `companion_mc_hostile_fire_relay_terminal_test` standalone | **BLOCKED** — fixture/init abort (same floor class) |
| Native PDB first-chance stack | **Gap** — install SDK debugger or run under VS for symbolicated stack capture |

---

## Harness diagnostic additions (this checkpoint)

`companion_mc_hostile_move_relay_terminal_test.cpp` — diagnostics only:

- `logHarnessFloorAudit`, `OPENXCOM_MC_FIRE_CRASH_DIAG` modes, SEH-wrapped `handleState` logging, optional `wireRenderableFloor` / HWP-parity helpers for confirmation runs.

No production gameplay or MC firing logic changes.

---

## Owner decisions requested

1. Accept harness-only fix scope (HWP parity floor bootstrap) before re-enabling SNAP terminal cert in CI.
2. Whether to pursue symbolicated local stack capture for audit completeness or treat S5-1CH-class floor diagnosis as sufficient for MC-03A.
3. Keep MC-03A implementation provisionally accepted with terminal firing certification **blocked** until harness fix lands and SNAP/AUTO/AIMED terminal cases pass unchanged assertions.