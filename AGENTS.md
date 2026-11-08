# Open X-Com Companion — agent notes

Guidance for coding agents (Cursor, etc.) working in the **Companion** repository and an optional **workspace** that also contains `engine/OpenXcom`, `local/m0`, and `runtime/m0`. Paths below use `companion/` as this repo root; in a workspace, `companion/` is the clone under `$WorkspaceRoot`.

Workspace layout: [docs/WORKSPACE-LAYOUT.md](docs/WORKSPACE-LAYOUT.md). Live cooperative play with external GPT: [docs/ASTER-LIVE-PLAYBOOK.md](docs/ASTER-LIVE-PLAYBOOK.md).

## Tactical briefing (F6 → `m0/state.json`)

After a **fresh** F6 export or `BRIEFING_PUBLISHED` notification, read GitHub `m0/state.json` and run the **mandatory battlefield status review** before planning or authoring commands.

Full sequence and Stage D example: `m0-publish/lib/tactical-briefing-ai-workflow.cjs` (`getAiBriefingInstructionsMarkdown()`).

Cursor users may install [contrib/cursor/rules/tactical-briefing-m1-mandatory-status.mdc](contrib/cursor/rules/tactical-briefing-m1-mandatory-status.mdc).

Operator runbook: `m0-publish/docs/tactical-command-m1-20b.md` (step 9).

Use **`unitStateBrief.exceptions`** and **`commandBinding`** only — do not duplicate status into a new relay field.

### Hostile intelligence (M1-WP5)

After status review, apply the fair-play contract in `m0-publish/lib/hostile-intelligence-consumer.cjs` (also embedded in `getAiBriefingInstructionsMarkdown()`):

- `units[]` with **`facing`** = confirmed current LOS at export; **`classifyCurrentHostileObservation()`** separates genuine aliens (`confirmed_current_los`) from neutrals, MC roster, and other visible non-targets (`confirmed_current_los_*`).
- **`perceptionLog`** = bounded historical memory, not a complete visible-unit list; missing events do not imply a unit is hidden.
- **`last_seen`** coordinates are historical only; never treat as live position when the unit is absent from `units[]`.
- Do not merge **`perceptionLog`** across different **`sessionId`** values.
- Mind-controlled roster soldiers: hostile for threat assessment, not in **`commandBinding.player_soldiers`**.
- Psychological `perceptionLog` `*_observed` events are historical UI notifications only — not current readiness or command authority.

## Tactical command publishing (GitHub inbox)

Publish remote **`m0/tactical-command.json`** only through the tested CLI — **never** with raw `gh api` PUT to the Contents API.

**Cooperative autonomy:** During an authorized cooperative session, the agent may **independently** publish supported commands for **AI-owned** soldiers (see `companion-soldier-control.json` beside the live snapshot under `local/m0/`). Session identity and `commandBinding` are the authorization boundary — **do not** ask the operator to approve each MOVE/KNEEL/shot. **Human-controlled** soldiers stay off-limits. **END_TURN** (when supported) remains **human-only**; do not publish END_TURN for the agent.

### Canonical procedure

1. Read fresh GitHub **`m0/state.json?ref=main`** (or your configured relay branch) and its **`commandBinding`** (after mandatory battlefield status review above).
2. Compose the command with existing utilities in `m0-publish/lib/command-binding.cjs` (e.g. `composeMoveCommand`, `composeKneelCommand`, `composeDirectedFireCommand`) using the **current** binding — do not hand-edit binding fields or reuse stale `snapshot_sha256` / `state_version` / `session_id`.
3. Respect **AI-owned soldier** restrictions and **`commandBinding.player_soldiers`**; exclude mind-controlled roster soldiers and units not commandable at export.
4. Write the JSON draft to a local file (e.g. `$WorkspaceRoot/local/m0/tactical-command-draft.json`).
5. Validate:  
   `node m0-publish/publish-tactical-command-once.cjs --dry-run --path <draft>`
6. If dry-run succeeds, publish:  
   `node m0-publish/publish-tactical-command-once.cjs --publish --path <draft>`
7. Read the **structured CLI outcome** (`ok`, `mode`, `reason`, `github_ops`, error `code`) before treating publication as successful.
8. Treat **`remote_unchanged` / skipped** as idempotent success **only** when the remote command matches the full draft (same `command_id` and body).
9. Treat **`inbox_occupied`**, stale bindings, validation errors, and GitHub failures as **hard failures** — investigate or refresh state from a new F6 export; **never** overwrite a competing inbox or bypass the CLI.

Operator runbook detail: `m0-publish/docs/tactical-command-m1-20b.md` (steps 11–12). Implementation: `m0-publish/lib/relay-tactical-command-publish.cjs`.

Relay configuration: `m0-publish/docs/relay-github-setup.md`, `m0-publish/config/relay.local.example.json` (copy to gitignored `relay.local.json`).

## C++ / MSBuild — incremental verification

When working in `engine/OpenXcom` (sibling clone under the workspace): build the **smallest failing target** first (one `.vcxproj` or a short MSBuild `/t:` list) until compile is clean; run the relevant **`companion_*_test.exe`** harnesses second; link **full `openxcom`** last. Avoid repeated full-game links while fixing errors. Isolated trees stay separate from canonical **`runtime/m0/bin/openxcom.exe`** unless deployment is explicitly requested.

Deploy and launch: `scripts/workspace/deploy-openxcom.example.ps1` and `Start-CompanionOpenXcom.example.ps1` with `-WorkspaceRoot`, or operator copies under `runtime/m0/`. SHA pin: `m0-publish/lib/companion-canonical-runtime.cjs` → `VERIFIED_BUILD_SHA256`.
