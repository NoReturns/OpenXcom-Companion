# ASTER-M1-RELAY-HUD-DEPLOY-02

**Date:** 2026-11-14  
**Objective:** Validate gates, deploy A3 relay HUD fix + preserve prefire accuracy export.

---

## Pre-deployment gates

| Gate | Result | Evidence |
|------|--------|----------|
| `last_command_reject_code` bound to command id; no carryover | **PASS** | `resolveRetrieveCommandOutcome` correlates by `command_id`; new test `last_command_reject_code does not carry over to a newer completed command write` |
| Node status JSON → C++ HUD parse | **PASS** | `parseRelayStatusJson` reads `last_command_reject_code`; `companion_on_demand_relay_test` JSON label cases |
| Narrow regression added | **PASS** | Carryover test + existing A3 label tests |
| Prefire + A3 source present | **PASS** | Engine HEAD `5f9e67453` (prefire export); companion uncommitted A3 relay HUD changes atop `c34c405` |

---

## Focused test results

| Suite | Result |
|-------|--------|
| Node `m1-retrieve-label-semantics` + `m1-status-lifecycle` | **29** pass, **0** fail |
| C++ `companion_on_demand_relay_test.exe` | exit **0** |
| C++ `companion_snapshot_serialization_test.exe --prefire-only` | exit **0** (includes snapshot `displayedFiringAccuracy` harness) |

---

## Build and deployment

| Field | Value |
|-------|--------|
| Build | Win32 **Release** `Rebuild` — `build-isolated-m1-23e/src/openxcom.vcxproj` |
| Build exe | `engine/OpenXcom/build-isolated-m1-23e/bin/Release/openxcom.exe` |
| **Deployed SHA-256** | `8bb612ff1b19f5c4aed053786e8652feb023d18f8173d5ef3ae7c02b3b61c08b` |
| Size | 4,297,728 bytes |
| Canonical runtime | `runtime/m0/bin/openxcom.exe` (promoted 2026-11-14T20:32:38Z) |
| Rollback backup | `runtime/m0/bin/openxcom.exe.backup-20261114-153238` (prior `06701492…`) |

### Binary verification (spot checks)

- String present: `Invalid active hand`, `last_command_reject_code`, `INVALID_ACTIVE_HAND` (via `findstr` on `openxcom.exe`)
- `verify-deploy-hash-gate.cjs`: `deployScriptHashGateOk: true`, `assessDeployReadiness.ok: true`

### Canonical pin

| Location | SHA-256 |
|----------|---------|
| `companion/m0-publish/lib/companion-canonical-runtime.cjs` `VERIFIED_BUILD_SHA256` | `8bb612ff…` |
| `runtime/m0/bin/openxcom.deploy-manifest.json` | `8bb612ff…` (matches runtime exe) |

`runtime/m0/README-companion-runtime.md` updated locally (workspace not a git root).

---

## Daemon restart

| Check | Result |
|-------|--------|
| OpenXcom running | **No** (deploy refused if running — satisfied) |
| Daemon restarted | **Yes** — PID **14132**, `state: ready` in `local/m0/.companion-on-demand-daemon-health.json` |
| Method | `node companion-on-demand-relay-daemon.cjs --snapshot-path local/m0/tactical-live.yaml` with `COMPANION_PLAY_SESSION_GAME_GATE=0` (no game; no SEND/RETRIEVE) |
| GitHub quota line | health OK |

**Note:** Production launcher binds daemon to a live game session; standalone restart used game-gate bypass only for post-deploy Node code verification.

---

## Source-control checkpoint

*(Filled after commits/push in this pass — see git output below.)*

---

## Outstanding live verification

1. Battlescape HUD: deliver `INVALID_ACTIVE_HAND` command and confirm overlay shows **Invalid active hand** (not generic **Order rejected**).
2. Next launcher start: confirm single daemon under play-session lease (without `COMPANION_PLAY_SESSION_GAME_GATE=0`).
3. Commit `runtime/m0/README-companion-runtime.md` if/when workspace packaging adds a tracked repo for `runtime/`.

---

## Constraints observed

- No active mission / no running `openxcom.exe` replaced during play.
- No SEND, RETRIEVE, or tactical command execution during verification.
- No unrelated gameplay or relay architecture changes.