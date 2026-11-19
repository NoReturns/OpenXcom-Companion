# ASTER-M1-HWP-S3B-03A — HWP_MOVE terminal walk certification

**Scope:** Prove production relay async walk lifecycle for `HWP_MOVE` through **terminal** states using real `BattlescapeState`, native `UnitWalkBState`, and relay file inbox. **No runtime deployment, commit, or push.**

**Engine head (harness):** `1.0.eb309eb40-dirty` (local `build-s4j-rc`)  
**Data:** `E:/Open X-Com Companion/runtime/m0/bin` (xcom1)  
**Harness:** `engine/OpenXcom/src/test/companion_hwp_move_relay_terminal_test.cpp`  
**Evidence capture:** `local/hwp-terminal-stderr.txt` (2026-11-19)

## Summary verdict

| Step | Result |
|------|--------|
| 1 — Bounded real walk | **PASS** (accept → `EXECUTING` → `COMPLETED`; engine ↔ relay position/TU match) |
| 2 — Interrupted movement | **PASS** (`INTERRUPTED`; partial position/TU; `destination_reached: false`) |
| 3 — Capability and authority | **PASS** (engine harness + Node binding tests) |
| 4 — Relay hygiene | **PASS** (single terminal publication; next command accepts; soldier `MOVE` regression) |

**Production defects confirmed in this run:** none.  
**Harness defects found and corrected during certification** (not engine relay bugs): see [Harness notes](#harness-notes).

## Test matrix (Release `build-s4j-rc/bin/Release`, 2026-11-19)

| Target | Result |
|--------|--------|
| `companion_hwp_move_relay_terminal_test` | **PASS** (this certification) |
| `companion_hwp_move_relay_test` | PASS |
| `companion_tactical_hwp_authority_test` | PASS |
| `companion_tactical_hwp_move_execution_test` | PASS |
| `tactical-command-m1-hwp-s3b-movement.test.cjs` | **8/8 PASS** |

---

## Step 1 — Bounded real walk

**Setup:** AI-owned 2×2 `STR_TANK_CANNON` / `TANK_ARMOR` at (1,1,0), `HWP_MOVE` to (3,1,0), 80 TU. `BattlescapeState::init()` + `BattlescapeGame::handleState()` until relay terminal.

| Check | Observation |
|-------|-------------|
| Command accepted | `Companion command: accepted HWP_MOVE command_id=cert-ter...` |
| `EXECUTING` before terminal | Relay polled `EXECUTING` while `game->isBusy()`; no premature `COMPLETED` on early ticks |
| Native movement | 7 `handleState` steps; unit reached destination |
| Terminal once | `Companion command: terminal ... status=COMPLETED` |
| Position / TU | Relay `final_position` (3,1,0), `remaining_tu` 72 — matches engine |

**Relay terminal result (`cert-terminal-walk`):**

```json
{
  "schema_version": 1,
  "command_id": "cert-terminal-walk",
  "command_type": "HWP_MOVE",
  "status": "COMPLETED",
  "session_id": "dfccbe2190b302df9c9844d3e0aa19ab",
  "turn": 1,
  "actor_unit_id": 1000000,
  "starting_position": { "x": 1, "y": 1, "z": 0 },
  "final_position": { "x": 3, "y": 1, "z": 0 },
  "remaining_tu": 72,
  "kneeled": false,
  "destination_reached": true,
  "snapshot_sha256": "7173ec8b6e5dec8c2014e8d7f02ca0e35c76c6c961ca9c5825fba2526c75ca3e",
  "inbox_sha256": "eb6a1767df9ad609bb793be1fc82fe7f702956fb11f908a2894507ea8926090f",
  "completed_at": "engine-local"
}
```

**Engine-observed final state:** `pos=3,1 tu=72 dir=2` (facing not echoed in relay JSON; TU spend 8 vs start 80).

---

## Step 2 — Interrupted movement

**Setup:** Long move toward (9,1,0); partial `handleState` until `x ≥ 4`; `BattlescapeGame::cancelCurrentAction()`; advance relay + battle until terminal.

| Check | Observation |
|-------|-------------|
| No false arrival | Engine (4,1,0) ≠ destination; `destination_reached: false` |
| Actual stop / TU | Relay `final_position` (4,1,0), `remaining_tu` 68 — matches engine |
| Terminal class | `status: "INTERRUPTED"` (same family as soldier `MOVE`) |
| Stop reason | `movement_stop_reason: "movement_incomplete"`; no invented bespoke HWP interrupt code |
| Public reason | Uses existing engine wording: *"Movement interrupted before destination (cause not recorded by engine)."* |

**Relay terminal result (`cert-interrupt`):**

```json
{
  "schema_version": 1,
  "command_id": "cert-interrupt",
  "command_type": "HWP_MOVE",
  "status": "INTERRUPTED",
  "session_id": "c7ddf9ef017eb9bcd8f6b1c4b92bf5df",
  "turn": 1,
  "actor_unit_id": 1000000,
  "public_reason": "Movement interrupted before destination (cause not recorded by engine).",
  "starting_position": { "x": 1, "y": 1, "z": 0 },
  "final_position": { "x": 4, "y": 1, "z": 0 },
  "remaining_tu": 68,
  "kneeled": false,
  "destination_reached": false,
  "snapshot_sha256": "dce845e11c926163f0d14c94021068810bd4d74b491eaa30290db257ae4e1045",
  "inbox_sha256": "a19d13783d385de504fc5fe51c061bf13d16e7889c05b5509081291aaa066c3b",
  "movement_stop_reason": "movement_incomplete",
  "completed_at": "engine-local"
}
```

**Engine-observed:** `pos=4,1 tu=68`.

---

## Step 3 — Capability and authority

| Case | Relay log / test |
|------|------------------|
| `hwpMoveExecutionSupported=true` enables `HWP_MOVE` only | Node: `tactical-command-m1-hwp-s3b-movement.test.cjs` 8/8; binding rejects other HWP types when global `commandExecutionSupported` false |
| Human-owned HWP | `cert-human` → `reject_code=NOT_AI_CONTROLLED`; TU unchanged |
| `HWP_FIRE` / `HWP_TURN` | `reject_code=UNSUPPORTED_COMMAND_TYPE` |
| Stale binding | `cert-stale` → `reject_code=STALE_SNAPSHOT` (after valid walk + fresh snapshot for other cases) |
| Duplicate command | After `cert-dup` `COMPLETED`, republish same inbox: position/TU frozen; result JSON unchanged |
| Soldier `MOVE` | `cert-soldier-move` → accept → `COMPLETED` at (3,2,0) (regression) |

Rejected commands did not queue walks (no `MOVE started` on reject paths above).

---

## Step 4 — Relay hygiene

| Check | Observation |
|-------|-------------|
| `ActiveCommand` cleared | After `cert-terminal-walk` / interrupt terminals, `!CompanionCommandRuntime::isMoveInFlight()` |
| Single terminal publication | Extra relay polls after terminal did not rewrite `tactical-result.json` |
| Next command | After `cert-hygiene-1` `COMPLETED`, fresh snapshot export → `cert-hygiene-2` **accepted** (`EXECUTING` at evidence snapshot) |
| No orphaned walk state | `endWalkCase()` + harness `abandonInFlightCommandForTestHarness()` between scenarios; soldier walk completes cleanly |

---

## Harness notes

Issues were **test harness only** (fixed in `companion_hwp_move_relay_terminal_test.cpp` for this WP):

1. **`Map::cacheUnit` on fixture armor without sprite sheets** — AV when using custom YAML armor under full `BattlescapeState`. **Mitigation:** use stock `TANK_ARMOR` (2×2) from loaded xcom1 rules; do not call `cacheUnit` in harness wire-up.
2. **AI assignment before unit spawn** — `NOT_AI_CONTROLLED` until `addTank` precedes `writeControl(true, ...)`.
3. **Interrupt timing** — cancel only after partial `handleState` advancement; relay completion requires `advanceUntilTerminal(true)` post-cancel.
4. **Assertion hygiene** — terminal JSON uses boolean `destination_reached: true`; harness checks JSON text, not string `"true"`.

---

## Observations (not defects)

- **Facing:** Engine `dir=2` after completed walk; relay terminal payload has no `final_direction` (unchanged from S3B-03 relay schema).
- **Hygiene second command:** Evidence line captured `EXECUTING` for `cert-hygiene-2` before harness teardown; first hygiene command already published one `COMPLETED` terminal.

---

## Owner review — STOP

Certification harness is green on pinned dirty engine tree. **No runtime deployment** in this WP. Await owner acceptance before merge/deploy pin.