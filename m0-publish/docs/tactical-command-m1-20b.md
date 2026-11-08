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
9. Read GitHub `m0/state.json` — **mandatory battlefield status review** (see `lib/tactical-briefing-ai-workflow.cjs` and project `AGENTS.md`):
   1. Read `unitStateBrief.exceptions` **before** tactical planning.
   2. Flag panic, berserk, mind control (`mind_controlled_roster_soldier`), and low-morale heuristics.
   3. Separate **confirmed** readiness/MC from **heuristic** morale/energy entries.
   4. Cross-check `commandBinding.player_soldiers` — do not order mind-controlled roster soldiers.
   5. Include significant status in the tactical assessment (transient panic between exports is **unknown** unless readiness shows it at export).
   6. Apply hostile intelligence fair-play (`lib/hostile-intelligence-consumer.cjs`): `units[]` + `facing` = current visible hostiles; `perceptionLog` = historical memory only; do not merge different `sessionId` histories.
   - Then confirm `commandBinding.snapshot_sha256`, `state_version`, `session_id`, `turn`.
   - Pick `actor_unit_id` from `commandBinding.player_soldiers`.
   - Plan destination using `terrainBrief` / terrain query relay (no hidden cells).
10. Assign **AI-owned** soldiers in `companion-soldier-control.json` (`"ai"`) beside the live snapshot; leave human-owned soldiers human. The agent publishes commands **only** for AI-owned soldiers during cooperative play. **END_TURN** stays human-controlled.
11. Compose a draft **`tactical-command.json`** object from the current **`commandBinding`** (step 9) plus a fresh **`command_id`**, using `composeMoveCommand` / other helpers in `companion/m0-publish/lib/command-binding.cjs`. Save locally (e.g. `local/m0/tactical-command-draft.json`). Do **not** PUT to GitHub by hand.
12. **Publish via the canonical CLI** (cooperative session — no per-command operator approval):
    - `node companion/m0-publish/publish-tactical-command-once.cjs --dry-run --path <draft>`
    - If valid: `node companion/m0-publish/publish-tactical-command-once.cjs --publish --path <draft>`
    - Confirm structured success (`ok`, `mode`, `reason`, `github_ops`). Treat **`remote_unchanged`** as success only when the full command matches. Treat **`inbox_occupied`**, stale binding, and GitHub errors as failures — refresh from F6/`state.json`; never raw `gh api` PUT or inbox overwrite.
    - Operator **RETRIEVE** in-game executes the order; read `m0/tactical-result.json` after execution when diagnosing outcomes.

See **AGENTS.md** — *Tactical command publishing (GitHub inbox)*.

See also [tactical-command-m1-20.md](./tactical-command-m1-20.md).

## On-demand daemon vs `-StartFull` console outcomes (M1 status visibility)

| Surface | Briefing SEND (`[briefing]` lines) | Tactical command relay (`[notify] COMMAND_*`) |
|---------|-------------------------------------|-----------------------------------------------|
| `start-companion-relay.ps1 -StartFull` | Emitted by the full sidecar stack when briefing watch/publish runs in that process | Emitted when the tactical command watcher publishes or retires orders |
| On-demand relay daemon (`companion-on-demand-relay-daemon.cjs`) | **Yes** — timestamped `[briefing]` lines via `companion-briefing-diagnostics.cjs`; `companion-on-demand-status.json` carries optional `error_code` / `outcome` | **No separate watcher** — command relay runs only in `-StartFull` / explicit command-relay watch; on-demand SEND/RETRIEVE does not duplicate command notifications |

Terminal SEND semantics: `published`, `skipped_unchanged`, `failed`, and `manual_upload_required` remain distinct terminal outcomes; `deferred` (rate limit) stays **non-terminal** (`phase: sending`, `terminal: false`) until a later attempt succeeds or fails.

Manual upload fallback (engine v5 oversize vs relay shrink), notice lifecycle, HUD wording, and `manual-exports/` retention: [manual-upload-fallback-m1-p3.md](./manual-upload-fallback-m1-p3.md).

## Friendly HWP snapshot contract (M1, Issue #3)

Friendly HWPs appear in `tactical.units[]` with **only** `id`, `faction`, `originalFaction`, and `position`. They are **not** listed in `commandBinding.player_soldiers` and are out of scope for remote command and mandatory equipment review. This is intentional M1 behavior, not a v3 export defect. Schema and regression: [M1-wp2-unit-state-schema.md](./M1-wp2-unit-state-schema.md), `test/fixtures/friendly-hwp-sparse-v5.yaml`.

## Node daemon vs AUTO RETRIEVE (Issue #2)

Canonical launcher starts a **session-scoped** on-demand daemon (survives Geoscape; stops with game exit). **AUTO RETRIEVE** is battlescape-only, default off each mission, 30s when enabled, and only schedules RETRIEVE — it does not publish commands or replace the daemon. Full tables: [f6-relay-lifecycle-m1-25c.md](./f6-relay-lifecycle-m1-25c.md#issue-2-node-daemon-vs-auto-retrieve) and operator [ASTER-LIVE-PLAYBOOK.md](../../docs/ASTER-LIVE-PLAYBOOK.md).

## Verification status

| Item | Status |
|------|--------|
| Relay exposes authoring metadata | **IMPLEMENTED** |
| Sidecar + Node handshake tests | **AUTOMATED TESTED** |
| Engine `state_version` gate | **IMPLEMENTED**, **AUTOMATED TESTED** |
| Live GitHub-authored MOVE via `publish-tactical-command-once.cjs` | **READY FOR CONTROLLED LIVE TEST** (agent workflow documented; end-to-end not yet verified in combat) |
