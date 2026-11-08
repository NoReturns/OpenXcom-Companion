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

## Issue #2: Node daemon vs AUTO RETRIEVE

M1 operators must distinguish **launcher-scoped Node relay** from **battlescape-scoped AUTO RETRIEVE**. Existing session and command gates (quarantine, stale inbox archive, `STALE_*` rejects, play-session delivery checks) are unchanged.

### Node on-demand daemon (production)

| Aspect | Behavior |
|--------|----------|
| Started | `Start-CompanionOpenXcom.ps1` → `beginCompanionPlaySession` + `companion-on-demand-relay-daemon.cjs` |
| Lifetime | **Game session** — remains alive across Geoscape ↔ battlescape transitions and multiple missions |
| Stopped | Play-session shutdown when the OpenXcom game process exits (see `on-demand-play-session.cjs`, launcher `finally`) |
| Work | Polls `companion-on-demand-request.json`; GitHub I/O only while processing SEND/RETRIEVE |
| Not | A 30s autopilot publisher — agents still publish `m0/tactical-command.json`; daemon validates and delivers |

Engine recovery may **adopt** a healthy daemon for the same snapshot path; one owner per `OPENXCOM_COMPANION_SNAPSHOT_PATH`.

### AUTO RETRIEVE (engine, battlescape HUD)

| Aspect | Behavior |
|--------|----------|
| Scope | **Battlescape only** (`CompanionAutoRetrieveCore::enterBattlescape` / `leaveBattlescape`) |
| Default | **OFF** when entering each mission; cannot enable on Geoscape |
| Interval | **30s** when enabled (`AUTO_RETRIEVE_INTERVAL_DEFAULT_SEC`); **reset to 30s on each battlescape entry** |
| Role | Schedules in-game RETRIEVE attempts when relay UI is not busy — requires the running daemon + local request path |
| Not | Independent GitHub publish, command authoring, or a substitute for starting the launcher daemon |

`resetForNewGameSession()` in `CompanionAutoRetrieveCore` is used in **unit tests** only; production reset is enter/leave battlescape.

### P0 test-supervisor repair (not production AUTO)

Commit *bind test relay daemons to supervisor lifecycle* (`on-demand-test-supervisor.cjs`) ensures **Node test** daemons exit when the owning `node --test` worker ends. It does **not** change operator AUTO RETRIEVE defaults, battlescape interval reset, or `Start-CompanionOpenXcom.ps1` play-session shutdown.

### Pending commands across transitions

| Transition | Daemon | AUTO | Commands |
|------------|--------|------|----------|
| Mission end → Geoscape | Keeps running | OFF | `onBattleCompanionBindingContext` may archive stale inbox / interrupt in-flight work |
| New mission (same game) | Keeps running | OFF; interval → 30s | New tactical `session_id` — stale binding rules apply |
| Game exit | Stopped | N/A | Next launch: `quarantine-tactical-inbox.cjs` hygiene |
| Save/load (same process) | Same session if launcher unchanged | Per battlescape enter/leave | F6 + export archives stale inbox |

Operator playbook: [ASTER-LIVE-PLAYBOOK.md](../../docs/ASTER-LIVE-PLAYBOOK.md#two-relay-lifecycles-daemon-vs-auto-retrieve).
