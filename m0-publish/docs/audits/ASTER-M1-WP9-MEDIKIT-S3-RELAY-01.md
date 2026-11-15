# ASTER-M1-WP9-MEDIKIT-S3-RELAY-01

**Status:** S3 relay integration complete in tree — **STOP for owner review.** No commits, push, release pin, or runtime deploy in this pass.

## Summary

Wired **HEAL**, **STIMULANT**, and **PAINKILLER** through the production tactical relay stack: Node `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot`, engine parse/validate/preflight, and synchronous inbox dispatch to existing `BattlescapeGame::tryExecuteCompanionMedikit*` executors (S2). Friendly roster targeting is enforced on Node (S1) and again in engine preflight plus execution (`isCompanionFriendlyRosterSoldierTarget`; native `resolveNativeMedikitTarget` + exact `target_unit_id` unchanged).

## Files touched

| Area | Path |
|------|------|
| Node parse/validate | `companion/m0-publish/lib/tactical-command.cjs` |
| Engine contract | `engine/OpenXcom/src/Engine/CompanionCommandCore.h`, `.cpp` |
| Relay runtime | `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` |
| Target policy (engine) | `engine/OpenXcom/src/Engine/CompanionTacticalAuthorityCore.h`, `CompanionTacticalHumanOrderAdmission.cpp` |
| Execution | `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` |
| Tests | `companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs`, `test/tactical-command-m1-wp9-medikit-s3-relay.test.cjs`, `test/helpers/medikit-wp9-fixture.cjs`, `engine/OpenXcom/src/test/companion_command_test.cpp` |

## Test evidence

| Command | Result |
|---------|--------|
| `node --test test/tactical-command-m1-wp9-medikit-s1.test.cjs test/tactical-command-m1-wp9-medikit-s3-relay.test.cjs` | **11/11 pass** |
| `build-isolated-m1-23e\bin\Release\companion_command_test.exe` | **all tests passed** (incl. medikit parse/validate/bbusy preflight) |
| `build-isolated-m1-23e\bin\Release\companion_medikit_engine_test.exe` | **All companion medikit engine tests passed** (relay-linked runtime compiles) |

### Rejection / lifecycle coverage

| Path | Node | Engine preflight | Engine execution |
|------|------|------------------|------------------|
| Wrong / hostile target | Yes | `PROHIBITED_TARGET` | Friendly roster guard |
| Stale binding | Yes | Binding validator | — |
| Depleted charge | Yes | `MEDIKIT_CHARGE_DEPLETED` | Charge restore on failed apply (S2) |
| Battle busy | — | `BATTLE_BUSY` | `tryExecute` busy guard |
| Parse / schema | Yes | `parseMedikitCommandJson` | — |
| Duplicate / journal | — | Same templates as DROP/RELOAD | — |
| Wrong hand / no medikit / TU / target mismatch | Partial (Node hand/charge/TU) | Partial | S2 executor messages |

## Unverified (explicit gaps)

1. **Live inbox E2E** — no full `openxcom.exe` + filesystem inbox cycle for medikit result/journal/mutation in this pass.
2. **Busy battlescreen animation** — `BATTLE_BUSY` validated in `validateMedikitCommand` input only; no harness pushing non-empty `BattlescapeGame::_states` copy (S2 note).
3. **Melee-facing / non–co-tile geometry** — adjacency and facing still engine-only; S2 sparse harness avoided `validMeleeRange` crash.
4. **Relay notify enrichment** — `companion-relay-notify.cjs` not extended for medikit result fields.
5. **Per-reject E2E matrix** — wrong hand, depleted charges at engine with live relay files, duplicate command id, stale snapshot at runtime — covered by unit/pre-flight tests, not full integration harness.

## Exactly-once / no mutation on reject

- Rejected commands: journal/result reject paths mirror inventory family; failed `tryExecuteCompanionMedikit*` does not write `CMD_COMPLETED`; S2 rollbacks on `MEDIKIT_NO_CHARGE` / `MEDIKIT_INSUFFICIENT_TU` unchanged.
- Accepted commands: synchronous completion + `noteTacticalBattleMutation()` on success (same pattern as DROP).

## Deployment readiness

**Recommend: not deployment-ready until owner review.**

- Merge/review S3 diff, then rebuild canonical `runtime\m0\bin\openxcom.exe` and run one cooperative relay smoke (heal + stimulant + painkiller) on a harness mission.
- Keep runtime pin unchanged until sign-off.

---

*Owner review gate — no git commit, push, or release actions taken.*