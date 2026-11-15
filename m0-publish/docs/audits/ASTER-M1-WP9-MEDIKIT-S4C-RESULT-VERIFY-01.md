# ASTER-M1-WP9-MEDIKIT-S4C-RESULT-VERIFY-01 — pre-Release result verification

**Work package:** M1-WP9 medikit — Stage S4C (narrow result-semantics verification)
**Owner review gate:** STOP — no commits, pushes, release pin, or deployment.

## Summary verdict

| Gate | Result |
|------|--------|
| `companion_medikit_engine_test.exe` (S2 + relay E2E) | **PASS** |
| `companion_command_test.exe` | **PASS** |
| Node WP9 S1 / S3 / S4 | **14/14 PASS** |
| Product code change required for `target_revived` | **None** |
| Release readiness (WP9 medikit relay) | **GO** — same bounds as S4B, with adjacent/facing clarified |

## 1. STIMULANT `target_revived` investigation

### Intended semantics

`target_revived` on COMPLETED **HEAL** / **STIMULANT** means: the command performed the same revive bookkeeping as in-game `MedikitState` — i.e. target was **unconscious before** the apply step, and **after** `heal()` / `stimulant()` the native revive condition holds (`STATUS_UNCONSCIOUS` + `stunlevel < health` + `health > 0`), triggering `companionMedikitRecordRevive` (TU cleared to 0, revive statistics). It does **not** mean “patient is standing after tick” (standing can follow later via `reviveUnconsciousUnits()` on UI `BA_USE` paths not used by companion headless apply).

Implementation: `CompanionMedikitExecutionCore::applyStimulant` / `applyHeal` (mirrors `MedikitState::onStimulantClick` / `onHealClick`).

Relay result JSON encodes the flag as a **JSON boolean** (`"target_revived": true|false`), not a quoted string.

### Observed relay fixture (co-tile STIMULANT)

| Phase | Observation |
|-------|-------------|
| Pre-command | `status == STATUS_UNCONSCIOUS`, `stunlevel` 15 &lt; `health` 30 (revivable unconscious) |
| Native apply | Stimulant charge −1, stun reduced (e.g. 15 → 11 via `stunRecovery` 4) |
| Post-command | Revive bookkeeping path eligible; patient remains unconscious until separate engine wake-up rules |
| Terminal JSON | `"target_revived": true` on COMPLETED |

### Conclusion

S4B’s “flag **or** conscious status” relaxation was **unnecessary**: reporting matches S2 direct executor (`testStimulantRevivalSameTile` / `targetRevivedOut == true`). **No reporting defect**; **no production code change**.

### Test change

Harness now asserts pre-command unconscious revivable state and **requires** `"target_revived": true` on STIMULANT COMPLETED (boolean substring match).

## 2. Adjacent off-co-tile HEAL

| Question | Finding |
|----------|---------|
| Native rules vs bad fixture? | **Primarily bad fixture** for the historical failure |
| Mechanism | `resolveNativeMedikitTarget` requires co-tile unconscious **or** `TileEngine::validMeleeRange` in medic **facing** |
| S4B setup | Medic `(1,1)`, patient `(2,1)`, `setDirection(3)` → offset SE to `(2,2)`, not the patient → native target ≠ command `target_unit_id` → `MEDIKIT_APPLICATION_FAILED` after admission (**correct native behavior**) |
| Correct facing | Direction **2** (east, +x per `Pathfinding::directionToVector`) |
| Direction 2 experiment | Admission **accepted**; sparse 6×6 harness then faulted post-accept before stable terminal logging (not pursued — no gameplay changes) |

Harness retains **mis-aimed direction 3** as a bounded negative: terminal reject/fail with **no wound/charge/TU mutation**. Comment documents that east = direction 2 for a success fixture follow-up.

**No native gameplay changes.**

## 3. BATTLE_BUSY

Unchanged: `companion_command_test` preflight **`BATTLE_BUSY`** rejection only. **Live animation stack** during relay execution remains **unverified** (no full-mission test added).

## 4. Test evidence (this run)

```text
companion_medikit_engine_test.exe  → exit 0, All companion medikit engine tests passed
companion_command_test.exe         → all tests passed
node --test .../tactical-command-m1-wp9-medikit-s{1,3,4}*.test.cjs → 14/14 pass
```

Includes duplicate `command_id` replay idempotency in relay suite.

## 5. Changed files (S4C)

| File | Change |
|------|--------|
| `engine/OpenXcom/src/test/companion_medikit_relay_e2e_harness.cpp` | Strict STIMULANT `target_revived` + pre-state asserts; adjacent facing comment |
| `companion/m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-S4C-RESULT-VERIFY-01.md` | This report |

## Release recommendation

**GO for WP9 medikit Release deployment** from a relay-certification perspective: success-path HEAL/STIMULANT/PAINKILLER, rejections, duplicate replay, and `target_revived` semantics are aligned with native medikit revive bookkeeping. Carry forward **documented bounds**: adjacent success on sparse map with correct facing not fully certified; live `BATTLE_BUSY` stack unverified.

**STOP** — owner review only; no commit/push/deploy in this delivery.