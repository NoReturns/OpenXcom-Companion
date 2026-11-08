# M1-34G Step 3 — Production recovery readiness (read-only preflight)

**Date:** 2026-11-04 (local)  
**Scope:** Read-only inspection only. **PID 16048 not restarted.** **No RETRIEVE.** **No GitHub writes.**

---

## Executive summary

| Question | Finding |
|----------|---------|
| Is PID 16048 on M1-34G code? | **No.** Process started **16:21:24**; M1-34G sources last modified **18:16–18:17**. Node retains modules loaded at startup. |
| Controlled restart before recovery? | **Yes — required** to load M1-34G recovery/completion behavior (and post-incident bind fixes if not reloaded since 16:21). |
| M1-31 / M1-31E failures unrelated? | **Not dismissible without caveat.** Failures are **reproducible** with **`COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE=1`** in the environment (confirmed on this machine). That disables healthy-daemon reuse and causes second spawns → split-brain → `ok: false`. This is **test-harness environment**, not production UI defaults — but it must be unset (or tests run in a clean env) before trusting reuse tests as a gate. |
| GitHub inbox / result? | Inbox **404**; result blob **`e65799c6…`** is **REJECTED** / `SIDECAR_VALIDATION` for **`2b737d84…`**. |
| Production journal / local FAILED? | **Unchanged** expected fingerprint; **`delivered_local`** + **`active`**; local **FAILED** authoritative. |
| Recovery race risk? | **One** production daemon on `local/m0` snapshot; **two orphan test daemons** on temp paths (leaked from tests); **no** legacy `publish-tactical-once` watchers found. Orphan PIDs do **not** share production snapshot path but add noise to global process scans during tests. |

---

## 1. PID 16048 — implementation generation

| Field | Value |
|-------|--------|
| PID | **16048** |
| Started | **2026-11-04 16:21:24** (local) |
| Command | `node companion-on-demand-relay-daemon.cjs --snapshot-path E:\Open X-Com Companion\local\m0\tactical-live.yaml` |
| Isolation flags | **None** (production surface; expected) |
| Health | `state: ready`, `pid: 16048` (`.companion-on-demand-daemon-health.json`) |
| Ownership | `42260c03402401b03329cfb408d2c98e`, owner `daemon` |

**Source vs process:**

| File | LastWriteTime (local) | Newer than 16048 start? |
|------|-------------------------|-------------------------|
| `command-relay-watcher.cjs` | 18:17:07 | **Yes** |
| `companion-on-demand-relay.cjs` | 18:17:11 | **Yes** |
| `relay-transaction-trace.cjs` | 18:17:02 | **Yes** |
| `relay-isolation-config.cjs` | 18:16:55 | **Yes** |
| `github-relay.cjs` | 18:16:59 | **Yes** |
| `companion-on-demand-relay-daemon.cjs` | 18:17:11 | **Yes** |

**Conclusion:** Phase C cannot assume M1-34G behavior on 16048. **Controlled restart** after HOLD lift is **mandatory** unless operator explicitly accepts running recovery on stale code (not recommended).

**What 16048 likely still has in memory:** Pre–M1-34G `isRetrieveEndToEndComplete` (no `completionKind` gate), no `relayIsolationContract` (irrelevant for production daemon), and any fixes landed on disk after **16:21** (including M1-34G and possibly post–M1-34F bind hardening) are **not** active in this process.

---

## 2. M1-31 / M1-31E test failures — evidence

### Reproduction (read-only diagnostic, temp snapshot)

Second `startOnDemandDaemonVerified` after a successful first start returned:

```text
ok: false
error: On-demand relay daemon exited during startup (see companion-on-demand-daemon-diagnostics.jsonl).
```

Diagnostics tail showed:

- `spawn_started` (second spawn)
- `daemon_deferred_to_owner` / `existing_live_owner` / **`split_brain: true`**
- `startup_failed` / `exited_before_ready`

### Root cause on this machine

Environment variable:

```text
COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE=1
```

With this set, `liveDaemonReuseAllowed()` is **false** (`on-demand-daemon-process.cjs`). Even when `assessOnDemandDaemonHealth()` reports **`healthy: true`**, the early reuse branch at startup is skipped, a **second daemon is spawned**, ownership defers the child, and the launcher reports failure.

This explains:

- `m1-31.test.cjs` — `second.ok === false` (line 106)
- `m1-31e.test.cjs` — `second.reused === undefined` (line 122)
- `m1-31e.test.cjs` test 14 — same reuse path unless `listProcesses` is injected (that test passes `deps.listProcesses` but still runs under `NO_LIVE_REUSE=1` for live reuse gate)

**Not inferred:** verified by tracing `liveDaemonReuseAllowed` → **false** with current env.

### Interaction with production

Production daemon **16048** was **not** started under `node --test`. Game/launcher paths typically do **not** set `COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE=1`. Production **reuse** of 16048 via `ensureOnDemandDaemonRunning` should still work **if** that env var is unset in the launcher process.

**Recommendation before HOLD lift:**

1. Run reuse tests with `COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE` **unset** (or `=0`) and confirm M1-31/M1-31E green.
2. Kill **orphan test daemons** (below) so global scans are clean during verification.

---

## 3. GitHub cooperative surface (read-only)

| Path | Status |
|------|--------|
| `m0/tactical-command.json` | **404 Not Found** (inbox absent) |
| `m0/tactical-result.json` | **Present**, SHA **`e65799c6af4b4748ce2dfea9568437e4f084fc36`** |

Decoded live result (authoritative read-only):

- `command_id`: **`2b737d8422bef12932d4586140b9abf7`**
- `status`: **`REJECTED`**
- `sidecar_reject_code`: **`SIDECAR_VALIDATION`**
- `public_reason`: `snapshot_sha256 mismatch`

Matches incident narrative; **incorrect** cooperative record vs engine **FAILED**.

---

## 4. Production journal and local engine

### Command relay journal

| Field | Value |
|-------|--------|
| Path | `companion/m0-publish/.command-relay-sidecar-state/command-relay-journal.json` |
| SHA-256 | **`19786E959CC191C1813578BF40175C3DD6CE99889014A7432566222D9F048FA7`** |
| Bytes | **29643** |
| `active.command_id` | **`2b737d8422bef12932d4586140b9abf7`** |
| Record phase | **`delivered_local`** |
| `remote_sha256` | **`e1f2fb54b86d38183922de0cba2aaeb722882860`** |

### Local tactical result (authoritative engine)

| Field | Value |
|-------|--------|
| `command_id` | **`2b737d8422bef12932d4586140b9abf7`** |
| `status` | **`FAILED`** |
| `destination_reached` | **`true`** |
| `snapshot_sha256` | **`06b9b14e5a6787f8f5432f64013910e71250d0b9df5054dc6b8098dbaf5aee7e`** |

### Local tactical command (inbox)

| Field | Value |
|-------|--------|
| Present | **Yes** |
| SHA-256 | **`DD4F99BB988944AE621C293FAFD5C3B6C0DD955E77BAB6E6E708AC462482AAAE`** |

### On-disk request queue

`local/m0/companion-on-demand-request.json` — last entry **`retrieve`**, status **`completed`** (no pending RETRIEVE).

---

## 5. Processes that could race recovery

| PID | Role | Snapshot path | Risk to production RETRIEVE |
|-----|------|---------------|-----------------------------|
| **16048** | Production on-demand daemon | `local/m0/tactical-live.yaml` | **Owner** — only process that should handle recovery request |
| **16532** | Orphan test daemon (`--dry-run`) | `%TEMP%\m1e4-…\tactical-live.yaml` | **Low** — path mismatch; pollutes global daemon discovery during tests |
| **11980** | Orphan test daemon (`--dry-run`) | `%TEMP%\e4-…\tactical-live.yaml` | **Low** — same |
| Legacy `publish-tactical-once` | Briefing/command-relay watch | — | **None found** at preflight time |

Production diagnostics previously logged **`split_brain: true`** with PIDs **`[16048, 18776]`** — investigate if **18776** still exists before recovery (not seen in latest narrow scan; may have exited).

**Race rule:** Only **one** daemon with production `--snapshot-path` may process `companion-on-demand-request.json`. Do not enqueue RETRIEVE while another launcher is spawning a second production daemon.

---

## 6. Controlled restart procedure (when HOLD lifted — not executed in Step 3)

### Preconditions

1. Capture read-only baseline (this document + journal SHA + GitHub result SHA + local JSON SHAs).
2. Confirm **no** `pending` row in `companion-on-demand-request.json`.
3. Unset **`COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE`** in any shell used to launch companion/daemon.
4. Optional: terminate **orphan** temp daemons **16532** / **11980** (not production 16048) to clean test noise.

### Restart sequence (production snapshot only)

1. **Stop 16048** via companion’s normal shutdown path **or** `stopProcessTree(16048)` **only after** confirming ownership record PID matches 16048 and no pending request.
2. Verify markers: ownership/pid/ready cleared or stale-safe per `clearStaleOwnershipIfSafe`.
3. **Start** daemon from **current** tree (post–M1-34G), same args:
   - `--snapshot-path E:\Open X-Com Companion\local\m0\tactical-live.yaml`
   - **No** `--relay-isolation-config` (production).
4. Confirm new PID, fresh `daemon_ready`, health **`ready`**, **single** live process for production snapshot path.
5. **Do not** RETRIEVE until step 4 passes.

### Rollback checks after restart (still before RETRIEVE)

- Journal SHA **unchanged** from **`19786E959CC…`** until authorized recovery RETRIEVE.
- GitHub command **404**, result **`e65799c6…`** unchanged.
- Local FAILED result SHA unchanged.

If restart alone changes journal or GitHub, **stop** and investigate before RETRIEVE.

### After restart — authorized recovery (Phase C, future)

Single pending **`retrieve`** on `local/m0`; new daemon processes with M1-34G code; verify FAILED publish + `retired_remote` per isolated N5 proof.

---

## 7. Gates before lifting HOLD

| Gate | Status |
|------|--------|
| M1-34G isolated tests green | **Pass** (prior Step 2 run) |
| M1-31 reuse tests green | **Blocked on this env** until `COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE` unset |
| Production daemon on M1-34G code | **Fail** — restart required |
| GitHub / journal / local FAILED identities | **Match** expected inconsistent pre-recovery state |
| Preflight restart executed | **No** (per orders) |

---

## 8. Operator note on Phase C wording correction

**Incorrect:** “Phase C applies unchanged to daemon 16048.”  
**Correct:** Phase C applies to the **production on-demand daemon bound to `local/m0/tactical-live.yaml`**, which **must be restarted** onto the current codebase **before** recovery RETRIEVE. PID **16048** specifically is **stale** as of this preflight.
