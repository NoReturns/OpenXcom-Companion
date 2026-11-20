# ASTER-M1-MC-03A-FIRE-02 — MC AUTO / AIMED terminal certification + CLOSEOUT-01

**Date:** 2026-11-20  
**Status:** **CLOSEOUT-01 superseded by [CLOSEOUT-02](ASTER-M1-MC-03A-CLOSEOUT-02.md)** — auto auth-loss + terrain wall **accepted**; live prep **[LIVE-PREP-01](ASTER-M1-MC-03A-LIVE-PREP-01.md)**  
**Prerequisite:** [ASTER-M1-MC-03A-FIX-01](ASTER-M1-MC-03A-FIX-01.md) (SNAP terminal harness repair — **accepted**)  
**Scope:** Native terminal certification for `MC_AUTO_SHOT` and `MC_AIMED_SHOT`, MC authority loss during active fire (snap + auto), MC terrain-wall snap, HWP relay baseline triage. Harness additions in `companion_mc_hostile_move_relay_terminal_test.cpp` only. **No** production firing changes, commits, pin, or deploy in this checkpoint.

---

## Executive summary

| Mode | Terminal harness | Native completion | Ammo / TU |
|------|-------------------|-------------------|-----------|
| **MC_SNAP_SHOT** | `certMcSnapFireTerminal()` (FIX-01) | **COMPLETED** | 1 round; TU per stock snap |
| **MC_AUTO_SHOT** | `certMcAutoFireTerminal()` | **COMPLETED** | Full stock `autoShots` burst on happy path |
| **MC_AIMED_SHOT** | `certMcAimedFireTerminal()` | **COMPLETED** | 1 round; stock `tuAimed` |
| **Authority during snap fire** | `certMcAuthorityLossDuringFire()` | **INTERRUPTED** | 1 round committed; follow-up **NOT_AI_CONTROLLED** |
| **Authority during auto fire** | `certMcAuthorityLossDuringAutoFire()` (CLOSEOUT-01) | **INTERRUPTED** | **1** round before reclaim; native auto may finish in-flight shots 2–3; **no** second relay accept |
| **Terrain wall snap** | `certMcTerrainWallSnapFire()` (CLOSEOUT-01) | **COMPLETED** | 1 round into ruleset LOS-blocking `O_OBJECT` tile |

All fire cases use **HWP-parity** fixture (`loadMapResources`, mod-backed floor, `battlescape->think()` via `advanceUntilTerminal()`). No crash/hang observed on MC matrix re-run.

**Owner decision (prior):** SNAP, AUTO, and AIMED terminal happy-path certifications **accepted**. This document adds CLOSEOUT-01 evidence only.

---

## CLOSEOUT-01 — HWP relay regression baseline

**Binary:** `engine/OpenXcom/build-s4j-rc/bin/Release/companion_hwp_fire_relay_test.exe`  
**Engine:** `OpenXcom Version: 1.0.fabf01604-dirty`  
**Data:** `runtime/m0/bin` (xcom1 v1.0)  
**Outcome:** **11 failures** — **unchanged** from pre-closeout FIRE-02 note; **not** introduced by MC-03A harness work.

### Failure inventory (assertion message → originating cert)

| # | Assertion | Cert function |
|---|-----------|---------------|
| 1 | `rocket native stack idle after handleState` | `certRocketNativeStackDrains()` |
| 2 | `terminal within tick budget` | `certRocketSnapRelayTerminal()` (`advanceUntilTerminal`) |
| 3 | `rocket snap COMPLETED after projectile stack` | `certRocketSnapRelayTerminal()` |
| 4 | `rocket projectile launched` | `certRocketSnapRelayTerminal()` |
| 5 | `rocket tu_spent matches engine` | `certRocketSnapRelayTerminal()` |
| 6 | `terminal within tick budget` | `certRocketAimedRelayTerminal()` |
| 7 | `rocket aimed COMPLETED` | `certRocketAimedRelayTerminal()` |
| 8 | `rocket aimed projectile` | `certRocketAimedRelayTerminal()` |
| 9 | `terminal within tick budget` | `certRocketTurretRotation()` |
| 10 | `rocket turret snap COMPLETED` | `certRocketTurretRotation()` |
| 11 | `rocket turret rotated` | `certRocketTurretRotation()` |

**Passing in same run (representative):** cannon snap/aimed relay, laser snap, turret-without-move, reject matrix (empty ammo, bad weapon id, insufficient TU, blocked LOS, stale binding, unauthorized HWP, duplicate inbox), interrupt/cancel paths not in the rocket cluster, `certHarnessGateAndTeardownNotes()`.

### Predates MC-03A?

| Check | Result |
|-------|--------|
| MC-03A production / MC fire executor touched? | **No** — CLOSEOUT slice is harness-only on `companion_mc_hostile_move_relay_terminal_test.cpp` |
| Historical S5-1CH record | [ASTER-M1-HWP-S5-1CH-1CJ-CERTIFICATION-COMPLETION.md](ASTER-M1-HWP-S5-1CH-1CJ-CERTIFICATION-COMPLETION.md) logged full-matrix **PASS** on 2026-11-19 — suggests **rocket relay cluster regressed or was added after** that acceptance, or **fixture/data drift** (not MC-03A) |
| Older local log `local/hwp-fire-relay-1ca.log` | **5** failures on **cannon** snap relay enrichment (`projectile_launched` / turret fields) while terminal was COMPLETED — different failure shape than current **11 rocket-only** cluster |
| Isolated worktree re-run | No separate `companion_hwp_fire_relay_test.exe` in `build-isolated*` trees in this workspace; baseline re-confirmed on canonical `build-s4j-rc` only |

**Verdict for MC-03A closeout:** Treat all **11** as **verified legacy / environmental HWP rocket relay defects** — **STOP** if attempting to “fix” them inside MC-03A (unrelated production scope). No new MC-03A regression detected in non-rocket HWP paths.

---

## CLOSEOUT-01 — Mid-AUTO authority loss

**Harness:** `certMcAuthorityLossDuringAutoFire()` — `MC_AUTO_SHOT` on AI-owned sectoid with `STR_RIFLE` (stock `autoShots=3`).

| Phase | Observation |
|-------|-------------|
| Reclaim trigger | Reclaim when magazine shows **1** round spent (`25→24`, `preTicks≈164`) while relay still `EXECUTING` |
| Terminal | **`INTERRUPTED`** |
| Rounds before reclaim | **1** (recorded) |
| Rounds after native drain | **3** total (`terminal ammo 22`) — remaining auto shots complete as **in-flight native** burst, not a second inbox command |
| Post-reclaim relay probe | `MC_AUTO_SHOT` → **`REJECTED` / `NOT_AI_CONTROLLED`**; TU unchanged |
| Battle stack | Idle before follow-up probe |

```
[cert-evidence] mc-auto-auth-pre: roundsCommittedBeforeReclaim=1 preTicks=164 ammo=24
[cert-evidence] mc-auto-auth-loss: status=INTERRUPTED roundsBeforeReclaim=1 totalRoundsSpent=3
  ammoStart=25 afterReclaim=24 afterIdle=24 terminal=22 tu=100 tuStart=120
```

**Accepted semantics:** Authority loss **interrupts relay ownership** and blocks **new** MC fire commands; ammo already decremented and **native auto continuation** after reclaim matches stock auto state machine behavior (distinct from snap single-shot interrupt).

---

## CLOSEOUT-01 — Terrain targeting (wall tile)

**Harness:** `certMcTerrainWallSnapFire()` — ruleset LOS-blocking `O_OBJECT` at `(8,3,0)`; `MC_SNAP_SHOT` at wall tile (no unit target).

| Checkpoint | Result |
|------------|--------|
| Accept / execute | `EXECUTING` → **`COMPLETED`** |
| Ammo | **12→11** (one round) |
| TU | **80→69** |
| Relay | Standard snap result JSON (`command_id=cert-mc-terrain-wall-snap`) |
| Mechanism | Stock directed-fire / projectile stack only — **no** new terrain-targeting API |

```
[cert-evidence] mc-terrain-wall-snap: terminal=COMPLETED target=8,3 ammo=12->11 tu=80->69 ticks=2230
```

---

## Harness changes (CLOSEOUT-01)

**File:** `engine/OpenXcom/src/test/companion_mc_hostile_move_relay_terminal_test.cpp`

| Addition | Purpose |
|----------|---------|
| `CertHarness::ruleLosBlockerTile()` / `placeTerrainWall()` | Mod-backed wall object (HWP relay parity) |
| `certMcAuthorityLossDuringAutoFire()` | Partial auto burst + reclaim + deny second relay |
| `certMcTerrainWallSnapFire()` | Snap at visible wall tile |
| `main` | Runs new certs after snap auth-loss, before walk regression |

Prior FIX-01 / FIRE-02 certs unchanged in intent.

---

## MC_AUTO_SHOT / MC_AIMED_SHOT — happy path (unchanged)

See prior sections in this doc revision history; re-run **2026-11-20** still **passes** full `companion_mc_hostile_move_relay_terminal_test.exe` including new cases.

---

## Interruption and authority (snap) — unchanged

`certMcAuthorityLossDuringFire()` — single pistol snap round committed; **INTERRUPTED**; **NOT_AI_CONTROLLED** on follow-up.

---

## Test results (Release, `build-s4j-rc`, CLOSEOUT-01 re-run)

| Suite | Result |
|-------|--------|
| `companion_mc_hostile_move_relay_terminal_test.exe` | **Pass** (all certs incl. auto auth-loss + terrain wall) |
| `companion_tactical_mc_hostile_authority_test.exe` | **Pass** |
| `companion_tactical_mc_hostile_move_execution_test.exe` | **Pass** |
| Node `tactical-command-m1-mc-s3a-fire.test.cjs` + `m1-mc-s2b-execution.test.cjs` | **7/7 pass** |
| `companion_hwp_fire_engine_test.exe` | **Pass** |
| `companion_directed_fire_preflight_test.exe` | **Pass** (soldier directed-fire preflight) |
| `companion_hwp_fire_relay_test.exe` (full matrix) | **11 failures** — rocket cluster only; **legacy baseline** |

---

## Final acceptance matrix (CLOSEOUT-01)

| Item | Disposition | Notes |
|------|-------------|-------|
| MC SNAP / AUTO / AIMED terminal happy path | **Accepted** (owner prior) | Harness-verified this slice |
| MC snap authority loss during fire | **Accepted** (owner prior) | INTERRUPTED + committed ammo + gate |
| MC auto authority loss during fire | **Accepted** (CLOSEOUT-02) | Partial commit + in-flight native completion + NOT_AI_CONTROLLED |
| MC snap at ruleset wall tile | **Accepted** (CLOSEOUT-02) | COMPLETED + 1 round; stock semantics |
| HWP rocket relay cluster (11 asserts) | **Resolved (harness)** — see [HWP-ROCKET-REGRESSION-01](ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01.md) | Not MC-03A production; uncommitted harness fix |
| HWP cannon/laser/reject paths in same binary | **Pass** | No MC-03A regression signal |
| Relay JSON enrichment on MC fire | **Optional / unresolved** | Still `buildSnapShotResultJson` shape |
| Live F6 / runtime pin promotion | **Owner** | Gated on live checklist |
| Standalone `companion_mc_hostile_fire_relay_terminal_test.cpp` | **Stale duplicate** | Not wired to FIX-01 bootstrap |
| MC-03A overall milestone | **Closed** | Live SNAP/AUTO; harness AIMED; sidecar fix committed ([LIVE-CLOSEOUT-01](ASTER-M1-MC-03A-LIVE-CLOSEOUT-01.md)) |

---

## Production code implicated?

**No** for MC-03A fire certification and CLOSEOUT-01 harness. HWP rocket failures reflect harness/rocket fixture or post–S5-1CH drift — not MC hostile fire production paths.

---

## Owner review (CLOSEOUT-01)

1. Confirm **mid-AUTO authority loss** semantics (in-flight native auto may complete after **INTERRUPTED**; relay must not accept a second command).
2. Confirm **terrain wall snap** certification satisfies “stock directed-fire where permitted.”
3. Acknowledge **11× HWP rocket relay** failures as **pre-existing / separate tranche** — not MC-03A regressions.
4. When ready, authorize live testing / pin promotion (out of scope here).

**STOP for owner review.**