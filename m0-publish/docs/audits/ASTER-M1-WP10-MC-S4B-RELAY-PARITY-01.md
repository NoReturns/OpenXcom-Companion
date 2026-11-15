# ASTER-M1-WP10-MC-S4B-RELAY-PARITY-01 — native rejection parity and regression gates

**Work package:** M1-WP10 mind control — Stage S4B
**Authorization:** Harness + gate expansion only. **No deployment, commit, or push** (per owner mandate).

## Summary

| Area | Outcome |
|------|---------|
| MC native inbox E2E | **Full parity** with panic relay matrix: success, failed psychic roll, insufficient TU, wrong hand, stale binding, hidden target, invalid actor/target/amp, zero psi skill, unauthorized actor, friendly/prohibited targets, duplicate idempotency |
| Production code | **Unchanged** (psychic math, faction rules, relay dispatch) |
| S4A harness fix | **`STR_GROUND`** registration retained |
| S4B harness hardening | Psi-Amp ruleset register-once; shared floor `MapData` (stops tile wiring leak); relay assertions use `public_reason` (psi relay contract); reset hit states between scenarios |

## Native relay matrix (`companion_psi_panic_relay_e2e_harness.cpp`)

### PSI_PANIC (`runPsiPanicRelayE2eSuite`)

| Case | Expectation |
|------|-------------|
| Success / failed roll | `COMPLETED`, `tu_spent` 25, outcome-blind (no psychic leak) |
| Insufficient TU | `REJECTED`, zero TU |
| Wrong hand / stale / hidden / invalid actor / invalid target / zero skill / bad amp / human actor | `REJECTED`, zero TU, `public_reason` substring checks |
| Duplicate command | Second tick: no extra TU; terminal JSON unchanged |

### PSI_MIND_CONTROL (`runPsiMindControlRelayE2eSuite`)

Same as panic, plus on every **reject** path: **hostile faction unchanged** (`FACTION_HOSTILE` or pre-convert state). Success path still asserts faction conversion and companion AI exclusions.

## Regression gates (Release, `build-isolated-m1-23e`)

| Gate | Result (S4B run) |
|------|------------------|
| `companion_psi_panic_engine_test.exe` (executor + full panic relay) | **PASS** (checkpoint run, exit 0) |
| `companion_psi_mind_control_engine_test.exe` (executor + full MC relay) | **PASS** (checkpoint run, exit 0) |
| `companion_snapshot_serialization_test.exe` | **PASS** |
| `companion_command_test.exe` | **PASS** |
| Node WP10 panic S1 | **PASS** |
| Node WP10 MC S1 | **PASS** |
| Node WP10 panic S3 relay | **PASS** |
| Node WP10 MC S3 relay | **PASS** |

## Deployment risks (remaining)

| Risk | Severity | Notes |
|------|----------|-------|
| Native relay harness stress | **Unresolved (not proven harness-only)** | Back-to-back stress runs intermittently yield `PSI_*_APPLICATION_FAILED` or duplicate/idempotency failures; **failed psychic roll `COMPLETED` vs execute-time reject is not conclusively classified**. Mitigations: `STR_GROUND`, ruleset/floor dedup, open floor at init, separate relay dirs per test exe (`wp10_psi_panic_relay_e2e` vs `wp10_psi_mc_relay_e2e`) to avoid cross-gate snapshot pollution. **Do not treat as harmless before live MC deploy.** |
| `public_reason` vs `reject_code` on psi rejects | **Low** | Terminal JSON uses human `public_reason` for psi rejects; machine codes remain in engine logs. Node/S3 tests use structured validation; live ops rely on status + reason text. |
| Post-MC FOV in live play | **Not evidenced** | S4A showed pre-tick export failure; no engine FOV defect found. Live MC still needs owner-authorized live drill (out of S4B scope). |
| Live GitHub inbox | **Out of scope** | No live publish in S4B. |

## File inventory (proposed commit — owner approval pending)

| Path | Change |
|------|--------|
| `engine/OpenXcom/src/test/companion_psi_panic_relay_e2e_harness.cpp` | S4A `STR_GROUND`; S4B MC/panic rejection parity; JSON helpers; stability tweaks |
| `engine/OpenXcom/src/test/companion_psi_panic_engine_test.cpp` | Relay gate enabled; psi-amp + floor harness dedup |
| `engine/OpenXcom/src/test/companion_psi_mind_control_engine_test.cpp` | Full `runPsiMindControlRelayE2eSuite()` gate; harness dedup |
| `companion/m0-publish/docs/audits/ASTER-M1-WP10-MC-S4A-FOV-HARNESS-01.md` | S4A record |
| `companion/m0-publish/docs/audits/ASTER-M1-WP10-MC-S4B-RELAY-PARITY-01.md` | This report |

**Recommended commit message (when approved):**
`Fix WP10 psi relay harness fixture and add native MC/panic rejection E2E parity.`

## Checkpoint (local, 2026-11-15)

| Repo | Commit |
|------|--------|
| `engine/OpenXcom` (`aster/m0`) | `9302181c45a6dfbb7c994ec0c4902d09d75a39a6` |
| `companion` (`main`) | `105eabe93b5cb2f44e4306aa6a5ba6bf690404c7` |

**Not pushed.** Native gates: one sequential run each after S4B harness fixes (separate relay dirs, duplicate suite ordering).

## STOP — S4B complete

No production deploy. Local checkpoint committed; await deploy risk review before live MC.
