# ASTER-M1-MELEE-STUN-S2A-CLOSEOUT-01

**Date:** 2026-11-18  
**Scope:** Correctness and safety review of S2a native melee executor (no relay, deployment, commit, or push)  
**Reference:** [ASTER-M1-MELEE-STUN-S2A-ENGINE-01.md](./ASTER-M1-MELEE-STUN-S2A-ENGINE-01.md)  
**Constraint:** `companion_melee_engine_test.exe` **not executed** in this closeout.

## Verdict

**READY FOR S2B** (wire parse/preflight + call `tryExecuteCompanionMeleeAttack` behind the same patterns as WP9/WP10, feature-flagged dry-run first).

**BLOCKED for enabled live inbox execution / operator deployment** until bounded engine verification completes (harness or S3 state-stack path) and the conditions in §6 are met.

---

## 1. Turning correctness

### Implementation (after closeout change)

| Behavior | Headless harness (`getMap() == 0`) | Live `BattlescapeState` (map present) |
|----------|--------------------------------------|----------------------------------------|
| Turn steps | Up to 8 × `spendTimeUnits(1)` + `turn()` + FOV | Same stepped loop |
| Facing snap fallback | If still `STATUS_TURNING`, `lookAt(dir, true)` + `abortTurn()` | **Not applied** |
| Incomplete turn | Completes via snap | Returns `"Unit could not complete turn toward target."` **before** range check |

**Change:** `CompanionMeleeExecutionCore.cpp` — `isHeadlessHarness()` gates snap; live path **rejects** if turn does not finish within 8 steps (should not occur in normal play; max facing change is 4 steps).

### TU for turning

- Each step charges **1 TU** (same as `UnitTurnBState::think` with `_chargeTUs`).
- Snap fallback does **not** charge extra TU beyond steps already spent; only used when harness has no UI tick loop.
- **Gap:** `executeMelee` reserves melee TU **before** turning. Turning TU is not included in the upfront `tuReserve < meleeTu` check. A later `checkReservedTU(actor, meleeTu)` can fail **after** turn TU is already spent → partial TU loss (no strike). Menu flow typically turns via `UnitTurnBState` first; companion path can leave “orphan” turn TU on reject. **Not fixed in closeout**; document for S3 / preflight TU advisory.

### `validMeleeRange`

- Evaluated **after** turn completes (or harness snap).
- Uses `actor->getDirection()` post-turn — correct for native obstruction rules.

### Live combat impact

- Forced snap **cannot** run in a normal Battlescape session (map non-null).
- Stock **player menu** melee (state stack, no `companionExecuteMelee`) is **unchanged**.

---

## 2. Execution path correctness

### Authoritative damage

- `resolveHit()` is **unchanged logic** (RNG accuracy → `TileEngine::hit` / `checkForCasualties`).
- No companion-specific damage or stun math.

### Success reporting

| Stage | Behavior |
|-------|----------|
| Reject before `companionExecuteMelee` | `meleeHit` / outcome false; no `resolveHit` |
| `companionExecuteMelee` | TU checked **before** `performMeleeAttack` + `resolveHit` |
| `meleeHit` output | Inferred from **stun/health delta**, not RNG flag directly |

**Caveats:**

- **Hit proxy:** A “hit” is `stun > before || health < before`, not a dedicated miss flag from `resolveHit`. Theoretically wrong if collateral changes same target in one call (only `checkForCasualties` runs — low risk for isolated melee).
- **Miss:** RNG fail → no stat change → `meleeHit == false`; attack still **accepted** (`true` return) with TU spent — aligns with “attempt completed” semantics.

### TU spending

| Charge | When |
|--------|------|
| Turning | 0–8 TU in `turnActorToward` |
| Melee | Once in `companionExecuteMelee` via `spendTimeUnits(action.TU)` after `resolveHit` |

- Failures **before** `companionExecuteMelee`: no melee TU spent; turn TU may already be spent (see gap above).
- Failures **inside** `companionExecuteMelee` before `resolveHit`: no melee spend (TU guard at line 367).
- **No double melee TU** (no `MeleeAttackBState` on stack in companion sync path).

### Headless guards vs production

- `performMeleeAttack` / `resolveHit` map and sound paths guarded by `companionHeadlessMelee` and `map != 0`.
- **Companion sync path always sets `companionHeadlessMelee = true`** (skips `ExplosionBState` push — required for instant execution without pumping the state stack).
- **Effect on human menu melee:** none (different entry point).
- **Effect on future live relay:** strikes apply damage synchronously **without** melee swing FX/sounds until S3 splits “instant resolve” vs “cosmetic” flags.

### Unconscious / killed

- Computed **after** `resolveHit` from target status and stun vs health — not from animation.

### Differences from standard player melee

| Standard (menu) | Companion S2a |
|---------------|---------------|
| TU spent, then `MeleeAttackBState` on stack | Sync `companionExecuteMelee` |
| `resolveHit` in `think()` after explosion cosmetic | Immediate `resolveHit` |
| Sounds + explosion state | Skipped (headless flag) |
| Turn via `UnitTurnBState` | Inline stepped turn in `CompanionMeleeExecutionCore` |
| Reaction melee | Not enabled (stock comments unchanged) |

---

## 3. Lightweight verification

### Tests performed

| Target | Result |
|--------|--------|
| `companion_command_test.exe` (Debug) | **PASS** — all tests including melee parse + expanded preflight |

**New preflight cases (this closeout):** weapon native mismatch, wrong hand, friendly target, no LOS.

**Not run:** `companion_melee_engine_test.exe`, Unity, live game.

### Outstanding unverified behaviors

Requires harness, minimal Battlescape fixture, or S3 animated path:

- Adjacent stun rod hit / unconscious outcome
- Turn direction at `validMeleeRange` boundary
- Obstruction, elevation, weapon ID at runtime
- `isBusy()` rejection
- Miss vs hit under fixed RNG seeds
- TU exactly once (turn + melee) end-to-end
- Partial TU loss on post-turn preflight reject

---

## 4. Code changes (this closeout)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Engine/CompanionMeleeExecutionCore.cpp` | Headless-only facing snap; reject incomplete turn on live map; `isHeadlessHarness()` |
| `engine/OpenXcom/src/test/companion_command_test.cpp` | Four additional melee preflight tests |

---

## 5. Normal gameplay

**Unaffected:** Human-initiated melee through the action menu and `handleNonTargetAction` → `MeleeAttackBState` stack.

**Affected when relay executes (future):** Companion-ordered melee will apply rules-correct damage but **without** stock melee audio/explosion until S3.

---

## 6. Conditions before live deployment

1. **Pass** `companion_melee_engine_test.exe` (or replacement harness) once after headless fixes — owner/local CI only.
2. **S2b:** Default to **dry-run** / executor-disabled until (1) passes.
3. **S3 or follow-up:** Separate cosmetic flag from `companionHeadlessMelee` if relay should play sounds with instant resolve; or use full `UnitTurnBState` + `MeleeAttackBState` + state pump.
4. **Preflight:** Include **turn + melee** TU in Node/engine advisory where `actionCosts.melee` exists (turn not reserved today).
5. **Result JSON:** Do not treat `meleeHit` as fair-play disclosure of HP; keep incapacitation booleans only.

---

## Stop

No S2b/S3 implementation, deployment, commit, or push in this order.