# M1-34G Step 4 — Controlled restart execution report

**Executed:** 2026-11-04 (local)  
**Authorization:** Step 4 execution orders (controlled restart; no recovery RETRIEVE)

---

## 1. Test environment fix

**Action:** Removed `COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE` for the test invocation (was **`1`** in the shell environment).

**Results:**

| Suite | Pass / Fail |
|-------|-------------|
| `companion-on-demand-relay-m1-31.test.cjs` | **9 / 9** |
| `companion-on-demand-relay-m1-31e.test.cjs` | **17 / 17** |
| **Total** | **26 / 26** |

Assertions unchanged. Failures in Step 3 preflight were **environmental** (`COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE=1`).

---

## 2. Passive startup verification (code + behavior)

**On-demand production daemon does not run continuous command-relay polling.**

- `createOnDemandRelayDaemon` only schedules `processPendingRequest` on a timer (`companion-on-demand-relay.cjs`).
- `createTacticalRelaySidecar` builds `CommandRelayWatcher` but **`commandWatcher.start()` is not called** (only `startTacticalRelaySidecar` starts polling).
- GitHub I/O occurs only when `processPendingRequest` dequeues a request with **`status: "pending"`**.

**Stale / completed request:**

- Pre-restart: `companion-on-demand-request.json` had **`status: "completed"`**, action `retrieve`.
- `processPendingRequest` returns `{ processed: false }` unless status is **`pending`**.

**Restart did not auto-resume `2b737d84…`:**

- No new lines in `companion-on-demand-relay-transactions.jsonl` after restart (last transaction `at_ms` unchanged: **1793829915518**).
- Production journal SHA unchanged.
- GitHub result SHA unchanged.

**Conclusion:** Passive startup **safe** for restart-only; recovery still requires an explicit new **pending** RETRIEVE.

---

## 3. Pre-stop fingerprints (captured before stop)

Saved: [`M1-34G-step4-baseline-before.json`](M1-34G-step4-baseline-before.json)

| Surface | Identity |
|---------|----------|
| **Journal SHA-256** | `19786E959CC191C1813578BF40175C3DD6CE99889014A7432566222D9F048FA7` |
| **GitHub command** | absent (404) |
| **GitHub result SHA** | `e65799c6af4b4748ce2dfea9568437e4f084fc36` (REJECTED / `2b737d84…`) |
| **Local command SHA** | `DD4F99BB988944AE621C293FAFD5C3B6C0DD955E77BAB6E6E708AC462482AAAE` |
| **Local result SHA** | `05C3BF295B6ED8B2F294748A67DC394C3CD6D269557935EAA8852F950BB51681` |
| **Request SHA** | `6DB2C8B9B5B62695FA674FC8DA7C13149667D4416F688ABD1D6EBC0C49355A4A` (completed retrieve) |
| **Status SHA** | `9E33F3ED316DBCE59325CCB343F888E273BEE178A7BF3170EC070F744BD9330E` |

**Daemon before stop:**

| Field | Value |
|-------|--------|
| PID | **16048** |
| Ownership token | `42260c03402401b03329cfb408d2c98e` |
| Health | `ready` |

---

## 4. Controlled stop / start

**Stop:** `process.kill(16048, 'SIGTERM')` — supported daemon shutdown path (`companion-on-demand-relay-daemon.cjs` SIGTERM handler → `recordExit` → ownership release).

- **16048 confirmed not running** after ~4s.
- **Note:** `.companion-on-demand-daemon-health.json` briefly retained stale `pid: 16048` until the new daemon rewrote health (Windows SIGTERM cleanup timing).

**Start:** `startOnDemandDaemonVerified` with production `local/m0/tactical-live.yaml`, **no** isolation config, owner label `m1-34g-step4-restart`.

| Field | Value |
|-------|--------|
| New PID | **8332** |
| `startedByUs` | true |
| Health | `ready`, **healthy** |

---

## 5. Post-restart readiness

| Check | Result |
|-------|--------|
| Production-path daemons | **One** PID **8332** |
| `assessOnDemandDaemonHealth` | **healthy**, no split-brain on production snapshot |
| Ownership | PID **8332**, token `ed3d7310148f332bdadada322f46e64b`, owner `daemon` |
| Request processing | **None** — request still `completed` |
| Orphan test PIDs 16532 / 11980 | **Still running** (left alone per orders); **not** on production snapshot path |
| Unrelated termination | **None** — only **16048** stopped intentionally |

---

## 6. Fingerprint comparison (post-restart)

`assertProductionIntegrityUnchanged(before, after)` → **PASS**

| Surface | Changed? |
|---------|----------|
| Command relay journal | **No** |
| Local relay JSON watchlist | **No** |
| GitHub command / result SHAs | **No** |

**Expected marker churn (not part of integrity guard):** pid, ready, health, ownership, lifecycle files updated for PID **8332**.

---

## 7. Recovery RETRIEVE

**Still not executed.** Production daemon now runs **M1-34G** code in memory (PID **8332**). Authorized next step when HOLD lifted: single **pending** recovery RETRIEVE per design doc Phase C.

---

## Operator reminders

1. Unset **`COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE`** in shells used for companion/daemon **and** tests.
2. Production daemon is **8332**, not **16048**.
3. Do not treat a **`completed`** request file as pending work.
