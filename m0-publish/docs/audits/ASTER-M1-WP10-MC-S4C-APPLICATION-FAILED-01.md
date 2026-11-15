# ASTER-M1-WP10-MC-S4C — `PSI_*_APPLICATION_FAILED` investigation

**Work package:** M1-WP10 — Stage S4C  
**Authorization:** Investigation only. **No production edits, commit, push, or live relay.**

## Executive answer

| Question | Verdict |
|----------|---------|
| Is `PSI_PANIC_APPLICATION_FAILED` / `PSI_MIND_CONTROL_APPLICATION_FAILED` a **failed psychic roll**? | **No.** A lost roll is a **successful execution**: native code returns `true`, relay writes **`COMPLETED`** + `tu_spent`. |
| What is `APPLICATION_FAILED`? | **Post-accept execution refusal:** preflight accepted the inbox, then `tryExecuteCompanionPsiPanic` / `tryExecuteCompanionPsiMindControl` returned **`false`**. Engine text is copied into `public_reason`. |
| Live production defect proven? | **Not proven.** Intermittent native relay failures (~**40–60%** on a 10–15 run sample) reproduce on **static harness** only; direct executor tests for the same RNG/stats scenario are stable. |

## Acknowledgement contract (production path)

### Chain

1. **`CompanionCommandRuntime::tickCompanionCommand`** — parse inbox → `validatePsiPanicCommand` / `validatePsiMindControlCommand` (binding + hand + target + TU + visibility/LOS when rules require it).
2. On accept → **`BattlescapeGame::tryExecuteCompanionPsiAmpAttack`** — auth, amp, target roster checks.
3. → **`CompanionPsiExecutionCore::executePanic` / `executeMindControl`** — builds `BattleAction` with `action.target = target->getPosition()`.
4. → **`PsiAttackBState::companionExecutePsiAttack`** — tile occupancy, visibility, optional LOS, **`psiAttack()`**, then **`spendTimeUnits`**.

### Failed psychic roll (fair-play)

`psiAttack()` compares attack vs defense; on failure only XP side effects run (no panic/MC state change). The companion wrapper then spends TU and returns **`true`**:

```278:436:engine/OpenXcom/src/Battlescape/PsiAttackBState.cpp
	else
	{
		if (Options::allowPsiStrengthImprovement)
		{
			_target->addPsiStrengthExp();
		}
	}
}
// ... companionExecutePsiAttack continues:
	state.psiAttack();
	if (!action.actor->spendTimeUnits(action.TU))
	{
		// returns false — distinct from failed roll
		return false;
	}
	// tuSpentOut set; return true (psychicSucceededOut may be false)
	return true;
```

Relay maps **`executed == true`** → **`COMPLETED`** + `tu_spent` (panic ~5147–5178, MC parallel ~5291+). **`psychicSucceededOut` is not passed on the relay path** (`nullptr`); outcome blindness is preserved.

### `PSI_*_APPLICATION_FAILED`

Only when **`tryExecute…` returns `false`** after validation accepted:

```5147:5155:engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp
		const bool executed = game->tryExecuteCompanionPsiPanic(
			actor, psiAmp, psiParsed.activeHand, psiParsed.targetUnitId, &rejectReason, &tuSpent, 0);

		if (!executed)
		{
			rejectPsiPanicCommand(resultPath, psiParsed, "PSI_PANIC_APPLICATION_FAILED", rejectReason, inboxDigest);
```

`public_reason` is the engine `rejectReason` string (not a psychic outcome).

## Every `false` path and TU (executor)

### Preflight (`validatePsiPanicCommand` / binding) — **`REJECTED`, 0 TU**

Binding, `BATTLE_BUSY`, hand/amp, zero skill, target visibility, `NO_LINE_OF_SIGHT`, `INSUFFICIENT_TU`, etc. No executor call.

### `tryExecuteCompanionPsiAmpAttack` pre-executor — **`APPLICATION_FAILED` if accept reached**, 0 TU

Includes `isBusy()`, unauthorized actor, amp placement, `companionFindUnitById` miss, non-genuine hostile — all set `tuSpentOut = 0` first.

### `companionExecutePsiAttack` — **`APPLICATION_FAILED` if accept reached**

| Stage | Typical `rejectReason` | TU before path | TU after |
|-------|-------------------------|----------------|----------|
| Invalid params / no save | labels above | 0 | 0 |
| No tile / **no unit on target tile** | `Target unit not found.` | 0 | 0 |
| Low TU (pre-attack) | `Not enough time units.` | 0 | 0 |
| Not visible / no LOS | visibility / LOS strings | 0 | 0 |
| **`psiAttack()` then `spendTimeUnits` fails** | `Not enough time units.` | **Psychic resolution may have run** | **Ambiguous** (no relay rollback; `tuSpentOut` stays 0) |

**Failed psychic roll never hits the `!executed` branch** as long as pre-attack checks pass and TU spend succeeds.

### Preflight vs executor gap (relevant to flakes)

- Validation resolves target by **`findUnitById`** and `target->getVisible()` / `getVisibleUnits()` LOS.
- Execution requires **`getTile(action.target)->getUnit() == target`** (position from `target->getPosition()` at compose time).

If the roster lists a visible hostile but the **tile grid is stale or occupied**, preflight can accept while execution returns **`Target unit not found.`** → **`APPLICATION_FAILED`**. This is **not** mis-labelling a psychic roll.

## Bounded reproduction (S4C)

| Run | `companion_psi_panic_engine_test.exe` | `companion_psi_mind_control_engine_test.exe` |
|-----|--------------------------------------|-----------------------------------------------|
| 15× panic relay (clean `wp10_psi_panic_relay_e2e` each run) | **9 pass / 6 fail** | — |
| 10× MC relay (clean `wp10_psi_mc_relay_e2e`) | — | **4 pass / 6 fail** |

Failure signature (panic): `FAIL: failed psychic roll still COMPLETED`, duplicate idempotency follow-on failures, engine log `code=PSI_PANIC_APPLICATION_FAILED` **after inbox accepted**.

Direct harness (`testFailedPanicStillConsumesTu`) uses a **fresh** `PsiScenario` per test — no shared static battle — and does **not** flake in the same runs.

**Conclusion:** S4B mitigations (ruleset dedup, floor `MapData`, separate relay dirs, suite reorder) **reduced** noise but **did not remove** the defect class.

## Root cause (recommended)

**Primary (harness):** `Wp10RelayHarness::clearBattleUnits` **deletes** `BattleUnit` instances **without** clearing **`Tile::setUnit`** occupancy on the reused 6×6 map. `setUnitPosition` then fails when a tile still references a freed unit; `wireUnitTile` ignores the return value. Sporadically the hostile is on the roster for preflight but **absent on the tile** at execution → **`PSI_*_APPLICATION_FAILED`** with engine text like **`Target unit not found.`** Relay suite order (success → failed roll → duplicate) **amplifies** tile reuse.

**Not root cause:** Failed psychic roll mis-reported as `APPLICATION_FAILED` on the **stable** executor path.

**Secondary (production hardening, optional):** Single bucket `PSI_*_APPLICATION_FAILED` collapses executor errors that could have been preflight rejects (tile sync, LOS re-check, `isBusy()` after accept). Medikit path already maps more failures at validate time (`battleBusy` in binding).

**Latent edge (not S4C flake driver):** If `spendTimeUnits` fails **after** `psiAttack()`, relay emits **`REJECTED`** + `APPLICATION_FAILED` with 0 `tu_spent` while psychic effects may have applied — same class as medikit TU rollback policy.

## Smallest correction (for owner approval — **not applied in S4C**)

1. **Harness-only (recommended):** In `clearBattleUnits` / `resetScenario`, before `delete`, for each unit call tile clearing consistent with engine teardown (`getTile(position)->setUnit(0)` and large-unit footprint), or sweep all map tiles and null units. Assert `setUnitPosition` success in `wireUnitTile` in tests.
2. **Optional production (larger):** Add **`targetOnTile`** to `fillPsiPanicValidationInput` / MC analogue so tile misses become **`REJECTED`** with a specific code and 0 TU (parity with `companionExecutePsiAttack`).
3. **Optional production (TU edge):** Mirror medikit rollback if post-`psiAttack` TU spend fails; or document as accepted engine quirk.

**Do not deploy** until relay gates are **deterministic** or owner explicitly accepts harness-only risk.

## WP9 + WP10 production build note (checkpoint concern)

| Item | State |
|------|--------|
| WP10 (committed) | `CompanionPsiExecutionCore.cpp` in `CMakeLists.txt` `openxcom_src` |
| WP9 medikit (uncommitted) | `CompanionMedikitExecutionCore.{cpp,h}` present on disk; **`BattlescapeGame.cpp` includes medikit executor** |
| Tracked `CMakeLists.txt` | Lists `CompanionPsiExecutionCore.cpp` but **does not list** `CompanionMedikitExecutionCore.cpp` in `openxcom_src` (local generated `openxcom.vcxproj` may still compile it from an earlier configure) |

Before integrated production build: **re-run CMake**, verify **`openxcom` links both** `CompanionPsiExecutionCore` and `CompanionMedikitExecutionCore`, and run medikit + psi native gates on the **same** artifact.

## STOP — S4C complete

No code changes. Deployment remains **BLOCKED**. Await approval on harness tile teardown (or optional production preflight parity) before re-gating relay E2E.