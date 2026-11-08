# M1-34D — Pending transaction `2b737d842…` (read-only)

Live mission **HOLD**. This document records verification only; no publication, retirement, or re-execution was performed.

## Identity

| Field | Value |
|--------|--------|
| `command_id` | `2b737d8422bef12932d4586140b9abf7` |
| Type | MOVE (actor 1 → 9,20,0) |
| Session | `6b1cae643ce1b48228a55b3459c334b3`, turn 4 |
| Sidecar record | `phase: delivered_local`, `remote_sha256: e1f2fb54…` |
| Journal `active` | Same command_id + remote_sha256 (pending relay completion) |

## Local engine state (observed, not modified)

- `local/m0/tactical-command.json` — same command (inbox still present locally).
- `local/m0/tactical-result.json` — **terminal** for the same `command_id`, **`status: FAILED`** (not COMPLETED).
- `destination_reached: true` with unit at final tile — engine reported **FAILED** via walk lifecycle evaluation (`evaluateWalkTerminalStatus` in Companion command runtime). **Relay must publish `FAILED` as-is**; must not upgrade to COMPLETED because the soldier reached the tile.

## Why relay is incomplete

Pre–M1-34B retrieve marked UI complete after **local delivery** without GitHub publish/retire (see `companion-on-demand-relay-transactions.jsonl` request `b0e96cdd…`: `publishedResult: false`).

## Resume path (code, no live run)

On RETRIEVE with M1-34B:

1. `_pollOnce` → `_resumeActive`: journal `active` matches local terminal result → **`publishResult(localResult, …)`** with existing **`FAILED`** status.
2. **`deliverLocal` is not called again** when:
   - Record exists with `phase: delivered_local` and matching `remote_sha256` (`command-relay-watcher.cjs` early return), or
   - `isTerminalRelayRecord(existing)` for duplicate remote command.
3. SHA / session gates unchanged: validation uses snapshot + journal at publish time.

## Safe-resume decision

| Question | Answer |
|----------|--------|
| Re-execute locally? | **No** — terminal result already on disk for this `command_id`. |
| Publish to cooperative relay? | **Yes, when operator chooses** — publish **FAILED** terminal envelope; do not fabricate success. |
| Safe after M1-34B on isolated validation? | **Conditional GO** for a **finish-relay-only** RETRIEVE on live mission once isolated M1-34B behavior is confirmed. |
| HOLD until | Operator accepts publishing **FAILED** to partners and any tactical meaning of that failure is understood. |

## Uncertainty

Exact in-engine reason for FAILED despite `destination_reached` (authority, busy state, or walk evaluator) was not re-derived in this milestone; only the on-disk terminal status is authoritative for relay.
