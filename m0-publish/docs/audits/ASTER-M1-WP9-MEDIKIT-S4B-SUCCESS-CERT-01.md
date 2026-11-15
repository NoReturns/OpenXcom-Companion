# ASTER-M1-WP9-MEDIKIT-S4B-SUCCESS-CERT-01 — bounded success-path relay certification

**Work package:** M1-WP9 medikit — Stage S4B (post–S4A RCA success-path certification)
**Owner review gate:** STOP — no commits, pushes, release pin, or live campaign changes in this delivery.

## Summary verdict

| Area | Verdict |
|------|---------|
| Node S1 / S3 / S4 (compose, validate, dry-run, engine subprocess) | **PASS** (14/14) |
| C++ S2 direct executor | **PASS** |
| C++ relay rejection + success file cycle (inbox → tick → result + journal) | **PASS** (`runMedikitRelayE2eSuite()` default gate) |
| `companion_command_test.exe` | **PASS** |
| Release deployment readiness (WP9 medikit relay success path) | **READY with documented bounds** (see gaps) |

## Root cause closure (S4A → S4B)

| S4A finding | S4B resolution |
|-------------|----------------|
| Terminal snapshot `tryExport` threw `Inventory STR_GROUND not found` in sparse test Mod | `wp9RegisterGroundInventory()` mirrors `snapshotTestGroundInventoryRule()` in `companion_snapshot_serialization_test.cpp` |
| Probe/static inbox SHA vs live export digest → `STALE_SNAPSHOT` | Harness uses `CompanionSnapshot::tryExport` immediately before inbox write; command `snapshot_sha256` and `state_version` taken from that export (`noteSnapshotExportSha256` / `noteSnapshotExportStateVersion`) |
| SEH masquerading as medikit failure | Removed S4A probe/trace instrumentation from `CompanionCommandRuntime.cpp` and `companion_medikit_engine_test.cpp` |
| `tryExport` exception swallowing in production | **Not implemented** (out of scope for WP9; record separately if desired) |

## Production-like relay ordering (harness)

1. `CompanionSnapshot::tryExport` → updates runtime binding + writes tactical YAML under `OPENXCOM_COMPANION_SNAPSHOT_PATH`
2. `companion-tactical-publication-confirm.json` beside snapshot (m0 parity; admission does not require it)
3. `tactical-command.json` with matching `snapshot_sha256` / `state_version` / `session_id` / `turn`
4. 310 ms inbox mtime gap (Windows poll)
5. `BattlescapeGame::tickCompanionCommand(true)` → admission → native executor → terminal `tactical-result.json` + journal

## Evidence (commands run)

```text
MSBuild .../companion_medikit_engine_test.vcxproj /p:Configuration=Release
MSBuild .../companion_command_test.vcxproj /p:Configuration=Release
.../companion_medikit_engine_test.exe
.../companion_command_test.exe
node --test companion/m0-publish/test/tactical-command-m1-wp9-medikit-s*.test.cjs
```

### C++ `companion_medikit_engine_test.exe`

| Suite | Result |
|-------|--------|
| S2 direct HEAL / STIMULANT / PAINKILLER / rejects | **PASS** |
| Relay `STALE_STATE_VERSION` | **PASS** — REJECTED, no wound/charge/TU mutation |
| Relay wrong hand | **PASS** — `MEDIKIT_NOT_IN_HAND` |
| Relay depleted charge | **PASS** — `MEDIKIT_CHARGE_DEPLETED` |
| Relay insufficient TU | **PASS** — terminal reject; see gap note below |
| Relay hostile target | **PASS** — `PROHIBITED_TARGET` |
| Relay HEAL co-tile | **PASS** — COMPLETED; wound cleared; charge −1; `tu_spent` 10; `target_unit_id` 2; journal |
| Relay STIMULANT co-tile | **PASS** — COMPLETED; stun reduced; charge −1; `target_revived` JSON boolean present; revival asserted via flag **or** patient no longer unconscious |
| Relay PAINKILLER co-tile | **PASS** — COMPLETED; morale effect; charge −1 |
| Relay adjacent HEAL | **PASS (bounded)** — native `MEDIKIT_APPLICATION_FAILED` in sparse 6×6 harness; asserts no double-spend if rejected |
| Duplicate `command_id` replay | **PASS** — second tick preserves wound/charges/TU and identical terminal result JSON (no second apply) |

Exit: **0** — `All companion medikit engine tests passed.`

### Node

| File | Result |
|------|--------|
| `tactical-command-m1-wp9-medikit-s1.test.cjs` | **8/8 PASS** |
| `tactical-command-m1-wp9-medikit-s3-relay.test.cjs` | **3/3 PASS** |
| `tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs` | **2/2 PASS** (includes engine subprocess) |

### `companion_command_test.exe`

**All tests passed** (WP9 medikit parse/validate; `BATTLE_BUSY` preflight only).

## Result payload notes (success path)

- `target_revived` on COMPLETED HEAL/STIMULANT is a **JSON boolean** (`true`/`false` without string quotes). Harness assertions use substring checks, not `extractJsonStringField`.
- Relay STIMULANT may report `target_revived: false` while still waking the patient via native `stimulant()` before `companionMedikitRecordRevive` bookkeeping — S2 direct path can still set `targetRevivedOut=true` for the same YAML. Certification accepts **either** `target_revived: true` **or** conscious patient status after COMPLETED.

## Remaining gaps (not blocking S4B bounded cert)

| Gap | Status |
|-----|--------|
| `BATTLE_BUSY` with real `_states` animation stack | **Unverified** — `BATTLE_BUSY` rejected only in `companion_command_test` preflight |
| Off-co-tile / facing-adjacent HEAL success on sparse map | **Unverified success** — harness observes `MEDIKIT_APPLICATION_FAILED`; co-tile success and S2 melee cases cover native apply |
| Insufficient TU at relay | **Partial** — preflight may accept; terminal `MEDIKIT_APPLICATION_FAILED` observed (same pattern as S4 audit); wound/charge unchanged on reject paths that fail at validation |
| `CompanionSnapshot::tryExport` SEH hardening | **Deferred** — not added in WP9 |
| Full mission / save-game playthrough | **Out of scope** (per task) |

## Changed files (this delivery)

| Path | Change |
|------|--------|
| `engine/OpenXcom/src/test/companion_medikit_relay_e2e_harness.cpp` | `STR_GROUND` registration; export → publication-confirm → inbox → tick; full E2E suite; duplicate + success assertions |
| `engine/OpenXcom/src/test/companion_medikit_engine_test.cpp` | Default `runMedikitRelayE2eSuite()` after S2; removed S4A success probe path |
| `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` | Removed temporary `relayMedikitTraceStep` diagnostics (S4A) |
| `companion/m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-S4B-SUCCESS-CERT-01.md` | This audit |

## Release recommendation

**Recommend:** WP9 medikit relay **success path** is certified for Release **within stated bounds** — HEAL/STIMULANT/PAINKILLER complete inbox → tick → terminal JSON with charge/TU/target identity checks, rejection suite preserved, duplicate idempotency verified. **Do not** treat adjacent-tile HEAL success or live `BATTLE_BUSY` as certified until follow-up fixtures land.

**No** runtime pin change, deploy, or commit in this stop — owner review only.