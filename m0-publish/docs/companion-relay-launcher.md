# Companion unified relay launcher (M1-22B1)

One entry point for **read-only preflight** and **starting** the existing Node sidecars (`publish-tactical-once.cjs`). No new protocol, engine changes, or automatic changes to inbox, journals, ownership, or GitHub state.

## Prerequisites

- Node.js **22+**
- GitHub CLI (`gh`) authenticated: `gh auth status`
- Environment variable **`OPENXCOM_COMPANION_SNAPSHOT_PATH`** set to your live tactical YAML (typically `local/m0/tactical-live.yaml`), or pass `-SnapshotPath`

Sidecar journals (preserved across runs):

- `companion/m0-publish/.briefing-sidecar-state/`
- `companion/m0-publish/.command-relay-sidecar-state/`

## Commands (from repo root)

### Read-only preflight (default)

```powershell
.\companion\m0-publish\start-companion-relay.ps1
```

Machine-readable JSON:

```powershell
.\companion\m0-publish\start-companion-relay.ps1 -Json
```

Preflight checks:

- Node and `gh` readiness
- Snapshot file presence
- Local `tactical-command.json`, `tactical-result.json`, engine command journal
- Sidecar command-relay journal (`active`, terminal records)
- Remote `m0/tactical-command.json` and `m0/tactical-result.json` (read-only via `gh`)
- Whether **inbound delivery** is safe for full relay

Exit code **0** = ready for outbound briefing; **2** = outbound not ready (see report).

### Outbound briefing only

Publishes F6-driven intelligence to GitHub (`--briefing-watch --publish`):

```powershell
.\companion\m0-publish\start-companion-relay.ps1 -StartOutbound
```

Dry-run (no GitHub writes):

```powershell
.\companion\m0-publish\start-companion-relay.ps1 -StartOutbound -DryRun
```

### Full bidirectional relay

Starts **both** briefing watcher and command/terrain relay (`--command-relay-watch --publish`):

```powershell
.\companion\m0-publish\start-companion-relay.ps1 -StartFull
```

**Fail closed:** if preflight finds unresolved inbound command state, `-StartFull` exits with code **3** and does not start sidecars.

After operator review, override explicitly:

```powershell
.\companion\m0-publish\start-companion-relay.ps1 -StartFull -AcknowledgeInboundRisk
```

This does **not** delete or rewrite remote/local commands; it only allows the relay to start despite reported blockers.

### Stop sidecars

Press **Ctrl+C** in the terminal running `-StartOutbound` or `-StartFull`. The launcher sends **SIGTERM** to child Node processes.

If a sidecar was started outside this launcher, stop that terminal or end the `node publish-tactical-once.cjs ...` process manually.

## Log output

Child stdout/stderr are prefixed:

- `[briefing] ...` (sidecar log lines)
- `[command-relay] ...` (sidecar log lines)
- `[notify] ...` (structured, deduplicated lifecycle events — see [companion-relay-notifications.md](./companion-relay-notifications.md))

## Direct Node CLI (optional)

```text
node companion/m0-publish/companion-relay-launcher-cli.cjs --preflight
node companion/m0-publish/companion-relay-launcher-cli.cjs --start outbound
node companion/m0-publish/companion-relay-launcher-cli.cjs --start full --acknowledge-inbound-risk
```

## What this launcher does not do

- Launch or restart OpenXcom
- Set `OPENXCOM_COMPANION_COMMAND_EXECUTOR`
- Archive or delete commands/results
- Reset sidecar or engine journals
- Clear GitHub relay files
- Edit `companion-soldier-control.json`

## Tests

```bash
cd companion/m0-publish
npm test
```

Includes `companion-relay-launcher.test.cjs` (mocked `gh`, remote reads, and child processes).
