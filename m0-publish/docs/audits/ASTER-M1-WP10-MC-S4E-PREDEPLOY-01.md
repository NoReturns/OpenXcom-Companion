# ASTER-M1-WP10-MC-S4E — predeployment integration audit

**Work package:** M1-WP10 + WP9 release readiness  
**Authorization:** Investigation and minimal plan only. **No implementation in S4E; no push/deploy/live relay.**

## Scope

| Track | Question | S4E outcome |
|-------|----------|-------------|
| **A — CMake / link** | Is `openxcom` + companion test EXEs reproducibly linked with both WP9 and WP10 execution cores? | **Gap confirmed** — tracked source lists `CompanionPsiExecutionCore.cpp` only |
| **B — Psychic TU atomicity** | On the **authorized companion relay path**, can `psiAttack()` apply gameplay effects and then fail `spendTimeUnits` without a prior defect? | **No valid production path found** — preflight + synchronous executor make post-`psiAttack` spend failure unreachable for same `_tu` |

---

## A — WP9/WP10 CMake integration

### Current state (tracked `engine/OpenXcom/src/CMakeLists.txt`)

| Artifact | `CompanionPsiExecutionCore.cpp` | `CompanionMedikitExecutionCore.cpp` |
|----------|-----------------------------------|----------------------------------------|
| `openxcom_src` (production `openxcom` target) | **Listed** (~line 161) | **Missing** |
| `BattlescapeGame.cpp` / `ActionMenuState.cpp` | N/A | **`#include` + calls present** on `aster/m0` + working tree |
| On-disk sources | Committed (WP10) | **Present, uncommitted** (WP9) |

Companion native tests use `companion_snapshot_terrain_test_src` (= `openxcom_src` minus `main.cpp`), so **any** gap in `openxcom_src` breaks **all** harness EXEs that link `BattlescapeGame.cpp`.

### Reproducibility defect

S4D re-linked tests by patching **generated** `build-isolated-m1-23e/**/*.vcxproj`. That is **not** a durable build contract. A clean `cmake` + MSBuild from tracked CMake **without** medikit in `openxcom_src` produces **LNK2019** on medikit symbols already referenced from committed battlescape/relay code.

**This is a build inventory defect, not a runtime psychic defect.**

### Minimal integration plan (owner approval before implement)

1. **Single CMake edit** — add next to psi core in `openxcom_src`:
   - `Engine/CompanionMedikitExecutionCore.cpp`
2. **Regenerate** isolated build dir (`cmake` configure from `engine/OpenXcom`).
3. **Verify link** (no stress):
   - `openxcom` (or smallest MSBuild target that links full game)
   - `companion_psi_panic_engine_test.exe`
   - `companion_psi_mind_control_engine_test.exe`
   - `companion_medikit_engine_test.exe` (when WP9 commits land)
4. **Gate before integrated Release deploy** (already owner-mandated):
   - Commit WP9 medikit sources + CMake line in **one engine commit** (or ordered: CMake + medikit .cpp together).
   - Re-run one pass each: medikit engine test, psi panic/MC tests, `companion_command_test`, Node WP9 + WP10 suites.

**Out of scope for S4E:** staging WP9 gameplay edits (`ActionMenuState`, `TileEngine`, Node equipment brief) — bundle with WP9 commit, not WP10 S4D.

---

## B — Psychic TU atomicity (`psiAttack` vs `spendTimeUnits`)

### Contract concern

`PsiAttackBState::companionExecutePsiAttack` runs **`psiAttack()` then `spendTimeUnits(action.TU)`**. If spend returns `false` after a **successful** psychic roll, relay maps **`PSI_*_APPLICATION_FAILED`** with **`tu_spent` omitted** (reject JSON), while morale/faction may already have changed. Medikit uses explicit TU/charge **rollback** on some failure classes; psi does **not**.

### Authorized production path (companion tactical relay)

Sequence in `CompanionCommandRuntime::tickCompanionCommand` (panic §5100–5156, MC parallel):

1. **`validatePsiPanicCommand`** — includes `insufficientTuForPanic` via `fillPsiPanicValidationInput` → `checkReservedTU(actor, panicTu, true)` where `panicTu = getActionTUs(BA_PANIC, psiAmp)`.
2. Binding gates — `BATTLE_BUSY`, `PRIOR_COMMAND_ACTIVE`, single terminal command, player turn, etc.
3. **Same stack, no yield** — `tryExecuteCompanionPsiPanic` → `companionExecutePsiAttack`:
   - Early exit if `getTimeUnits() < action.TU` (**no** `psiAttack()`).
   - `action.TU` from same `getActionTUs(BA_PANIC, psiAmp)` as preflight (via `CompanionPsiExecutionCore::executePanic`).
   - `psiAttack()` — **does not** call `spendTimeUnits` / `setTimeUnits` on **actor**.
   - `spendTimeUnits(action.TU)` — `BattleUnit::spendTimeUnits`: succeeds iff `tu <= _tu`.

### Why post-`psiAttack` spend failure is unreachable (relay)

| Condition | Reason |
|-----------|--------|
| Same thread | Validate and execute run synchronously in one `tickCompanionCommand` invocation; no interleaved battlescape actions on the actor. |
| `_tu` unchanged between checks | Only `psiAttack()` runs between the pre-attack `getTimeUnits()` guard and `spendTimeUnits`; actor TU is not modified inside `psiAttack()` for the acting unit. |
| Preflight ⊇ raw TU (typical) | `checkReservedTU(..., justChecking=true)` fails when `panicTu + kneel + reserved > getTimeUnits()` (player). Passing preflight implies `panicTu <= getTimeUnits()` for normal reserve modes — **stricter** than executor raw check. |
| Duplicate `tu` amount | Preflight `panicTu` and executor `action.TU` both from `getActionTUs(BA_PANIC, psiAmp)` on the same amp instance in the same tick. |

**Corollary:** The only observed `APPLICATION_FAILED` + zero TU cases in S4C were **harness tile ghosts** and other **pre-`psiAttack` executor rejects**, not partial psychic + failed spend.

### Residual paths (not “valid companion production”)

| Path | Risk | S4E disposition |
|------|------|-----------------|
| Direct `tryExecuteCompanionPsi*` without relay validate | External TU drain between calls | **Out of contract** — not inbox-authorized |
| Human UI `PsiAttackBState` BState machine | Animation / multi-phase | **Out of scope** — companion uses `companionExecutePsiAttack` instant path only |
| `checkReservedTU` rare `return true` branch (~L1392) with no reserve math | Theoretical loose preflight | **No paired executor success→spend-fail** demonstrated; panic TU 25 vs full pool — does not create spend failure after `psiAttack` without `_tu` mutation |

**Recommendation:** **No rollback machinery** for psi on companion relay until a **reproducible** production counterexample shows `executed == false`, `rejectReason == "Not enough time units."`, and psychic state change after accept. S4C/S4D failures do not qualify.

### Optional future hardening (only if defect found)

1. Reorder to spend TU **before** psychic resolution (gameplay change — **reject** without design sign-off).
2. Or medikit-style rollback of morale/faction on spend failure (only if counterexample exists).

---

## S4D checkpoint reference (authorized local commit)

| Repo | Intended content |
|------|------------------|
| `engine/OpenXcom` | `companion_psi_panic_relay_e2e_harness.cpp` tile teardown only |
| `companion` | S4C, S4D, S4B WP10 audit updates |

**Not in S4D commit:** WP9 medikit sources, `ActionMenuState`/`TileEngine`, CMake, generated `build-isolated` trees.

---

## Deployment decision matrix (post-S4E)

| Gate | Status |
|------|--------|
| Relay harness stability (S4D 10/10) | **Met** (bounded sample) |
| Reproducible CMake with both execution cores | **Not met** — plan §A |
| Psychic TU atomicity defect | **Not identified** on relay path — §B |
| Live deploy | **Blocked** until §A + owner WP9/WP10 integrated commit strategy |

## STOP — S4E complete

No code or CMake changes in this stage. Next owner action: approve **minimal CMake + WP9 commit bundle**, then re-gate native/Node tests before deploy.