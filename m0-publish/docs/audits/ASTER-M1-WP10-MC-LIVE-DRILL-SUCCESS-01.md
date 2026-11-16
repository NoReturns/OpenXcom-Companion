# ASTER-M1-WP10-MC-LIVE-DRILL-SUCCESS-01 — live PSI_MIND_CONTROL certified

**Date:** 2026-11-16 (UTC)  
**Runtime pin:** `1f75c565e2f59f0909e4a79aa12ec54937a8585ff275fd59eb95aea4c322dad7` (S4K promote)

## Verdict

| Item | Result |
|------|--------|
| Live `PSI_MIND_CONTROL` terminal | **COMPLETED** |
| Publish path | `publish-tactical-command-once.cjs` (compose → dry-run → publish) |
| Attempts (local journal `wp10-mc-*`) | **25** journaled IDs (~**26** operator attempts including final) |
| Adjacent medikit / HUD harness | **Out of scope** (unchanged) |

## Successful command (canonical)

Source: GitHub `NoReturns/OpenXcom-Aster-Relay` `m0/tactical-result.json` (main) — matches local `local/m0/tactical-result.json`.

| Field | Value |
|-------|--------|
| `command_id` | `wp10-mc-newbattle-t2-soon-sectoid1000003-01` |
| `command_type` | `PSI_MIND_CONTROL` |
| `status` | `COMPLETED` |
| `session_id` | `98af7b5fc371e989bd3b5fc204f90d30` |
| `turn` | 2 |
| `actor_unit_id` | **14** (Soon Ju) |
| `target_unit_id` | **1000003** (Sectoid) |
| `psi_amp_battle_item_id` | **16** |
| `active_hand` | `STR_LEFT_HAND` |
| `tu_spent` | **25** |
| `remaining_tu` | 40 |
| `snapshot_sha256` | `df8f4492cbc20e45085821e6b5322b2dc6bfcd24271d5ebb62e8a533b229abaf` |

**Note:** Earlier same-session attempts targeted Floater **1000000** with Seppe/Alberto/Jolienne (turns 2–4) per journal; success occurred on a **new battle** snapshot with visible Sectoid **1000003**.

## Post-command snapshot (F6 export)

`m0/state.json` at `published_at` **2026-11-16T00:23:39.522Z**:

- Actor **Soon Ju** (#14): `faction` player (0), `psiSkill` 39.
- Target **1000003** not present in `tactical.units[]` at export (unit absent from engine-visible roster list — verify in-client if MC hostiles drop from export when converted or killed; terminal still **COMPLETED** with TU accounting).

## Operator checklist (closed)

- [x] Fresh binding + visible hostile at publish time
- [x] AI-owned actor with psi amp in bound hand
- [x] Single inbox publish via tested CLI
- [x] No inbox overwrite / no stray commands on success path

## Scope limits (unchanged)

- **Adjacent mission-terrain medikit HEAL** — not certified.
- **`companion_manual_upload_hud_test` link failure** — unrelated; not repaired.

**WP10 mind control:** live drill **passed** on promoted RC. Panic previously proven in-game.