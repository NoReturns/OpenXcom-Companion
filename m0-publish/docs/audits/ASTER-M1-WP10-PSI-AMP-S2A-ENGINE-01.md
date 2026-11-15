# ASTER-M1-WP10-PSI-AMP-S2A-ENGINE-01

**Status:** S2a complete (engine + snapshot export + focused tests). **Await owner review.** No commit/push, no relay dispatch, no `PSI_MIND_CONTROL`.

## Summary

Engine-side `PSI_PANIC` execution mirrors the WP9 medikit pattern: `BattlescapeGame::tryExecuteCompanionPsiPanic` → `CompanionPsiExecutionCore::executePanic` → `PsiAttackBState::companionExecutePanic` (native `psiAttack()`, single TU spend). Snapshot exports friendly roster `psiSkill` and hand `actionCosts` entry `id: "panic"` (authoritative `getActionTUs(BA_PANIC, weapon)`; flat 25 TU from ruleset in tests). Hostile psychic stats are not exported.

## Changed files

| Area | Files |
|------|--------|
| Executor | `engine/OpenXcom/src/Engine/CompanionPsiExecutionCore.{h,cpp}`, `engine/OpenXcom/src/Battlescape/BattlescapeGame.{h,cpp}`, `engine/OpenXcom/src/Battlescape/PsiAttackBState.{h,cpp}` |
| Snapshot | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` |
| Build | `engine/OpenXcom/src/CMakeLists.txt` |
| Tests | `engine/OpenXcom/src/test/companion_psi_panic_engine_test.cpp`, `engine/OpenXcom/src/test/companion_snapshot_serialization_test.cpp` |
| Relay schema | `companion/m0-publish/lib/tactical-publish.cjs`, `companion/m0-publish/test/tactical-command-m1-wp10-psi-panic-s1.test.cjs` |
| Headless safety | `PsiAttackBState::psiAttack` — UI `Game`/`BattlescapeState` null-guards (companion headless + native UI unchanged when present) |

WP9 medikit executor paths were not modified (shared `companionMedikitActorAuthorized` reuse only).

## Engine behavior

- **Preflight (game + BState):** AI-owned actor (medikit authorization helper), not busy, held `BT_PSIAMP` in declared hand, `psiSkill > 0`, target exists, `companionIsGenuineHostileTarget`, visible + LOS when `RuleItem::LOSRequired`.
- **Resolution:** Native panic formula (distance, RNG 0–55, morale loss on success, `setMindControllerId` on success per OpenXcom panic).
- **TU:** `getActionTUs(BA_PANIC, psiAmp)`; spent once after `psiAttack()` even on failed rolls.
- **Results:** Rejects return `false` with generic `rejectReason`; completed attempts return `true` with optional `tuSpentOut` and engine-private `psychicSucceededOut` (morale drop or MC id change heuristic). No alien stat fields in public API.
- **Freshness:** `notePlayerTacticalMutationIfSnapshotConfigured()` after successful companion execution; `popState` also notes `BA_PANIC` for UI-ordered panic.

## Snapshot exports

- **`psiSkill`:** Friendly roster soldiers with geoscape soldier only (`exportFriendlyTacticalDetails`).
- **`panic` actionCosts:** When hand holds `BT_PSIAMP` and `psiSkill > 0`; `tuCost` from engine `getActionTUs`; `actionType` = C++ `BA_PANIC` (**12**, not 14 — see discrepancies).
- **Hostiles:** No `psiSkill`.

## Focused test results

| Suite | Result |
|-------|--------|
| `companion_psi_panic_engine_test` (Release, `build-isolated-m1-23e`) | **PASS** (10 scenarios) |
| `companion_snapshot_serialization_test` (incl. WP10 psi export cases) | **PASS** |
| `companion_medikit_engine_test` (regression) | **PASS** |
| Node `tactical-command-m1-wp10-psi-panic-s1.test.cjs` | **7/7** |
| Node `tactical-command-m1-wp9-medikit-s1.test.cjs` | **8/8** |

Harness notes: deterministic RNG via `RNG::setSeed`; failure case uses weak attacker stats; freshness case sets `OPENXCOM_COMPANION_SNAPSHOT_PATH`.

## Discrepancies vs native / S1

1. **`actionType` for panic:** C++ `BattleActionType` lists `BA_PANIC` as **12** (`BA_MINDCONTROL` = 11). S1 fixture/docs used **14**; schema and S1 fixture updated to **12** to match engine-exported snapshots.
2. **Successful panic and mind control:** Native panic sets `mindControllerId` on the target (existing OpenXcom behavior); `psychicSucceededOut` treats MC-id change as success (document for fair-play result contract in S3).
3. **Headless executor:** Infobox / `Game` pushes skipped when `BattlescapeState` absent; perception log recording still runs when battle rules allow.

## Remaining S3 dependencies

1. `CompanionCommandCore` / `CompanionCommandRuntime` — parse relay `PSI_PANIC`, call `tryExecuteCompanionPsiPanic`, write `tactical-result.json` (`tu_spent`, bounded result codes; keep detailed psychic outcome engine-private until fair-play review).
2. Fair-play terminal contract for success/failure (avoid hidden alien psi stats in relay payload).
3. Live F6 harness / relay E2E (not in S2a scope).
4. Optional: align S1 audit doc comment `BA_PANIC (14)` → `(12)`.

## Constraints honored

- No `PSI_MIND_CONTROL`, no GitHub dispatch, no commit/push, no full-mission automation, no production RNG changes, WP9 medikit logic untouched.
