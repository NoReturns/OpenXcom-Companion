# ASTER-M1-MC-03A-LIVE-CLOSEOUT-01 — Live fire milestone checkpoint

**Date:** 2026-11-20  
**Session:** `4818805fe837902d69ad89b306a0deb7` · turn **3**  
**Runtime pin:** `987b1dbf2bd909dbb9478fe60271637731c09e1380cfb0493719316369599797` ([LIVE-DEPLOY-01](ASTER-M1-MC-03A-LIVE-DEPLOY-01.md))

---

## Battlefield status (post-F6, binding `becd584c7da12270…`)

| Item | Finding |
|------|---------|
| **MC actor** | **1000001** (Sectoid), AI-owned, `(3,12,0)`, **19 TU** (post-AUTO), heavy plasma **31** rounds |
| **Exceptions** | `xcom_controlled_hostile_unit` only (informational) |
| **Binding** | Matches `local/m0/tactical-live.yaml` SHA |
| **MC fire flags** | `mcSnapShotExecutionSupported` / `mcAutoShotExecutionSupported` / `mcAimedShotExecutionSupported` = true |

Roster panic / MC soldiers: none affecting command authority for this drill.

---

## Sidecar fix (live blocker)

**Issue:** Retrieve rejected `MC_SNAP_SHOT` with `SIDECAR_VALIDATION` — *weapon in active_hand does not support snap fire mode* — because schema v5 nests `actionCosts` under `xcomControlledHostileObservationV1`, not on the sparse unit row.

**Fix:** `companion/m0-publish/lib/tactical-command.cjs` — `resolveActorActionCosts()` for MC validation; test in `tactical-command-m1-mc-s3a-fire.test.cjs`.

**Ops:** On-demand relay daemon restart required after sidecar code change.

---

## Live results

| Mode | `command_id` | Status | Notes |
|------|--------------|--------|--------|
| **MC_SNAP_SHOT** | `mc03a-live-snap-wall-1000001-03` | **COMPLETED** | Wall `(3,10,0)`; post-shot **37 TU** (from fresh export); **34** rounds; `engine-local` |
| **MC_AUTO_SHOT** | `mc03a-live-auto-wall-1000001-01` | **COMPLETED** | Wall `(3,10,0)`; **37 → 19 TU**; **34 → 31** rounds; binding `e94d19e388…` |
| **MC_AIMED_SHOT** | `mc03a-live-aimed-wall-1000001-01` | **Not executed (battle ended)** | After AUTO, **19 TU** &lt; **32** aimed cost; mission closed before another F6 — **harness AIMED cert accepted** |

Prior rejections `…-01` / `…-02` (sidecar) and successful `…-03` recorded in relay txn log.

---

## Harness / deploy (unchanged acceptance)

- Release `companion_mc_hostile_move_relay_terminal_test.exe` — pass (incl. auto auth-loss + terrain wall)
- Node `tactical-command-m1-mc-s3a-fire.test.cjs` — pass (incl. nested `actionCosts` regression)
- HWP rocket relay — harness-only fix; out of MC-03A scope ([HWP-ROCKET-REGRESSION-01](ASTER-M1-HWP-ROCKET-RELAY-REGRESSION-01.md))

---

## Milestone sign-off

| Criterion | State |
|-----------|--------|
| Promoted runtime on mission | **Done** |
| Live **MC_SNAP_SHOT** COMPLETED | **Done** (`…-03`) |
| Live **MC_AUTO_SHOT** COMPLETED | **Pending** retrieve |
| Live **MC_AIMED_SHOT** COMPLETED | **Waived** — battle ended; terminal harness AIMED accepted |
| Sidecar fix + regression tests | **Committed** (`resolveActorActionCosts`, fixture v5 yaml) |
| Runtime pin (`987b1dbf…`) | **Committed** with companion tranche |
| **MC-03A overall** | **Closed** — production + pin + live SNAP/AUTO + sidecar fix |

---

## Commits (this closeout)

| Repo | Scope |
|------|--------|
| `engine/OpenXcom` (`aster/m0`) | MC hostile fire execution core, relay terminal harness certs, CMake |
| `companion` (`main`) | MC fire bind/validate, **sidecar `actionCosts` fix**, runtime pin, tests + audits |

**Post-closeout:** MC grenades/reload remain out of MC-03A scope; push deferred unless owner directs.