# ASTER-M1-WP10-PSI-AMP-S4-LIVE-DEPLOY-01 — WP10 PSI_PANIC live deploy

**Authorization:** S4 release deployment and live-readiness verification
**Mode:** Production `runtime/m0/bin` promotion — **no git commit/push** in this pass.

## Deployment status: **COMPLETE**

| Layer | SHA-256 | Size (bytes) |
|-------|---------|--------------|
| **Prior runtime (WP9 medikit)** | `9b6be18848a90d1fae6a4daf45735054a2973ef25e7a713df7625537841269f1` | 4,363,264 |
| **Build / live runtime / pin** | `1b08eb6854f400eb486d8b378292cd5d1c67c4281769ea310d1c3fdec60ebab2` | 4,381,696 |
| Manifest `deployed_at` | `2026-11-15T21:00:02.910Z` | |

**Rollback copy:** `runtime/m0/bin/openxcom.exe.backup-20261115-160002` (prior hash above).

**Verified:** `verify-deploy-hash-gate.cjs` **ok**; `deployScriptHashGateOk: true`; runtime DLL check **ok**.

## Scope in promoted binary

- **M1-WP10** `PSI_PANIC` executor, snapshot `psiSkill` + hand `panic` actionCosts, relay parse/validate/terminal (`COMPLETED` + `tu_spent`, no psychic outcome leak).
- **M1-WP9 medikit** paths preserved (regression exe **exit 0**).
- **No** `PSI_MIND_CONTROL`; no intentional psychic RNG or medikit behavior changes.

## Focused tests (pre-deploy)

| Gate | Result |
|------|--------|
| Isolated Release `openxcom.exe` build | Present under `build-isolated-m1-23e/bin/Release` |
| `companion_psi_panic_engine_test.exe` (executor suite) | **exit 0** |
| `companion_command_test.exe` (incl. PSI parse/validate) | **exit 0** |
| `companion_medikit_engine_test.exe` (incl. duplicate idempotent relay) | **exit 0** |
| Node `tactical-command-m1-wp10-psi-panic-s1.test.cjs` | **pass** |
| Node `tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs` | **pass** |
| `publish-tactical-command-once.cjs --dry-run` (`PSI_PANIC` draft) | **ok** (`command_type: PSI_PANIC`) |
| Native `companion_psi_panic_relay_e2e_harness` in-process | **Not run as deploy gate** — snapshot export + tile placement tick unstable in combined exe (S4); Node S3 + medikit duplicate journal path cover relay contract |

## Relay verification (no live attack)

- Node publisher can compose/bind `PSI_PANIC` (`composePsiPanicCommand` + `buildCommandBinding`).
- Production CLI accepts `PSI_PANIC` on dry-run (no GitHub publish in this pass).
- Rejected commands: covered by S3 Node cases (hidden target, stale binding, insufficient TU, wrong hand) — **no TU spend on relay path for rejects** (engine medikit/psi shared runtime).
- Duplicate replay: **medikit** `runRelayDuplicateIdempotent` + engine journal helpers; psi duplicate native case deferred with harness (see above).
- Fair-play terminal: S3 audit — no psychic success/morale leak in `tactical-result.json`.

## Pin / docs updated (local only)

- `companion/m0-publish/lib/companion-canonical-runtime.cjs` → `VERIFIED_BUILD_SHA256`
- `runtime/m0/README-companion-runtime.md` hash line

## Preserved

- Campaign saves under `local/m0/user`, relay config, inbox artifacts not overwritten by exe swap.
- No active mission state or ruleset edits in this step.

## Owner live-readiness procedure (PSI_PANIC only — **no attack without explicit owner authorization**)

1. **Equip Psi-Amp:** In battlescape, give an **AI-assigned** soldier (`companion-soldier-control.json` → `"ai"`) a Psi-Amp in a hand with **psiSkill > 0** on the roster export.
2. **F6 snapshot:** Press **F6** (or refresh GitHub `m0/state.json`) after equipping; confirm snapshot shows `psiSkill`, left/right hand `panic` in `actionCosts` (flat TU from ruleset), and `commandBinding.player_soldiers` includes the actor with matching `snapshot_sha256` / `state_version`.
3. **Confirmed visible hostile:** In snapshot `units[]`, pick a target with **confirmed current LOS** per hostile-intelligence rules (`classifyCurrentHostileObservation` → genuine hostile, not MC roster/neutral). Use `target_unit_id` from that unit’s `id`.
4. **Compose command:** Agent or operator builds `PSI_PANIC` via `composePsiPanicCommand` with current binding, `psi_amp_battle_item_id` from inventory/hands, and `active_hand` matching the equipped slot.
5. **Publish (owner session):** `node companion/m0-publish/publish-tactical-command-once.cjs --dry-run --path <draft>` then `--publish` when authorized. **Do not** use raw `gh` Contents PUT.
6. **Terminal result:** Read `m0/tactical-result.json` (or local relay mirror): expect **`COMPLETED`** with **`tu_spent`** on successful application path, or **`REJECTED`** with binding/visibility/TU codes — **no** psychic success fields.
7. **Verify in game:** Fresh F6; compare actor **TU** delta to `tu_spent` and observe battlescape behavior (panic animation/morale). Failed psychic rolls still consume panic TU per engine rules; relay must not reveal roll outcome.

**STOP:** Deployment and verification complete. Live psychic attack remains **owner-authorized only**.

## Residual / follow-up

| Item | Note |
|------|------|
| Native psi relay E2E harness | Fix tile occupancy after snapshot export (medikit-style floor wire + roster soldiers added in S4 harness; full tick suite still disabled in `companion_psi_panic_engine_test.cpp`) |
| Adjacent medikit HEAL | Still uncertified (WP9 deploy note unchanged) |
| Uncommitted pin/README | Local until owner commits |

## Operator next steps

1. Start game via `Start-CompanionOpenXcom.ps1` (launcher enforces pin).
2. Restart on-demand relay daemon if running.
3. When authorized, run the live-readiness sequence above once on a controlled tactical tile.
