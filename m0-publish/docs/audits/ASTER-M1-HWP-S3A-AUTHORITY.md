# ASTER-M1-HWP-S3A — HWP remote command authority (engine foundation)

**Status:** Implementation complete (local only — no commit, push, or runtime deploy)  
**Bases:** Engine `e24a741da…`, Companion `7885b682b…` (Companion unchanged in S3A)  
**Scope:** Engine-side **actor + binding authority** for future remote HWP commands. **No** HWP MOVE/FIRE/TURN execution.

---

## Step 1 — Existing soldier authority (unchanged)

| Component | Role | HWP relevance |
|-----------|------|----------------|
| `CompanionTacticalAuthorityCore` | Roster soldier AI vs human; relay `assignments` | **`isLivePlayerSoldier` gate** — HWPs never enter this path |
| `CompanionCommandRuntime::tacticalAuthorityForActor` | Soldier inbox commands | **`isCompanionMoveActor` → `isLiveCampaignPlayerSoldierUnit`** only |
| `CompanionTacticalHumanOrderAdmission` | Blocks human orders for AI soldiers | HWP policy **out of scope** (separate admission later) |
| `CompanionCommandCore::validateTacticalCommandBinding` | Snapshot/session/turn/state_version + **alive roster soldier** | Soldier-only; HWP uses parallel validator |
| S2A `isAiControlledHwpUnit` / `hwp_assignments` | Relay mirror | Consumed by new HWP authority |
| S2A `_companionTacticalAiHwpIds` | Battle-scoped Aster HWPs | Required **in addition** to relay |

**Preserved:** All soldier code paths and rejection semantics unchanged. HWP id band alone never grants authority.

---

## Step 2 — HWP authority call path

### API (`CompanionTacticalHwpAuthorityCore`)

| Symbol | Purpose |
|--------|---------|
| `hwpTacticalCommandExecutionSupported()` | Always **`false`** (S3A execution lock) |
| `isOperationalFriendlyHwpForRemoteCommands(unit)` | Genuine live player HWP (not roster, not `isOut()`, factions player) |
| `evaluateHwpRemoteCommandAuthority(input)` | Full remote-actor permit (no command type execution) |
| `validateHwpTacticalCommandExecutionPreflight(input)` | Authority + **`HWP_EXECUTION_NOT_SUPPORTED`** |

### `HwpRemoteAuthorityInput` checks (order)

1. Campaign + battle present; battle initialized; player turn; not falling; not battle busy  
2. Actor exists on `SavedBattleGame::getUnits()`  
3. **Not** `isLiveCampaignPlayerSoldierUnit` (blocks soldier-ID masquerade)  
4. Player HWP identity (original faction, no geoscape soldier, id ≥ `MAX_SOLDIER_ID`, operational)  
5. Optional `actorNativeActionInProgress` → `ACTOR_BUSY`  
6. Tactical Aster: `battle->getCompanionTacticalAiHwpIds()`  
7. Relay Aster: `isAiControlledHwpUnit(controlJson, binding, id)` with campaign/tactical/session binding  
8. Optional binding freshness: snapshot SHA, session, turn, `state_version` (same semantics as soldier binding)

### Future executor hook (not wired in S3A)

```
CompanionCommandRuntime (future HWP command type)
  → build HwpRemoteAuthorityInput from inbox + battle/campaign
  → evaluateHwpRemoteCommandAuthority (admit actor)
  → validateHwpTacticalCommandExecutionPreflight (still rejects until execution WP)
  → (future) type-specific validate + BattlescapeGame executor
```

Soldier inbox handlers continue to call `tacticalAuthorityForActor` only.

---

## Step 3 — Execution lock

- Companion binding: `commandExecutionSupported: false` on `player_hwps[]` (S2A, unchanged)  
- Engine: `hwpTacticalCommandExecutionSupported()` → **`false`**  
- No new inbox command types; no `tryExecuteCompanion*` HWP paths

---

## Files changed

| File | Change |
|------|--------|
| `Engine/CompanionTacticalHwpAuthorityCore.h` / `.cpp` | **New** — HWP authority + preflight |
| `src/CMakeLists.txt` | Link core into `openxcom`; `companion_tactical_hwp_authority_test` target |
| `test/companion_tactical_hwp_authority_test.cpp` | **New** — S3A scenarios |
| `test/companion_tactical_hwp_authority_test_main.cpp` | Console entry (SDL full-link pattern) |

---

## Step 4 — Test results (Release, `build-s4j-rc`)

| # | Scenario | Result |
|---|----------|--------|
| 1 | AI-owned operational HWP | PASS |
| 2 | Human-owned HWP | PASS (`NOT_AI_CONTROLLED`) |
| 3 | Destroyed HWP | PASS |
| 4 | Nonexistent HWP | PASS |
| 5 | Hostile unit | PASS |
| 6 | Soldier id as HWP | PASS |
| 7 | Stale session | PASS (`STALE_SESSION`) |
| 8 | Mixed squad independence | PASS (+ `companion_tactical_authority_test` soldier regression) |
| 9 | Soldier commands unchanged | PASS (`companion_tactical_authority_test.exe`) |
| 10 | HWP execution unavailable | PASS (`HWP_EXECUTION_NOT_SUPPORTED`) |

```
companion_tactical_hwp_authority_test.exe → all tests passed.
companion_tactical_authority_test.exe → all tests passed.
```

---

## Remaining blockers for HWP movement

1. **Execution gate** — flip policy only when product authorizes (`hwpTacticalCommandExecutionSupported` + binding `commandExecutionSupported`).  
2. **Runtime wiring** — new inbox branch (e.g. `HWP_MOVE`) calling HWP authority + `validateHwpMoveCommand` (not yet authored).  
3. **Executor** — `BattlescapeGame` HWP pathfinding/move (vehicles differ from soldiers).  
4. **Relay contract** — Node command schema + `command-binding` rows for HWP command types.  
5. **Reaction / weapons** — explicitly out of scope until dedicated WPs.

---

## Proposed smallest HWP MOVE implementation (next WP sketch)

1. Add `parseHwpMoveCommandJson` + `validateHwpMoveCommand` mirroring MOVE but using `HwpRemoteAuthorityInput` / operational HWP checks (no roster fields).  
2. In `CompanionCommandRuntime::tick`, when `inboxCommandType == "HWP_MOVE"` (or shared MOVE with HWP actor discriminator), call `evaluateHwpRemoteCommandAuthority` before any soldier validator.  
3. Guard with `hwpTacticalCommandExecutionSupported()` and env pin until harness green.  
4. Single-engine test: authority passes + **reject at execution lock** until step 3 enabled.  
5. Only then add thin `tryExecuteCompanionHwpMove` delegating to existing vehicle walk constraints.

**STOP** — owner review (no commit/push/deploy).