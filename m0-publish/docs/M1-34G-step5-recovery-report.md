# M1-34G Step 5 — Controlled production recovery (complete)

**Request ID:** `f631285351a82251c313935e9b6e0640`  
**Daemon PID:** **8332** (M1-34G code)  
**Command:** `2b737d8422bef12932d4586140b9abf7`  
**Outcome:** **PASS** (single transaction, no retry)

Artifacts:

- Before: [`M1-34G-step5-recovery-before.json`](M1-34G-step5-recovery-before.json)
- After: [`M1-34G-step5-recovery-after.json`](M1-34G-step5-recovery-after.json)

---

## Preflight (immediate before enqueue)

| Check | Result |
|-------|--------|
| Sole healthy production daemon **8332** | **OK** |
| Journal `delivered_local` for `2b737d84…` | **OK** |
| Local result **FAILED** | **OK** |
| GitHub inbox **404** | **OK** |
| GitHub result **`e65799c6…`** REJECTED | **OK** |
| No **pending** request | **OK** (prior request `completed`) |
| Competing **publish-tactical-once** watchers | **OK** (none; launcher scan clean) |

---

## Authorized operation

Enqueued **one** pending `retrieve` via `local/m0/companion-on-demand-request.json`. Daemon **8332** processed within ~2.5s.

**Event order (transaction trace):**

1. `internal_poll_start`
2. **`remote_result_published`**
3. **`remote_command_marked_retired`** (inbox already absent — no DELETE)
4. `retrieve_disposition` → **completed**

---

## Required evidence

| Verification | Required | Actual |
|----------------|----------|--------|
| `deliverLocal` | 0 | **0** |
| Engine result | FAILED unchanged | **FAILED**, local SHA unchanged (`05C3BF29…`) |
| GitHub result | FAILED, same command | **FAILED**, `2b737d84…`, SHA **`58e2414f7ca83d12791e501c4b26c5b226511cfe`** |
| GitHub inbox | absent | **404** |
| Remote command DELETE | 0 | **0** (`remote_command_retired` **0**, `remote_command_marked_retired` **1**) |
| Journal | `retired_remote`, `active: null` | **OK** — `remote_retired_at` **2026-11-04T23:26:03.321Z** |
| Transaction | `completionKind: engine_reported` | **OK** |
| UI | completed after publish + retire | **OK** — phase **`completed`**, message **Retrieve complete.** |
| Saved mission | unchanged | **OK** — `tactical-live.yaml` SHA unchanged |
| Additional RETRIEVE | 0 extra | **1** total recovery transaction only |

---

## Fingerprints (post-recovery)

| Surface | Before | After |
|---------|--------|--------|
| **Journal SHA-256** | `19786E959CC191C1813578BF40175C3DD6CE99889014A7432566222D9F048FA7` | **`8E8419CB95C01D110219EFD5C47D3C13243AAAEE061FBD78ED96DBBDBE89418D5`** |
| **GitHub result SHA** | `e65799c6af4b4748ce2dfea9568437e4f084fc36` (REJECTED) | **`58e2414f7ca83d12791e501c4b26c5b226511cfe`** (FAILED) |
| **GitHub command** | absent | **absent** |
| **Local result file** | `05C3BF29…` | **unchanged** |
| **Saved mission** | unchanged | **unchanged** |

---

## Incident evidence preserved

- Prior REJECTED cooperative payload remains in **Git history** at blob **`e65799c6…`** (documented in [`docs/incident/M1-34F-github-evidence.json`](incident/M1-34F-github-evidence.json)).
- M1-34F narrative and Step 3–4 baselines remain valid historical records.

---

## Boundaries respected

- No gameplay resume, no new MOVE/FIRE, no inbox restore, no second production transaction.
- Request file removed after completion (no pending queue entry).

**Cooperative gameplay HOLD:** unchanged by this step — separate decision per Commander.
