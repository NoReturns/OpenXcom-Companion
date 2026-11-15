# ASTER-M1-WP9-MEDIKIT-S4-E2E-01 — bounded runtime certification

**Work package:** M1-WP9 medikit — Stage S4 (end-to-end relay certification)
**Owner review gate:** STOP — no commits, pushes, release pin, or live campaign changes in this delivery.

## Summary verdict

| Area | Verdict |
|------|---------|
| Node contract + publish dry-run (isolated fixtures) | **PASS** |
| C++ engine executor (direct path, S2) | **PASS** |
| C++ relay **rejection** file cycle (inbox → admission → result + journal) | **PASS** (bounded harness) |
| C++ relay **success** file cycle (HEAL / STIMULANT / PAINKILLER → terminal result JSON) | **FAIL** — SEH after admission in sparse relay harness |
| Release deployment readiness | **NOT READY** until success-path relay certification completes |

## Evidence (commands run)

### Node

```text
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s1.test.cjs
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s3-relay.test.cjs
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs
```

- **S1:** 8/8 pass — parse, validate, compose, binding rejects.
- **S3:** 3/3 pass — production `parseTacticalCommand` / `validateTacticalCommandAgainstSnapshot` on medikit fixtures.
- **S4:** compose + validate for HEAL/STIMULANT/PAINKILLER; publish CLI dry-run for HEAL; engine harness subprocess when `companion_medikit_engine_test.exe` is present.

### C++

```text
MSBuild .../companion_command_test.vcxproj /p:Configuration=Release
MSBuild .../companion_medikit_engine_test.vcxproj /p:Configuration=Release
.../companion_command_test.exe
.../companion_medikit_engine_test.exe
```

- **`companion_command_test.exe`:** all pass (includes WP9 medikit parse/validate/busy preflight).
- **`companion_medikit_engine_test.exe`:** S2 executor tests pass; **relay rejection suite** pass (see below).

## What was tested (not assumed)

### Relay rejection file cycle (C++, production `CompanionCommandRuntime::tick`)

Isolated directory beside `OPENXCOM_COMPANION_SNAPSHOT_PATH` under the test executable (`wp9_medikit_relay_e2e/`), with:

- `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`
- `companion-soldier-control.json` (session-bound AI assignment for actor 1)
- `noteSnapshotExportSha256` / `noteSnapshotExportStateVersion(0)` binding
- Real `tactical-command.json` → `tactical-result.json` + `tactical-command-journal.json`

| Case | Observed terminal status | Notes |
|------|--------------------------|-------|
| Stale `state_version` | REJECTED (`STALE_STATE_VERSION`) | Journal append |
| Wrong hand | REJECTED (`MEDIKIT_NOT_IN_HAND`) | Gameplay state unchanged vs pre-tick snapshots |
| Depleted heal charge | REJECTED (`MEDIKIT_CHARGE_DEPLETED`) | |
| Insufficient TU | REJECTED (`MEDIKIT_APPLICATION_FAILED` at execution) | Preflight accepted; native TU guard at apply |
| Hostile target id | REJECTED (`PROHIBITED_TARGET`) | |
| Busy battle (`_states` non-empty) | Not exercised | Still preflight-only in `companion_command_test` |

Harness implementation: `engine/OpenXcom/src/test/companion_medikit_relay_e2e_harness.cpp` (included from `companion_medikit_engine_test.cpp`). Default `main` runs **`runMedikitRelayRejectionOnlySuite()`** so CI/subprocess stays green; full success suite remains callable for manual investigation (`runMedikitRelayE2eSuite()`).

### Engine outcomes (direct executor, S2 — not relay inbox)

Already certified in S2: co-tile unconscious HEAL/STIMULANT/PAINKILLER, TU/charge consumption, `target_revived` on stimulant, wrong hand / wrong target / depleted / insufficient TU / unauthorized actor without state mutation.

### Node relay integration (no engine tick)

Publish dry-run and sidecar validation mirror WP8E pattern for medikit compose helpers.

## Confirmed defect / gap (success-path relay E2E)

1. **Sparse relay harness SEH after admission** — For HEAL (and duplicate replay case), logs show `accepted command_id=...` then access violation during the same `tickCompanionCommand` (Windows SEH). Direct `tryExecuteCompanionMedikitHeal` on the same fixture **succeeds** without tick; failure is specific to the **relay terminal path** (suspected `CompanionSnapshot::tryExport` / snapshot build after COMPLETED; not proven fixed in-tree).
2. **Battle item id 0** — Relay JSON requires `medikit_battle_item_id > 0`; harness must seed `*battle.getCurrentItemId() = 700` before equipping (fixed in harness; **not** a product rule change).
3. **Inbox poll interval** — Back-to-back inbox writes need ≥310 ms between publishes on Windows so `shouldReadCommandInboxNow` observes mtime (fixed in harness).
4. **Off-co-tile / melee facing** — Not automated in relay harness (`validMeleeRange` risk in sparse map); co-tile unconscious is covered in S2 and relay rejection suite.
5. **Busy state with real animation stack** — Not runtime-certified; `BATTLE_BUSY` remains validation-only in `companion_command_test`.
6. **Duplicate replay idempotency (success path)** — Not certified while success tick SEH remains.

## Narrow fixes applied in this S4 pass (no native rule changes)

- Added relay E2E harness and S4 Node test file.
- Harness: campaign roster + soldier fixture lifetime, positive battle item ids, inbox pacing, optional SEH guard around tick for investigation builds.
- No changes to medikit native targeting, charge rules, or stun-rod/psi scope.

## Tested vs assumed

| Behavior | Tested | Assumption / gap |
|----------|--------|-------------------|
| HEAL/STIMULANT/PAINKILLER native effects | Yes (S2 direct executor) | Success-path relay result JSON not completed |
| Friendly roster admission | Yes (Node validate + C++ prohibited target reject) | — |
| Unconscious co-tile target identity | Yes (S2) | Relay COMPLETED not written |
| Relay rejection leaves battle state unchanged | Yes (reject matrix) | Success path not re-verified in relay |
| `target_revived` in result JSON | Yes (S2 stimulant); relay JSON not completed | — |
| Journal + result on reject | Yes (stale, wrong hand, depleted, TU, hostile) | — |
| Busy rejection with live `_states` | No | Preflight only |
| Adjacent / facing medikit | No | S2 / engine notes only |

## Release readiness

**Not ready for deployment pin** until:

1. Success-path relay certification writes terminal `tactical-result.json` (+ journal) for HEAL, STIMULANT, and PAINKILLER without harness crash.
2. Duplicate command_id replay and stale-binding matrix completed on success + reject with unchanged state assertions.
3. Owner accepts remaining busy / off-co-tile gaps or follows up in a bounded harness hardening task.

## STOP — owner review

No git commits, pushes, release deployment, or runtime pin changes were made in this certification pass. Review harness + audit before enabling `runMedikitRelayE2eSuite()` in default test `main` or merging to release branches.