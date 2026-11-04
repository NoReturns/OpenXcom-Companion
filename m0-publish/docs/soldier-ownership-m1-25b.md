# Soldier ownership (M1-25B)

## Authoritative sources (battlescape)

| Source | Scope | Role |
|--------|--------|------|
| **`SavedBattleGame` YAML** `companion.tactical_battle_id` + `companion.assignments` | One tactical battle instance | **Canonical during battlescape** — survives tactical save/load and game restart |
| **`SavedGame` YAML** `companion.assignments` + `companion.campaign_id` | Campaign / geoscape | Seeds **new** battles; basescape assign/reclaim UI; persists after geoscape save |
| **`companion-soldier-control.json`** beside `OPENXCOM_COMPANION_SNAPSHOT_PATH` | Relay mirror | **Published by the engine** (F6 snapshot and battlescape init when snapshot path is set). Sidecar/relay reads it; manual edits do not change in-memory ownership |

`session_id` in the control JSON remains for **command binding** (freshness). **Ownership** for durable battles uses `campaign_id` + `tactical_battle_id` when present; legacy files without those fields still use `session_id` matching.

## Failed KNEEL (`HUMAN_OVERRIDE`) — traced cause

Engine path: `validateTacticalCommandBinding` → `humanOverrideRevoked` → `isStaleRelayAiAfterCampaignHumanAssignment` when **tactical/campaign authority is HUMAN** but **relay JSON still lists `"ai"`** for the actor with a matching binding.

That is **not** triggered by soldier selection, unit cycling, or save/load alone. It indicates **divergence**: in-memory ownership was human while `companion-soldier-control.json` still authorized AI (stale publish or hand-edited JSON without matching tactical state). Local geoscape saves under `local/m0/user` had **no** `companion:` block at inspection time, so campaign assignments were empty while JSON could still show AI.

## Explicit reclaim

Only **Soldier Info → companion assign/reclaim** (and matching campaign APIs) change ownership. Selection, inspection, and save/load do not reclaim.

## Evidence

Historical `tactical-result.json`, journals, and quarantined inbox files are never deleted by this model; quarantine only moves active inbox aside.
