# M1-20B — Remote MOVE authoring and live preflight

## Can ChatGPT author a MOVE from GitHub alone?

**Yes**, after this milestone, when `m0/state.json` includes **`commandBinding`** from a verified sidecar publish:

| Command field | Remote source |
|---------------|---------------|
| `snapshot_sha256` | `commandBinding.snapshot_sha256` (SHA-256 of tactical **YAML bytes** at publish — not `snapshot_id`) |
| `state_version` | `commandBinding.state_version` (= `eventLog.latestSeq` at export) |
| `session_id` | `commandBinding.session_id` |
| `turn` | `commandBinding.turn` |
| `actor_unit_id` | Choose from `commandBinding.player_soldiers[].id` (or `tactical.units` player soldiers) |
| `destination` | Commander-chosen; use `terrainBrief`, `m0/terrain-query.json`, and visible snapshot geometry only |
| `command_id` | New unique id per attempt |

Use `composeMoveCommand(commandBinding, { commandId, actorUnitId, destination })` in Node tooling, or copy fields manually from `commandBinding`.

**Do not** derive `snapshot_sha256` from relay JSON or `snapshot_id`.

## Freshness semantics

- **`snapshot_id`**: canonical hash of tactical **JSON** in relay (unchanged).
- **`snapshot_sha256`**: hash of on-disk **YAML file bytes** when the sidecar/engine exported (execution binding).
- **`state_version`**: `eventLog.latestSeq` frozen at that export; engine rejects stale values after a newer F6 export.

Reformatting relay JSON does not change either hash if the underlying YAML bytes and event log are unchanged.

## Canonical first live MOVE preflight (no execution here)

1. Preserve `local/m0/user` saves, `config/options.cfg`, runtime deps, and existing executable backups — do not overwrite.
2. Build or select the validated **Release Win32** `OpenXcom.exe` already staged under your milestone backup path.
3. Set `OPENXCOM_COMPANION_SNAPSHOT_PATH` to the absolute path of `local/m0/tactical-live.yaml` (or your live export file).
4. **Do not** set `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1` during preflight.
5. Terminal A — briefing relay:  
   `node companion/m0-publish/publish-tactical-once.cjs --briefing-watch --publish --path <tactical-live.yaml>`
6. Terminal B — command + terrain query relay:  
   `node companion/m0-publish/publish-tactical-once.cjs --command-relay-watch --publish --path <tactical-live.yaml>`
7. Launch OpenXcom from staged binary; load the intended tactical save (human play only).
8. Press **F6** once battle state is stable; confirm `briefing-ack.json` and GitHub `m0/state.json` updated.
9. Read GitHub `m0/state.json`:
   - Confirm `commandBinding.snapshot_sha256`, `state_version`, `session_id`, `turn`.
   - Pick `actor_unit_id` from `commandBinding.player_soldiers`.
   - Plan destination using `terrainBrief` / terrain query relay (no hidden cells).
10. Locally assign **one** soldier in `companion-soldier-control.json` (`"ai"`) beside the YAML; all others remain human by default.
11. Draft (but **do not publish** until owner approves) `m0/tactical-command.json` using `commandBinding` fields plus chosen destination and a fresh `command_id`.
12. When approved for live test only: enable executor env, publish command, read `m0/tactical-result.json`, then disable executor immediately.

See also [tactical-command-m1-20.md](./tactical-command-m1-20.md).

## Verification status

| Item | Status |
|------|--------|
| Relay exposes authoring metadata | **IMPLEMENTED** |
| Sidecar + Node handshake tests | **AUTOMATED TESTED** |
| Engine `state_version` gate | **IMPLEMENTED**, **AUTOMATED TESTED** |
| Live GitHub-authored MOVE | **NOT VERIFIED** |
