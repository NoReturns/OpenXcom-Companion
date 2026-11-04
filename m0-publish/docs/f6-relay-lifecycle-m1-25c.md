# F6 save/reload and relay lifecycle (M1-25C)

## Flow

1. **F6 (engine)** — `CompanionSnapshot::tryExport` writes `tactical-live.yaml`, notes snapshot SHA + `state_version`, publishes `companion-soldier-control.json`, archives stale `tactical-command.json` when binding no longer matches export, writes `companion-briefing-request.json`.
2. **Briefing watcher** — Validates snapshot vs request; **latest request wins** if superseded before/after GitHub publish; journal marks terminal per `request_id`.
3. **Command relay** — Delivers remote `m0/tactical-command.json` only after sidecar validation against **current** snapshot file; respects terminal journal + local non-terminal results.
4. **Engine executor** — Rejects stale bindings (`STALE_*`); archives inbox on F6 and on battle session/tactical scope change; interrupts in-flight MOVE with `INTERRUPTED` + evidence on binding reset (does not delete journals).

## Launch hygiene

`Start-CompanionOpenXcom.ps1` runs `quarantine-tactical-inbox.cjs`, which quarantines inbox when:

- Result is terminal (M1-25A), or
- Inbox binding ≠ current `tactical-live.yaml` export (M1-25C), or
- Blocks launch when result is `EXECUTING` / `ACCEPTED`.

## Pending command locations

| Location | Role |
|----------|------|
| GitHub `m0/tactical-command.json` | Remote inbox; sidecar validates before local delivery |
| `local/m0/tactical-command.json` | Engine inbox |
| `local/m0/tactical-result.json` | Engine terminal/open result |
| Sidecar `command-relay-journal.json` | Delivery/retirement state |
| Engine `tactical-command-journal.json` | Executed `command_id` history (append-only) |

Archived inbox copies: `local/m0/backups/tactical-command.*.json`
