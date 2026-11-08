# M1-34G — Recovery design & isolation hardening (Step 1, read-only)

**Status:** Design only — no implementation, no GitHub mutation.  
**Operator decisions (accepted):** Engine **FAILED** authoritative; GitHub **REJECTED** incorrect; **no** inbox restore; **no** shared-slot restore of `3cd1c56d…`; production **RETRIEVE HOLD**; daemon **16048** untouched.

---

## 1. Problem statement

Three surfaces disagree after the M1-34F incident:

| Surface | State |
|---------|--------|
| Local engine | **FAILED**, `destination_reached: true`, full execution envelope |
| Production journal | **`delivered_local`**, `active` set, never `published_terminal` |
| Production GitHub | Inbox **absent**; result slot = **REJECTED** / `SIDECAR_VALIDATION` (wrong semantics) |

Recovery must **publish the existing engine FAILED** and **reconcile journal + retirement** without re-delivering the command and without recreating the remote inbox.

---

## 2. No-redelivery reconciliation for `2b737d842…`

### 2.1 Intended end state (acceptance)

| Layer | Target |
|-------|--------|
| GitHub `m0/tactical-result.json` | Same `command_id`, status **`FAILED`**, engine fields preserved (`destination_reached`, positions, `snapshot_sha256`, `inbox_sha256`, `completed_at`, etc.) |
| GitHub `m0/tactical-command.json` | **Absent** (already true; stay absent) |
| Production journal record | `published_terminal` → **`retired_remote`** (or `retirement_closed` with documented reason if evaluator closes on empty inbox) |
| `journal.active` | **`null`** |
| Local `tactical-command.json` | **Quarantine/archive after successful publish** (operator/script; not remote inbox recreation) |
| Local `tactical-result.json` | **Unchanged** (authoritative source for publish) |

**Traceability:** Git history retains REJECTED commit `03f06d8` and prior `3cd1c56d…` result blob `b8ef8e1…`. Recovery **overwrites** the live result slot but does not rewrite history.

### 2.2 Why RETRIEVE (when authorized) is the right vehicle

Existing code path (M1-34D / M1-34B), **no new “force publish” button required**:

1. **`CommandRelayWatcher._resumeActive`** (`command-relay-watcher.cjs` ~699–719): If `journal.active.command_id` matches local terminal result → **`publishResult(localResult, active.command_id, journal)`** without `_pollOnce` delivery.
2. **`deliverLocal` skip** (~812–814): Record `phase: delivered_local` + matching `remote_sha256` → **no second delivery** when remote command reappears (it will not — inbox absent).
3. **`publishResult`** (~255–270): **`publishRemoteResult`** PUT overwrites GitHub result (REJECTED → FAILED), journal → `published_terminal` / `status: FAILED`, `active: null`.
4. **`_maybeRetireRemoteCommand`** + **`evaluateRemoteCommandRetirement`** (`command-relay-retirement.cjs` ~78–79): Inbox empty after publish → **`mark_retired`** / `remote_command_absent` → **`_markRetiredRemote`** (journal `retired_remote`).

**No** synthetic COMPLETED. **No** remote inbox PUT. **No** manual journal patch without going through `publishResult` / retirement evaluators.

### 2.3 Preconditions (must pass before production RETRIEVE)

| Check | Rationale |
|-------|-----------|
| Production journal SHA fingerprint unchanged except via relay | Baseline from M1-34E guards |
| `active.command_id` = `2b737d84…` | Resume target |
| Record `phase: delivered_local`, `remote_sha256: e1f2fb54…` | Retirement expects journaled SHA if inbox returns; absent inbox uses `mark_retired` |
| Local result terminal **FAILED**, same `command_id` | Publish source |
| Remote inbox 404 | Confirms no delete step needed (only mark retired) |
| Remote result is REJECTED (same `command_id`) | Will be superseded by FAILED PUT — operator briefed |

### 2.4 Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Second local delivery | Blocked by `delivered_local` + empty remote inbox |
| RESTORE remote inbox | **Forbidden** by operator decision |
| `publishResult` skips publish (idempotent) | Only if remote result **already FAILED** with same status; REJECTED ≠ FAILED → full publish |
| Retirement blocked (`fail_closed`) | Preflight read `evaluateRemoteCommandRetirement` with live inputs; if blocked, **stop** — no blind journal edit |
| UI shows `completed` without engine work | Address in §4 (completion kind) |
| Overwriting `3cd1c56d…` live result again | Accept **one** corrective FAILED publish; do **not** restore old blob into slot (operator decision) |

---

## 3. Exact code paths & state transitions

### 3.1 Journal transitions (production)

```
delivered_local (active set)
  → [publishResult with engine FAILED]
published_terminal (status FAILED, active null)
  → [_maybeRetireRemoteCommand, inbox empty]
retired_remote (remote_command_absent)
```

Optional: `retirement_closed` if evaluator returns skip reasons in `RETIREMENT_CLOSE_ON_SKIP` — prefer **`retired_remote`** for clear “relay done” semantics.

### 3.2 Functions touched in **authorized production run** (existing code)

| Step | Function | File |
|------|----------|------|
| Dequeue | `processPendingRequest` → `runRetrieveOnce` | `companion-on-demand-relay.cjs` |
| Resume publish | `_resumeActive` → `publishResult` | `command-relay-watcher.cjs` |
| GitHub PUT | `publishRemoteResult` → `content.publishFile` | `tactical-relay-sidecar.cjs` → `github-relay.cjs` |
| Journal write | `markCommandRecord`, `persistJournal` | `command-journal.cjs` |
| Retirement | `_maybeRetireRemoteCommand` → `evaluateRemoteCommandRetirement` | `command-relay-watcher.cjs`, `command-relay-retirement.cjs` |
| Retrieve TX flags | `_noteRetrievePublished`, `_noteRetrieveRetired` | `command-relay-watcher.cjs` |
| UI disposition | `isRetrieveEndToEndComplete` | `companion-on-demand-relay.cjs` |

### 3.3 What **not** to do

- Edit `command-relay-journal.json` by hand to `published_terminal`.
- PUT `m0/tactical-command.json` to “restore” inbox.
- Change local result status to COMPLETED or REJECTED.
- Run isolated harness against production paths.

---

## 4. Completion semantics (reject-before-execution vs engine-reported)

**Current gap (proved in M1-34F):** `isRetrieveEndToEndComplete` returns true when `publishedResult && retiredRemote` even if `deliveredCommandId` is null (`companion-on-demand-relay.cjs` ~373–375). Incident harness published **REJECTED** via `rejectRemote` → still **`completed`**.

### 4.1 Design: `completionKind` on retrieve transaction

Add non-breaking observability + UI gating:

| `completionKind` | Meaning | `deliveredCommandId` | Remote result status |
|------------------|---------|----------------------|---------------------|
| `engine_reported` | Engine terminal published | Set (typical) or resume-only edge | FAILED / COMPLETED / … |
| `sidecar_rejected` | `rejectRemote` before execution | null | REJECTED |
| `no_remote_work` | `no_new_orders` | null | — |

**Proposed rules:**

- **`RETRIEVE_PHASE.COMPLETED` UI** for cooperative production: require `completionKind === 'engine_reported'` **OR** explicit operator mode (document only for test harness rejects).
- **`sidecar_rejected`**: terminal UI may show **failed/incomplete for cooperative mission**, not “Retrieve complete.”
- M1-34B end-to-end for **delivered** work: still `publishedResult && retiredRemote && deliveredCommandId`.

**Implementation targets (Step 2):**

- `command-relay-watcher.cjs`: set kind in `_noteRetrievePublished` / `rejectRemote` / `_noteRetrieveDelivered`.
- `companion-on-demand-relay.cjs`: `isRetrieveEndToEndComplete(tx, { requireEngineReported })`, `runRetrieveOnce` disposition messages.

---

## 5. Hard isolation invariant (harness)

**Requirement:** If an isolated harness loses target config during transaction binding, **throw before any GitHub I/O** — never silently use production client.

### 5.1 Proposed mechanism

1. **`relayIsolationContract`** on `createOnDemandRelayContext` when `--relay-isolation-config` loaded:
   - `{ repo, branch, contentPaths, statePath, fingerprint }` (hash of normalized config).
2. **`assertRelayIsolationContract(ctx)`** called from:
   - `bindTransactionScopeToContext` **before** replacing clients (when `ctx.relayIsolationContract` present).
   - `createRelayContentClient` / `publishRemoteContentFile` / `deleteRemoteContentFile` when `ctx.relayIsolationContract` passed via deps **or** `isolationEnforced`.
3. On mismatch or missing contract when `requireRelayIsolation: true`: throw `RELAY_ISOLATION_CONTRACT_VIOLATION`.

**Stricter than today:** `isolationEnforced` only blocks production **mutation**; contract assertion blocks **any** client whose `repo/branch/paths` ≠ contract (including read GET used for wrong repo — optional: enforce on mutation only first).

### 5.2 File / function targets (Step 2)

| File | Change |
|------|--------|
| `lib/relay-isolation-config.cjs` | `fingerprintRelayIsolationConfig()`, export contract shape |
| `lib/companion-on-demand-relay.cjs` | Attach `relayIsolationContract` + `requireRelayIsolation` on isolated daemon ctx |
| `lib/relay-transaction-trace.cjs` | `bindTransactionScopeToContext`: assert contract; merge `ctx.relayOptions`; **refuse** rebuild if contract present and opts missing |
| `lib/github-relay.cjs` | `assertRelayIsolationContract(deps, contract)` on PUT/DELETE (and optionally GET when contract set) |
| `companion-on-demand-relay-daemon.cjs` | Set `requireRelayIsolation: true` when `--relay-isolation-config` |
| `scripts/run-m1-34e-isolated-e2e.cjs` | Assert contract on daemon_ready diagnostic |

**Default production daemon:** no contract — unchanged behavior.

---

## 6. Negative test specification

New file: **`test/companion-on-demand-relay-m1-34g.test.cjs`**

| # | Scenario | Setup | Expect |
|---|----------|-------|--------|
| N1 | Missing `relayOptions` on bound ctx | `requireRelayIsolation: true`, `preserveWatcherIo: false`, empty opts | Throws before mock `gh` PUT |
| N2 | Forced `preserveWatcherIo: false` with contract | Isolated contract + production repo in rebuilt opts | Throws `RELAY_ISOLATION_CONTRACT_VIOLATION` or `assertRelayMutationAllowed` |
| N3 | Client reconstruction drops `contentPaths` | Contract with `m0-e2e/*`, rebuilt client defaults `m0/*` | Throws on first mutation |
| N4 | Production path mutation with `isolationEnforced` | Direct `publishRemoteContentFile` to `m0/tactical-command.json` on `NoReturns/…@main` | Throws |
| N5 | Resume publish FAILED without deliver | Fixture journal `delivered_local` + local FAILED + empty remote inbox | Exactly **one** `publishRemoteResult`, **zero** `deliverLocal`, retirement `mark_retired` |
| N6 | `rejectRemote` completion kind | Validation failure on command | `completionKind: sidecar_rejected`, cooperative UI **not** `engine_reported` complete |
| N7 | Production guard fingerprint | Simulated PUT in harness without contract | Production journal + GitHub SHAs unchanged (extend M1-34E guards) |

Use mock `contentClient` / `execFileSync` gh stubs; **no live GitHub** in unit tests.

---

## 7. Historical evidence for `3cd1c56d…` (no live slot restore)

**Goal:** Preserve audit trail without putting `b8ef8e1…` back into `m0/tactical-result.json`.

| Action | Step |
|--------|------|
| Pin commits in doc | `docs/M1-34F-pending-resume-readonly.md` or **`docs/incident/M1-34F-github-evidence.json`** (read-only manifest) |
| Record blob SHAs | Command `e1f2fb54…`, result `b8ef8e1…` (3cd1c56d FAILED), incident result `e65799c6…` (REJECTED) |
| Optional read-only export | Script **`scripts/export-github-relay-blob-readonly.cjs`** (Step 2): `gh api git/blobs/<sha>` → `docs/incident/blobs/` (gitignored or committed as evidence) |
| Partner narrative | “Shared slot held 3cd1c56d FAILED until 22:47 UTC; superseded by incident REJECTED, then by corrective 2b737d84 FAILED publish” |

**No** restore of `b8ef8e1…` into live slot (operator decision).

---

## 8. Production recovery sequence (operator, when RETRIEVE authorized)

**Phase A — Read-only preflight (repeat M1-34F + guards)**

1. Fingerprint production journal SHA, local watchlist JSON, GitHub command/result SHAs.
2. Confirm inbox 404, result REJECTED for `2b737d84…`, local FAILED unchanged.
3. Confirm daemon **16048** still on production snapshot (no restart).

**Phase B — Dry-run validation (Step 2 tooling optional)**

4. Run **`companion-on-demand-relay-daemon.cjs --once --dry-run`** with production snapshot + journal paths **or** node fixture test N5 mirroring live journal/local files — operator choice.

**Phase C — Single finish-relay RETRIEVE**

5. Enqueue **`companion-on-demand-request.json`** `{ action: retrieve, status: pending }` beside **`local/m0/tactical-live.yaml`** only.
6. Let production daemon **16048** process (no second daemon, no harness).
7. Observe transaction trace: `_resumeActive` → `remote_result_published` **FAILED** → `remote_command_retired` or `mark_retired`.

**Phase D — Verify**

8. GitHub result: **FAILED**, full engine envelope, same `command_id`.
9. Journal: `published_terminal` / `retired_remote`, `active: null`.
10. Re-fingerprint guards; production journal byte change **expected** (terminal phases).

**Phase E — Local hygiene (no remote inbox)**

11. Quarantine local **`tactical-command.json`** via existing **`quarantine-tactical-inbox.cjs`** after terminal result preserved — frees executor without remote command recreation.

**Phase F — Traceability**

12. Publish incident summary to partner with commit IDs (`03f06d8`, `c2e3c7a`, corrective publish SHA) and explicit “engine FAILED is authoritative.”

---

## 9. Rollback considerations

| Failure point | Rollback |
|---------------|----------|
| Publish FAILED fails mid-PUT | GitHub may be unchanged or partial; **do not** RETRIEVE again blindly; inspect result SHA |
| Journal updated, GitHub not | **Do not** hand-edit; use read-only journal backup if taken; contact recovery runbook |
| Corrective publish succeeds | **No** rollback of GitHub to REJECTED (would reintroduce incorrect record); forward-only |
| Local quarantine done | Restore from `local/m0/backups/` if quarantine archived wrong file |

**Before Phase C:** Copy `command-relay-journal.json` and record GitHub result SHA to operator log (read-only backup).

---

## 10. Minimal implementation plan (Step 2 scope)

| Priority | Item | Files |
|----------|------|-------|
| P0 | Relay isolation contract + bind-time assert | `relay-isolation-config.cjs`, `relay-transaction-trace.cjs`, `github-relay.cjs`, daemon, harness |
| P0 | Negative tests N1–N4, N7 | `test/companion-on-demand-relay-m1-34g.test.cjs` |
| P1 | `completionKind` + UI/disposition split | `command-relay-watcher.cjs`, `companion-on-demand-relay.cjs`, tests N6 |
| P1 | Incident evidence manifest + optional blob export | `docs/incident/`, optional script |
| P2 | Operator dry-run helper for recovery preflight | `scripts/preflight-m1-34g-recovery-readonly.cjs` |
| — | **Production RETRIEVE** | Operator executes Phase C only after P0 merged + tests green |

**Out of scope:** Restoring remote inbox; restoring `3cd1c56d…` to shared slot; changing FAILED → COMPLETED.

---

## 11. Acceptance mapping (post-recovery)

| Question | Answer source |
|----------|----------------|
| What did the engine do? | Local + published GitHub **FAILED** with `destination_reached: true` |
| What did the relay do? | Delivered once (historical), published authoritative result, retired/absent inbox reconciled |
| What went wrong? | Documented M1-34F incident + Git commits; REJECTED labeled incorrect cooperative record |
| Incident erased? | **No** — Git history + evidence manifest retain REJECTED and 3cd1c56d blobs |
