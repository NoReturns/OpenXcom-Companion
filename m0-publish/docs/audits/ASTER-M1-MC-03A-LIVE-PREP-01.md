# ASTER-M1-MC-03A-LIVE-PREP-01 — MC hostile fire live drill preparation

**Date:** 2026-11-20  
**Status:** **Prepared — not live-verified**  
**Gate:** Owner must authorize **promoted `openxcom.exe`** (pin/deploy) before treating live outcomes as certified. No pin change in this document.

**Harness acceptance:** [ASTER-M1-MC-03A-CLOSEOUT-02](ASTER-M1-MC-03A-CLOSEOUT-02.md)

---

## Preconditions

| # | Requirement | Verification |
|---|-------------|--------------|
| 1 | Engine binary includes MC-03A fire execution (`mcFireRelayExecutionSupported`, MC command types in runtime) | Match intended promotion manifest / SHA; **not** updated here |
| 2 | Relay env: `OPENXCOM_COMPANION_SNAPSHOT_PATH` → live export path; `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` for execution drills | [ASTER-LIVE-PLAYBOOK.md](../../docs/ASTER-LIVE-PLAYBOOK.md) |
| 3 | Cooperative session: daemon or `-StartFull` command relay watching `m0/tactical-command.json` | [tactical-command-m1-20b.md](../tactical-command-m1-20b.md) |
| 4 | Mind-controlled hostile present in battle with firearm in hand (export shows `xcomControlledHostileObservationV1` or equivalent) | F6 `m0/state.json` |
| 5 | `companion-soldier-control.json` **v3** includes `mc_hostile_assignments` with target unit id → `"ai"` for drill actor only | Node mirror: `buildSoldierControlMirror` / export conventions |

---

## Mandatory F6 review (before any MC fire command)

Follow project **M1 mandatory battlefield status review** (`AGENTS.md`, `tactical-briefing-ai-workflow.cjs`):

1. `unitStateBrief.exceptions` — MC roster shells are **not** command actors unless listed in `commandBinding.player_soldiers`.
2. Distinguish confirmed panic/MC from heuristic morale/energy.
3. Equipment review: alien weapon + ammo in `tactical.units` hands/inventory for the MC hostile id.
4. Hostile intelligence: only `units[]` + `facing` for current LOS; `perceptionLog` is historical.

**Authority:** Publish MC fire only when:

- Actor id is the mind-controlled hostile listed in binding/export.
- `mc_hostile_assignments[actorId] === "ai"` in control JSON beside snapshot.
- `snapshot_sha256`, `state_version`, `session_id`, `turn` match fresh F6 publish.

---

## Command surface (Node + inbox)

| `command_type` | Compose helper | Live notes |
|----------------|----------------|------------|
| `MC_SNAP_SHOT` | `composeMcSnapShotCommand` | Pistol/rifle; 1 round |
| `MC_AUTO_SHOT` | `composeMcAutoShotCommand` | Rifle (or weapon with auto); stock burst |
| `MC_AIMED_SHOT` | `composeMcAimedShotCommand` | Stock aimed TU |

Fields mirror soldier directed fire: `target`, `active_hand` (`STR_RIGHT_HAND` / `STR_LEFT_HAND`).

**Never** publish `SNAP_SHOT` / `AUTO_SHOT` / `AIMED_SHOT` for MC hostile actor ids — Node rejects (see `tactical-command-m1-mc-s3a-fire.test.cjs`).

**CLI only:** `publish-tactical-command-once.cjs` dry-run → publish (no raw `gh api` PUT).

---

## Live drill sequence (recommended order)

### A. Happy path — SNAP

1. Fresh F6 → export binding.
2. Assign MC hostile to AI in control JSON → publish control if required by local workflow.
3. Dry-run + publish `MC_SNAP_SHOT` at visible hostile or permitted terrain tile (same binding).
4. RETRIEVE in-game.
5. Success: `tactical-result.json` **`COMPLETED`**; ammo/TU delta; battle idle; new F6 reflects spend.

### B. AUTO (optional live confirm)

1. Fresh binding; rifle with auto mode.
2. `MC_AUTO_SHOT` → **COMPLETED**; expect multi-round ammo spend per stock `autoShots`.
3. If authority reclaimed mid-burst (human takes MC hostile): expect **INTERRUPTED**; in-flight rounds may still complete natively; **no** second relay accept (harness-proven).

### C. AIMED

1. `MC_AIMED_SHOT` → **COMPLETED**; single round; aimed TU.

### D. Authority — human reclaim

1. During AI MC snap or auto, reclaim hostile for human in-engine (or set control human + reclaim API path used in harness).
2. Expect **INTERRUPTED** or terminal consistent with walk MC auth-loss; subsequent MC fire → **REJECTED** `NOT_AI_CONTROLLED`.

### E. Terrain / wall (optional)

1. Snap at visible map tile / wall where in-game directed fire is allowed (stock semantics — no companion terrain API).
2. Compare to harness `certMcTerrainWallSnapFire` expectations (1 round, **COMPLETED**).

---

## Failure triage (live)

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `UNSUPPORTED_COMMAND_TYPE` | Old binary or executor off | Confirm binary + `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` |
| `NOT_AI_CONTROLLED` | Human-owned MC hostile | Fix `mc_hostile_assignments` / reclaim state |
| `STALE_*` / binding mismatch | F6 newer than command | New F6 + new `command_id` |
| `NO_LINE_OF_FIRE` | Preflight blocked | Replan target; refresh F6 |
| Stale `EXECUTING` | Prior command unresolved | Read `tactical-result.json`; refresh binding |

---

## Regression references (pre-live)

| Suite | Expected |
|-------|----------|
| `companion_mc_hostile_move_relay_terminal_test.exe` | Pass |
| `companion_tactical_mc_hostile_authority_test.exe` | Pass |
| Node `tactical-command-m1-mc-s3a-fire.test.cjs` + `m1-mc-s2b-execution.test.cjs` | Pass |

HWP rocket relay: separate [ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01](ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01.md) — does not gate MC live fire.

---

## Sign-off blockers (owner)

- [ ] Promoted runtime binary authorized (SHA recorded).
- [ ] At least one live **`MC_SNAP_SHOT` COMPLETED** on mission map.
- [ ] Optional: AUTO / AIMED / auth-loss spot-check.
- [ ] MC-03A milestone closure vs. further tranches (grenades, reload, etc. — out of MC-03A scope).

**STOP until live drill authorized and binary promoted.**