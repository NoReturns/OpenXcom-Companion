# M1 — Tactical plan foundation (design note)

**Date:** November 6, 2026  
**Scope:** Reusable lifecycle primitives and **safe** patterns for **future bounded sequential plans** (movement, inventory, combined). **No implementation** of a plan controller or command queue in this note.

**Operating principle:** One inbox command → one terminal result → **refresh** snapshot/binding → decide the next action. Do **not** publish speculative follow-ups against stale YAML.

## 1. Existing reusable primitives

| Primitive | Where | Role |
|-----------|--------|------|
| **Command JSON parse + type dispatch** | `CompanionCommandCore`, Node `tactical-command.cjs` | One schema per `command_type` (incl. **`INVENTORY_MOVE`** — WP8B3, **`PICKUP`** / **`DROP`** — WP8B4). |
| **Binding freshness** | `validateTacticalCommandBinding` / Node `validateBindingAgainstSnapshot` | `snapshot_sha256`, `session_id`, `turn`, `state_version` (= `eventLog.latestSeq`). |
| **AI ownership** | `CompanionTacticalAuthorityCore` + relay `companion-soldier-control.json` | `aiCommandPermitted`, human override, stale relay AI. |
| **Human soldier block** | `BattlescapeGame::warnIfHumanPlayerOrderDenied`, binding `NOT_AI_CONTROLLED` | Same for MOVE, KNEEL, fire, grenades, **RELOAD**, **UNLOAD**, **INVENTORY_MOVE**, **PICKUP**, **DROP**. |
| **Duplicate suppression** | Journal + `applyDuplicateInboxDecision`, digest | Same pipeline for all command types. |
| **In-flight single command** | `g_active.inFlight`, `PRIOR_COMMAND_ACTIVE` | Engine processes **one** async-ish command at a time (walk / projectile). |
| **Terminal results** | `tactical-result.json`, lifecycle strings | `COMPLETED`, `REJECTED`, `INTERRUPTED`, `FAILED`, `EXECUTING`. |
| **Post-command state refresh** | Sidecar / `post-command-tactical-publish` (see multi-turn audit) | Optional GitHub tactical refresh after terminal — **still requires new publish + binding for the next command**. |
| **Interrupt on binding reset** | `interruptInFlightForBindingReset` | F6 / session change stops in-flight with `INTERRUPTED`. |

## 2. Gaps for multi-command plans

- **No durable plan handle** in engine or relay — only single inbox command + journal id.
- **No automatic “next step”** after `COMPLETED` — each step needs new `command_id` and fresh binding from latest export.
- **RETRIEVE** remains **one command per transaction** (see `multi-turn-retrieve-audit.md`).
- **Partial completion** (e.g. MOVE `INTERRUPTED`) must stop the plan; **no rollback** of completed engine actions.

## 3. Relationship to deferred multi-turn RETRIEVE work

The audit **`companion/m0-publish/docs/multi-turn-retrieve-audit.md`** already describes:

- Relay **autopilot** (bounded session: deliver → execute → retire → optionally post-command publish → **repeat** with **new** bindings).
- Why a **remote JSON queue** or **packed multi-command** JSON is the wrong first step without new rules.

A future plan controller should **reuse** that mental model: **one step = one inbox command + one terminal result**, not speculative queues.

## 4. Safe sequential execution rules (recommended)

1. **One command in flight** — wait for terminal `tactical-result.json` before publishing the next.
2. **Refresh binding** from latest F6 / relay snapshot (`state_version`, `snapshot_sha256`).
3. **Re-validate** actor (alive, AI-owned, not MC), TU, and command-specific legality.
4. **Stop** on `REJECTED`, `INTERRUPTED`, `FAILED`, ownership loss, or stale binding.
5. **Never replay** a `command_id` (journal + duplicate rules).
6. **Never** issue `END_TURN` from automation (human-only policy unchanged).
7. **Cancel** = stop publishing + clear plan state client-side; engine has no “plan” to cancel today.

## 5. Interruption and cancellation

- Engine: `interruptInFlightForBindingReset`, authority loss → `INTERRUPTED`.
- Relay: EXECUTING gate (do not publish competing commands).
- Plans must treat **`INTERRUPTED`** as **non-resumable** unless the operator explicitly issues a **new** plan after assessing state.

## 6. Snapshot refresh strategy

- After each terminal result, the **next** step’s command must use the **post-action** export’s digest and `state_version`.
- Relying on stale YAML invalidates the command (by design).

## 7. Why END_TURN stays human-only

- Cooperative policy and fairness: agents must not end player turns or burn turn boundaries.
- No change proposed here.

## 8. Shared vs action-specific

**Shared:** binding freshness, ownership, journal/duplicate handling, terminal result parsing, “one inbox at a time.”

**Action-specific:** pathfinding (MOVE), hand selection (fire/grenades), item ids (`RELOAD`, `UNLOAD` magazine identity, **`INVENTORY_MOVE` item + slot coords**, **`PICKUP`/`DROP` ground item id + tile guard**), projectile completion (shots/throws).

## 9. Suggested implementation sequence (future)

1. Finish **individual** battlescape primitives in order (WP8B4 **`PICKUP`/`DROP`** — see `M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md`) before investing in orchestration.
2. **Read-only loot awareness** (WP8C): snapshot `groundItems` + `hostile_casualty_tile_observed` in `perceptionLog` — informational only; never replaces `units[].groundInventory` for **`PICKUP`** authorization. See `M1-BATTLESCAPE-WP8C-LOOT-AWARENESS.md`.
3. **Controlled live integration** of the **inventory command family** once each primitive is stable (`RELOAD`, `UNLOAD`, `INVENTORY_MOVE`, **`PICKUP`**, **`DROP`**).
4. **Client-side plan state machine** (or relay autopilot session) **above** existing publish CLI — no engine queue; still **one command file** and **one terminal result** per step.
5. Optional **UNLOAD** (WP8B2, implemented — `M1-BATTLESCAPE-WP8B2-UNLOAD.md`) remains part of magazine-swap sequences when combined with **`INVENTORY_MOVE`** (WP8B3) — see `M1-BATTLESCAPE-WP8B2-UNLOAD.md` §5.
6. Only if needed: extend relay **retire** + **retrieve** contract for “session id for autopilot” — still **one command file** at a time.

Keep each command a **single atomic engine transaction**; plans orchestrate **steps**, not **merged** payloads. A **sophisticated multi-command planner** is a later layer — not a prerequisite for shipping each primitive.
