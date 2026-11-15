# ASTER-M1-WP9-MEDIKIT-S2-ENGINE-01

**Date:** 2026-11-15
**Scope:** Engine execution only (no relay / `parseTacticalCommand` wiring)
**Stop:** Owner review before S3 relay integration.

## Verdict

S2 **complete** for headless engine execution: three `BattlescapeGame::tryExecuteCompanionMedikit*` entry points mirror native **`ActionMenuState`** target resolution and **`MedikitState`** single-button effects. **No** `CompanionCommandRuntime` dispatch; S1 medikit types remain off the live relay parse path.

## Changed files

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionMedikitExecutionCore.h` | Target resolution + headless apply API |
| `engine/OpenXcom/src/Engine/CompanionMedikitExecutionCore.cpp` | Implementation |
| `engine/OpenXcom/src/Battlescape/ActionMenuState.cpp` | Calls shared `resolveNativeMedikitTarget` |
| `engine/OpenXcom/src/Battlescape/BattlescapeGame.h` / `.cpp` | `tryExecuteCompanionMedikitHeal/Stimulant/PainKiller` + preflight |
| `engine/OpenXcom/src/test/companion_medikit_engine_test.cpp` | Focused harness (`companion_medikit_engine_test`) |
| `engine/OpenXcom/src/CMakeLists.txt` | Core source + test target |
| `companion/m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-S2-ENGINE-01.md` | This report |

## Engine API

- `tryExecuteCompanionMedikitHeal(actor, medikit, activeHandSlotId, targetUnitId, bodyPart, reject, tuSpent?, revived?)`
- `tryExecuteCompanionMedikitStimulant(..., revived?)`
- `tryExecuteCompanionMedikitPainKiller(...)`

**Preflight:** actor state, battle busy, campaign hint → tactical AI soldier set, `BT_MEDIKIT` in declared hand, item usable, charges, TU via `getActionTUs(BA_USE, item)`, **native target** via `resolveNativeMedikitTarget` must equal `target_unit_id` (no substitution).

**Apply:** `CompanionMedikitExecutionCore::applyHeal|applyStimulant|applyPainKiller` — same mutations and statistics as `MedikitState` (including no-op heal charge consumption and stim/heal revive TU=0 paths).

**UI / snapshot:** `notePlayerTacticalMutationIfSnapshotConfigured` only when `_parentState` present (harness uses `BattlescapeGame(&battle, 0)`).

## Native parity

| Behavior | Parity |
|----------|--------|
| Unconscious co-tile target priority | **Shared** resolver with `ActionMenuState` |
| Melee-range conscious targets + wounded-friend priority | **Shared** resolver (TileEngine `validMeleeRange`, `preferEnemy=false`) |
| TU per application | Ruleset `getActionTUs(BA_USE, medikit)` |
| Heal no-op still spends charge | **Verified** in harness |
| Stimulant revive | **Verified** (stun &lt; health) |
| Painkiller morale tracking | `painKillers()` unchanged |
| Wrong explicit `target_unit_id` | Hard reject before apply |

## Test evidence

```text
MSBuild build-isolated-m1-23e\src\companion_medikit_engine_test.vcxproj /p:Configuration=Release
bin\Release\companion_medikit_engine_test.exe
→ All companion medikit engine tests passed.
```

Covers: heal wounded part, heal no-op charge, stimulant revive + stun, painkiller, wrong target id, wrong hand, depleted charges, insufficient TU, unauthorized actor (campaign hint without AI tactical assignment).

**Deferred harness gaps (documented):**

- **Busy battle** — `BattlescapeGame::getStates()` returns a **copy**; queued-state busy test needs a BattlescapeState integration hook or a test-only mutator.
- **Melee-facing / wrong facing** — sparse map harness triggered instability in `validMeleeRange`; co-tile unconscious fixtures used; melee parity relies on **production** `ActionMenuState` sharing `CompanionMedikitExecutionCore::resolveNativeMedikitTarget`.

## Targeting policy: S1 Node vs native engine

| Layer | Target policy |
|-------|----------------|
| **Native engine** (`resolveNativeMedikitTarget`) | Any **woundable** unit: unconscious same tile, else melee-facing selection (may include bleeding aliens per rules / options). |
| **S1 Node** (`validateMedikitApplicationAgainstSnapshot`) | **`target_unit_id` must be friendly roster soldier** in snapshot (advisory geometry). |
| **S2 engine executor** | Native resolver + **explicit ID must match** native pick — does **not** broaden to roster-only by itself. |
| **S3 (planned)** | Relay + Node should enforce **Companion targeting policy** (roster-only vs native woundables) **before** publish; engine remains authoritative on geometry/priority. |

Do **not** widen native gameplay to “fix” the gap; document and enforce policy in S3 at validation + binding, not in `TileEngine`.

## Relay isolation

- `CompanionCommandRuntime` — **unchanged** (no medikit dispatch).
- `parseTacticalCommand` — **unchanged** (medikit types still unsupported on live path).

## Readiness for S3

1. Wire `HEAL` / `STIMULANT` / `PAINKILLER` in `CompanionCommandRuntime::tick` to the three `tryExecuteCompanionMedikit*` methods.
2. Enable `parseTacticalCommand` + snapshot validation on the relay path (reuse S1 parsers).
3. Resolve **owner targeting policy** vs native woundables in Node + playbook.
4. Terminal `tactical-result.json` + post-command snapshot for one atomic application.
5. Add busy-state integration test via real battle state queue (optional).