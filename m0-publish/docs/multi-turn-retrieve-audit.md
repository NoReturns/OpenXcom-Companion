# Multi-turn RETRIEVE — feasibility audit

**Date:** 2026-11-05  
**Scope:** Read-only review of what exists today and what would be required to run **more than one tactical command** (especially **MOVE** continuations across partial walks, turns, or mission steps) without the operator pressing **RETRIEVE DATA** once per command.  
**Out of scope:** Implementation, engine builds, or GitHub mutations.

---

## Executive summary

Today the cooperative loop is intentionally **one remote command ↔ one RETRIEVE transaction ↔ one engine execution**. That matches a **single GitHub inbox**, **binding freshness** (`snapshot_sha256` + `state_version`), and **reaction / human interrupt** semantics (`INTERRUPTED`).

Speeding missions up is realistic, but **not** by stuffing multiple unrelated orders into one JSON command without new design. The workable directions are:

1. **Relay autopilot (recommended first)** — one operator gesture starts a **bounded session** that repeats deliver → execute → retire → (optional) post-command state publish until a **plan** completes or a **stop condition** fires (interrupt, stale binding, human override, empty inbox).
2. **Engine movement intent** — a **persistent local plan** (same final destination) resumed on later player-turn idle ticks until `COMPLETED` or **explicit cancel**; still **one binding per step** unless binding rules are extended.
3. **Remote command queue** — multiple commands on GitHub with strict ordering; retrieve drains **one at a time** inside one long transaction (helps multi-**unit** same turn, not cross-turn binding alone).

**Cancel further movement** is partially there already (`INTERRUPTED`, binding reset, human ownership). What is missing is a **durable plan handle** both the engine and relay/agent agree to clear when anything “bad” happens.

---

## Problem statement (operator experience)

Typical cooperative MOVE loop today:

1. Agent (or human) publishes `m0/tactical-command.json` (CLI: `publish-tactical-command-once.cjs`).
2. Operator presses **RETRIEVE DATA** in battlescape.
3. On-demand daemon runs `runRetrieveOnce` (~**4–9 s** per transaction in recent `companion-on-demand-relay-transactions.jsonl` traces): GitHub GET → local delivery → engine execution wait → result publish → remote retire.
4. For the **next** MOVE (same soldier, same mission goal, new turn, or partial path): repeat from step 1 with a **new** `command_id` and **new** `state_version` from the latest tactical export.

Each RETRIEVE handles **at most one** delivered `command_id` (`beginRetrieveTransaction` / `isRetrieveEndToEndComplete` in `companion/m0-publish/lib/companion-on-demand-relay.cjs`).

That is safe and debuggable, but mission pacing is dominated by **(publish latency + retrieve latency + operator clicks) × number of steps**.

---

## Current architecture (sources of truth)

| Layer | Role | Multi-turn implication |
|-------|------|-------------------------|
| GitHub `m0/tactical-command.json` | **Single remote inbox** | `evaluateInboxBeforeCreate` refuses overwrite (`inbox_occupied`) in `relay-tactical-command-publish.cjs` |
| Sidecar `command-relay-watcher.cjs` | Validates binding, writes local inbox, watches result, retires remote | One active delivery pipeline; post-command **`tryPublishPostCommandTacticalState`** can refresh `m0/state.json` after terminal results without a manual F6 |
| Engine `CompanionCommandRuntime.cpp` | One **in-flight** command (`g_active`); poll local `tactical-command.json` | No command queue; F6 / session change **interrupts** in-flight work |
| Engine `BattlescapeGame::tryExecuteCompanionMove` | Single `BA_WALK` via pathfinding to **one** destination | Engine already walks until TU/path ends or battle state stops |
| On-demand relay | `action: retrieve` → `runRetrieveOnce` only | No “continue until plan done” mode |
| UI `CompanionOnDemandRelayCore.cpp` | RETRIEVE enqueues one request; rejects if `relay_busy` / `request_in_flight` | Cannot stack retrieve buttons while daemon busy |

Lifecycle reference: [f6-relay-lifecycle-m1-25c.md](./f6-relay-lifecycle-m1-25c.md), [tactical-command-m1-19.md](./tactical-command-m1-19.md).

---

## What one MOVE already does (vs what it does not)

### Within one command (same turn)

- Pathfinding runs to the **final** `destination` (`tryExecuteCompanionMove`).
- The unit may **stop early** (TU, reaction fire, battle busy transitions). Terminal evaluation uses `evaluateWalkTerminalStatus` (`CompanionCommandCore.cpp`):
  - **`COMPLETED`** — actor alive, AI-controlled, not busy, `currentPos == requestedDest`.
  - **`INTERRUPTED`** — partial move (`currentPos` neither start nor dest), human/authority loss, or non-empty `actionResult` (tests cover TU string; runtime currently leaves walk `actionResult` empty in the poll path — partial position still yields **INTERRUPTED**).
  - **`FAILED`** — e.g. dead actor, or stuck at start with no progress.

So “aliens interrupt movement” is already modeled as **`INTERRUPTED`** (and battle may continue under human/engine rules). There is **no** automatic “resume this MOVE next turn” tied to the same `command_id`.

### Across turns

- Each new command must match **current** `state_version` (= `eventLog.latestSeq`) and `snapshot_sha256` ([command-binding.cjs](../lib/command-binding.cjs)).
- After terminal MOVE, engine may re-export YAML (`shouldExportSnapshotBeforeTerminalCommandResult`); sidecar may push updated relay state (`post-command-tactical-publish.cjs`) so remote commanders see new positions **without** pressing SEND — but the **next** MOVE still needs a **new publish** and **new RETRIEVE**.

---

## Interrupt and cancel — existing vs needed

| Event | Today | Gap for multi-turn plan |
|-------|--------|-------------------------|
| Reaction fire / partial walk | Usually **`INTERRUPTED`** with `final_position` | Plan should **stop**; optional “resume” only after explicit replan |
| Human selects unit / revokes AI | **`INTERRUPTED`** (`actorStillAiControlled == false`) | Same |
| F6 / new export while in-flight | `interruptInFlightForBindingReset` → **INTERRUPTED** “Battle binding reset.” | Plan must clear; stale inbox archival already exists |
| New remote command while executing | Blocked by inbox + “do not publish another MOVE while EXECUTING” ([companion-relay-notifications.md](./companion-relay-notifications.md)) | Autopilot must respect **EXECUTING** gate |
| Operator wants “stop marching” | No plan file — stop = **don’t publish / don’t RETRIEVE** | Need **`CANCEL_PLAN`** or UI “abort autopilot” |
| Soldier died / panicked / MC | Readiness in `unitStateBrief.exceptions`; may not be commandable | Autopilot must run **mandatory status review** before continuing |

**Cancel further movement** in product terms = **clear the mission plan** + ensure no pending local inbox + optionally publish **`CANCEL`** or retire queue. Engine already stops walking when command completes terminal; it does **not** read a multi-step plan today.

---

## Design options

### Option A — Relay / daemon **autopilot session** (lowest engine risk)

**Idea:** Operator presses **RETRIEVE** once (or a new **RETRIEVE MISSION** control) with a **local plan file** beside the snapshot, e.g. `companion-tactical-plan.json`:

```json
{
  "schema_version": 1,
  "plan_id": "uuid",
  "session_id": "<32 hex>",
  "steps": [
    { "command_type": "MOVE", "actor_unit_id": 3, "destination": { "x": 40, "y": 22, "z": 0 } },
    { "command_type": "KNEEL", "actor_unit_id": 3 }
  ],
  "stop_on": ["INTERRUPTED", "FAILED", "REJECTED", "STALE", "human_override"],
  "max_steps": 32,
  "max_wall_ms": 300000
}
```

**Daemon loop (extends `runRetrieveOnce` or new `runRetrieveSession`):**

1. If GitHub inbox empty and plan has next step → agent/human pre-published command **or** daemon calls `composeMoveCommand` + `publish-tactical-command-once` (policy decision: who authors).
2. Run existing retrieve pipeline for **one** command.
3. On terminal success → advance plan; on **INTERRUPTED** / stale → mark plan **halted** with reason.
4. Wait for post-command state refresh (already triggered from watcher) before composing next binding.

**Pros:** Reuses engine + single-command schema; tests stay localized to Node.  
**Cons:** Still one GitHub command per step; needs **authoring** between steps unless combined with Option B intent file.

**Files likely touched:**

- `companion/m0-publish/lib/companion-on-demand-relay.cjs` — session loop, budgets, disposition codes.
- `companion/m0-publish/companion-on-demand-relay-daemon.cjs` — long-running transaction UI (`terminal: false` until session ends).
- `engine/.../CompanionOnDemandRelayCore.cpp` — optional new action `retrieve_session` or scope flag on request JSON.
- New tests: `companion-on-demand-relay-m1-XX.test.cjs` (interrupt halts session; inbox_occupied; stale binding).

---

### Option B — Engine **movement intent** (best for “same destination, many turns”)

**Idea:** Extend MOVE (or add `MOVE_INTENT`) with optional:

```json
"intent": {
  "kind": "reach_destination",
  "destination": { "x": 40, "y": 22, "z": 0 },
  "resume_after_interrupt": false
}
```

**Engine behavior:**

- Store intent in memory + optional `companion-move-intent.json` (session-bound).
- On **player turn idle** (`BattlescapeGame` tick where idle snapshot export runs), if intent active and actor AI-owned → issue internal walk toward destination (same as today’s executor) **without** new inbox until intent cleared.
- On **INTERRUPTED** terminal for that intent → clear intent unless `resume_after_interrupt: true` (dangerous near reactions — default **false**).
- New explicit **`CANCEL_INTENT`** local file or command type to stop.

**Binding:** Either require fresh `state_version` on each resume tick (strict, current philosophy) or define **intent_session_token** validated against `session_id` + actor (new security review).

**Pros:** Operator RETRIEVE once per **goal**, not per tile/turn.  
**Cons:** C++ work, UX for cancel, edge cases (panic, MC, hidden enemies), fairness (path uses live map — OK).

**Files likely touched:**

- `CompanionCommandCore.cpp` / `.h` — parse intent, validation.
- `CompanionCommandRuntime.cpp` — intent persistence, idle resume hook from `BattlescapeGame`.
- `tactical-command.cjs`, `command-binding.cjs` — schema + composers.
- `companion_command_test.cpp` — interrupt + resume matrix.

---

### Option C — GitHub **command queue** file

**Idea:** New relay artifact `m0/tactical-command-queue.json` (ordered array, max N entries, byte cap). RETRIEVE session pops front entry into inbox after previous **terminal + retired**.

**Pros:** Agent publishes whole squad plan once.  
**Cons:** Stale steps dangerous if battlefield changes; needs **version** or **plan_id** on every step; still one engine execution at a time; does not remove binding refresh between steps unless each step embeds expected `state_version` (brittle).

**Recommendation:** Only as a **transport** paired with Option A’s stop rules, not alone.

---

### Option D — External agent loop only (no product change)

Cursor/agent watches `COMMAND_COMPLETED` / post-command state and auto-publishes next command; operator still presses RETRIEVE each time.

**Pros:** Zero engine work.  
**Cons:** Does not meet “one retrieve” goal; documented in [AGENTS.md](../../../AGENTS.md) cooperative autonomy already covers **publish**, not **retrieve**.

---

## Recommended phasing

| Phase | Deliverable | Outcome |
|-------|-------------|---------|
| **0** | Spec for `companion-tactical-plan.json` + stop conditions | Shared contract for engine/relay/agent |
| **1** | **Option A** MVP: daemon drains **pre-published** queue of commands with one RETRIEVE request | Multi-**step** missions (move + kneel + snap) with one button |
| **2** | **Option B** MVP: `MOVE` intent resume across idle player ticks until dest or INTERRUPTED | Multi-**turn** march to a rally point |
| **3** | UI: **Abort plan**, visible plan status on overlay | Operator trust |
| **4** | Agent tooling: `composePlanFromBriefing()` + mandatory exceptions check between steps | Safe cooperative autopilot |

---

## Work breakdown checklist

### Schema & policy

- [ ] Plan file schema + max steps / max bytes (mirror 8 KiB command cap philosophy).
- [ ] Define when autopilot may **not** continue (MC roster soldier, berserk/panic **confirmed** in `unitStateBrief.exceptions`, `inbox_occupied`, alien turn).
- [ ] **`END_TURN`** remains human-only ([AGENTS.md](../../../AGENTS.md)) — autopilot must not chain across alien turn without explicit design.

### Node / relay

- [ ] Extend retrieve transaction trace (`relay-transaction-trace.cjs`) with `plan_id`, `step_index`, `halt_reason`.
- [ ] Session budgets (wall clock, GitHub quota) beyond `DEFAULT_RETRIEVE_TOTAL_BUDGET_MS` (30 s).
- [ ] Interaction with `post-command-tactical-publish.cjs` — wait until `commandBinding.state_version` on relay matches local YAML before next publish.
- [ ] Idempotency: plan cursor persisted beside snapshot so daemon restart mid-session is safe.

### Engine (if Option B)

- [ ] Intent persistence across saves? (Probably **no** — battle-scoped only.)
- [ ] Hook idle player export path (`BattlescapeGame.cpp` ~1194) for resume.
- [ ] `CANCEL_INTENT` command or delete local intent file from UI.
- [ ] Ensure reaction fire during resume still terminates intent.

### UI

- [ ] `CompanionOnDemandRelayOverlay` — optional **RETRIEVE PLAN** vs legacy single retrieve.
- [ ] Status strings: `Retrieving step 2/5…`, `Plan halted: INTERRUPTED`.

### Tests

- [ ] Fixture: MOVE INTERRUPTED mid-path → plan stops, no second delivery.
- [ ] Fixture: two-step plan (MOVE + KNEEL) one session → two deliveries, one button enqueue.
- [ ] Regression: single-command retrieve unchanged when no plan file.
- [ ] Engine: intent resume across two idle ticks with binding update.

### Documentation / ops

- [ ] Update [tactical-command-m1-20b.md](./tactical-command-m1-20b.md) operator loop.
- [ ] Notification codes: `PLAN_HALTED`, `PLAN_COMPLETED` ([companion-relay-notifications.md](./companion-relay-notifications.md)).

---

## Risks and non-goals

**Risks**

- **Stale plans** after battlefield changes (door opened, explosion, unit death) → must halt aggressively.
- **GitHub rate limits** if autopilot loops too fast (`relay-rate-limit-gate.cjs`).
- **False “fun” reduction** if autopilot skips human reaction to interrupts — default should **halt and notify**, not silently replan.
- **M1-34G class bugs** — retrieve “complete” without engine truth; any session mode must reuse `completionKind === 'engine_reported'` gates.

**Non-goals (this audit)**

- Multi-unit **simultaneous** execution (engine battle queue is serial per action).
- END_TURN automation.
- Bypassing `commandBinding.player_soldiers` or MC exceptions review.
- Raw `gh api` PUT for commands (still forbidden by [AGENTS.md](../../../AGENTS.md)).

---

## Open questions for product owner

1. **One button or two?** Extend RETRIEVE when plan file exists vs dedicated **AUTOPILOT** control.
2. **Who authors steps?** Remote agent only vs daemon composing MOVE from plan coordinates (trust boundary).
3. **After INTERRUPTED partial move:** auto-retry same destination on next turn, or **always** require new agent plan + status review?
4. **Cross alien turn:** Should autopilot pause until next player turn automatically (likely **yes**)?
5. **Multi-soldier:** Strict turn order in plan vs parallel publishes (parallel still executes one at a time in engine).

---

## Related code index

| Topic | Location |
|-------|----------|
| Single retrieve transaction | `companion/m0-publish/lib/companion-on-demand-relay.cjs` — `runRetrieveOnce` |
| Retrieve timing / polls | `DEFAULT_RETRIEVE_*` constants same file |
| Inbox single-occupancy | `companion/m0-publish/lib/relay-tactical-command-publish.cjs` |
| Walk terminal / interrupt | `engine/OpenXcom/src/Engine/CompanionCommandCore.cpp` — `evaluateWalkTerminalStatus` |
| In-flight interrupt on binding reset | `CompanionCommandRuntime.cpp` — `interruptInFlightForBindingReset` |
| Post-command GitHub state | `companion/m0-publish/lib/post-command-tactical-publish.cjs` |
| RETRIEVE button queue | `engine/OpenXcom/src/Engine/CompanionOnDemandRelayCore.cpp` |
| Prior capability audit | [M1-battlescape-capability-audit.md](./M1-battlescape-capability-audit.md) (P3 mentions multi-tile HWP, not retrieve) |

---

## Summary

Multi-turn RETRIEVE is **not** a small tweak to `runRetrieveOnce`; it is a **session layer** above the existing **one inbox / one binding / one execution** core. The fastest path to “speed up missions without losing interrupt safety” is **relay autopilot with a local plan and hard stop on `INTERRUPTED`**, optionally followed by **engine movement intent** so the same goal survives across player-turn idle ticks without a retrieve per tile.

**Cancel further movement** should be defined as **plan cancellation** (clear plan + optional engine intent clear), reusing today’s **`INTERRUPTED`** and authority rules rather than inventing a second movement channel.
