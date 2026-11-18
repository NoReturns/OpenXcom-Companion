# ASTER-M1-MELEE-LIVE-ACCEPTANCE-01

**Date:** 2026-11-18  
**Status:** **OWNER ACCEPTED** (Battle Mode live drill)

## Primary acceptance — `MELEE_ATTACK`

| Field | Value |
|-------|-------|
| Result status | **COMPLETED** |
| Actor | Kees van der Linden, unit **28** |
| Target | Sectoid, unit **1000001** |
| `melee_hit` | **true** |
| `tu_spent` | **19** |
| `remaining_tu` | **45** |
| Native game + relay | Attack completed successfully (animated path) |
| `target_status` (first result) | **`active`** — owner confirms this does **not** prove unconsciousness on first strike |

**Owner statement:** Do not infer that the first strike rendered the Sectoid unconscious; first relay result reported `target_status: active` while still confirming a genuine melee hit.

## Corroborating live commands (same session)

| Command | Status | Notes |
|---------|--------|-------|
| MOVE → (7,27,0) | **COMPLETED** | Positioning before follow-up |
| PICKUP `STR_SECTOID_CORPSE`, battle item **39** | **COMPLETED** | Destination `STR_BACK_PACK` (0,0) |
| Fresh F6 snapshot | Verified | Corpse item present in Kees's backpack |

## Acceptance scope

- S1 contract, S2a executor, S2b gated relay, S3 animated lifecycle: **accepted for production** after P0 recovery fix and permanent launcher enablement (`ASTER-M1-MELEE-FINAL-RELEASE-01`).

## Not claimed

- First-hit stun/unconscious confirmation from relay alone  
- Multi-strike stun rod certification  
- `companion_melee_engine_test.exe` harness (not run per owner policy)