# ASTER-M1-MC-03A-CLOSEOUT-02 — Owner acceptance + live-prep gate

**Date:** 2026-11-20  
**Status:** **STOP — owner review** (MC fire harness **accepted**; live promotion **not** authorized here)  
**Prior:** [ASTER-M1-MC-03A-FIRE-02](ASTER-M1-MC-03A-FIRE-02.md) (CLOSEOUT-01 evidence)

---

## Owner direction (recorded)

| Decision | Disposition |
|----------|-------------|
| Mid-AUTO authority loss certification (`certMcAuthorityLossDuringAutoFire`) | **Accepted** — preserve native in-flight auto completion; relay **INTERRUPTED**; no second inbox accept |
| Terrain-wall `MC_SNAP_SHOT` (`certMcTerrainWallSnapFire`) | **Accepted** — stock directed-fire at ruleset wall tile |
| Native firing behavior | **Unchanged** — no production edits in MC-03A closeout |

MC SNAP / AUTO / AIMED happy-path acceptance stands from prior owner decision (FIRE-02).

---

## Certified harness matrix (Release `build-s4j-rc`, 2026-11-20)

| Case | Evidence tag | Terminal / gate |
|------|----------------|-----------------|
| MC_AUTO auth loss | `mc-auto-auth-loss` | **INTERRUPTED**; 1 round before reclaim; ≤3 total; **NOT_AI_CONTROLLED** follow-up |
| MC terrain wall snap | `mc-terrain-wall-snap` | **COMPLETED**; 1 round; stock TU |

**Command:** `companion_mc_hostile_move_relay_terminal_test.exe` → **all tests passed** (incl. walk/move/authority regression).

---

## Live-test preparation

Bounded operator + agent checklist: **[ASTER-M1-MC-03A-LIVE-PREP-01](ASTER-M1-MC-03A-LIVE-PREP-01.md)**.

**Explicitly not authorized in this slice:** runtime pin change, `openxcom.exe` deploy, git commit/push.

---

## HWP rocket relay (out of MC-03A scope)

Separate investigation opened: **[ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01](ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01.md)**.

Root cause **proven** as **harness tick-loop defect** (blast-flash without map draw) + **fixture gap** (turret type not set from fixed weapon). **Not** MC-03A production regression. Verified fix: harness-only pump in `companion_hwp_fire_relay_test.cpp` → full matrix **PASS** (uncommitted).

---

## MC-03A milestone state

| Track | State |
|-------|--------|
| Terminal harness (SNAP/AUTO/AIMED + auth + terrain) | **Accepted** |
| Node bind/validate (`m1-mc-s3a-fire`, `m1-mc-s2b-execution`) | **Pass** |
| Live F6 + promoted binary | **In progress** — SNAP **COMPLETED**; AUTO published; AIMED drafted ([LIVE-CLOSEOUT-01](ASTER-M1-MC-03A-LIVE-CLOSEOUT-01.md)) |
| MC-03A overall | **Closed** — see [LIVE-CLOSEOUT-01](ASTER-M1-MC-03A-LIVE-CLOSEOUT-01.md) |

**STOP for owner review** — authorize live-drill tranche and/or HWP harness commit when ready.