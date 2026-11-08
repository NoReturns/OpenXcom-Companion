# Companion unified relay notifications (M1-22B2)

Structured, deduplicated console notifications for the existing briefing and command-relay sidecars. No new queue, protocol, or engine UI.

## Notification codes

| Code | Meaning |
|------|---------|
| `BRIEFING_PUBLISHED` | Verified F6 briefing payload published (or dry-run validated) to relay |
| `COMMAND_RECEIVED` | New remote `t0/tactical-command.json` blob observed (by Git SHA) |
| `COMMAND_DELIVERED` | Sidecar wrote local inbox (delivery ≠ execution) |
| `COMMAND_EXECUTING` | Engine result shows `EXECUTING` / `ACCEPTED` |
| `COMMAND_COMPLETED` | Terminal `COMPLETED` observed on local result |
| `COMMAND_INTERRUPTED` | Terminal `INTERRUPTED` (e.g. reaction fire / human override) |
| `COMMAND_FAILED` | Terminal `FAILED` (e.g. no path) |
| `COMMAND_REJECTED` | Terminal `REJECTED` (non-stale policy) |
| `COMMAND_STALE` | Binding stale vs snapshot (`STALE_*`, sidecar validation) |
| `COMMAND_DUPLICATE` | Remote command id already terminal in sidecar journal |
| `COMMAND_CONFLICT` | Identity / payload conflict (e.g. result id mismatch) |
| `RELAY_DISCONNECTED` | GitHub read/publish failure |
| `RELAY_RECONNECTED` | GitHub reachable again after disconnect |

Correlation fields when available: `command_id`, `session_id`, `request_id`, `turn`, `state_version`, `inbox_sha256`, `remote_sha256`, `reason_code`.

## Example supervisor output

```text
[notify] BRIEFING_PUBLISHED request=87f05faf… session=87f05faf… turn=1 state_version=12 reason=published
[notify] COMMAND_RECEIVED command=c69b213f… session=87f05faf… turn=1 state_version=12 remote_sha256=ac39d443a2b1…
[notify] COMMAND_DELIVERED command=c69b213f… session=87f05faf… turn=1 state_version=12 remote_sha256=ac39d443a2b1…
[notify] COMMAND_EXECUTING command=c69b213f… turn=1 inbox_sha256=ac39d443a2b1… reason=EXECUTING
[notify] COMMAND_COMPLETED command=c69b213f… turn=1 inbox_sha256=ac39d443a2b1… reason=COMPLETED
```

Stale remote command (deduplicated — one line per poll cycle key):

```text
[notify] COMMAND_STALE command=deadbeef… turn=99 reason=SIDECAR_VALIDATION turn mismatch
```

Connection loss:

```text
[notify] RELAY_DISCONNECTED reason=network down
[notify] RELAY_RECONNECTED
```

Duplicate after restart:

```text
[notify] COMMAND_DUPLICATE command=move-once… reason=SIDECAR_TERMINAL_RECORD
```

## Operator actions

| Notification | Suggested action |
|--------------|------------------|
| `COMMAND_STALE` | Press **F6** for fresh snapshot; publish new command with updated `commandBinding` |
| `COMMAND_DUPLICATE` | No action; remote id already handled. Clear GitHub command when policy allows |
| `COMMAND_CONFLICT` | Inspect `tactical-command-conflict.json` and local/remote results; do not re-enable full relay without review |
| `COMMAND_DELIVERED` | Engine will evaluate when idle; ensure executor/ownership intentional |
| `COMMAND_EXECUTING` | Wait; do not publish another MOVE |
| `COMMAND_INTERRUPTED` | Review battlefield; may need new F6 + new command id |
| `RELAY_DISCONNECTED` | Check `gh auth status`, network; sidecar retries on next poll |
| `BRIEFING_PUBLISHED` | AI/owner may read `m0/state.json`; run mandatory `unitStateBrief.exceptions` review first (`AGENTS.md`, `lib/tactical-briefing-ai-workflow.cjs`) |

## Wiring

- Sidecars emit `@COMPANION_NOTIFY\t{json}` lines when `COMPANION_RELAY_STRUCTURED_NOTIFY=1` (set by `start-companion-relay.ps1`).
- Launcher supervisor dedupes and prints `[notify] …` lines.
- Sidecar-local dedupe prevents spam on every poll.

## Tests

```bash
cd companion/m0-publish
node --test test/companion-relay-notify.test.cjs
```

See also [companion-relay-launcher.md](./companion-relay-launcher.md).
