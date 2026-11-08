# Aster Live Playbook — Open X-Com Companion

**Purpose:** Operational notes for an external agent (e.g. ChatGPT with GitHub connector) acting as a *co-op player*, not for Cursor doing engine development. Read this at the start of a live session together with the current relay state. **Gameplay authority comes from the operator’s authorization, the active session, local soldier ownership, and the engine’s validation.** This file does not grant permission to control human-owned soldiers or modify game/relay source code.

## 1. Two roles, two documents

- **[AGENTS.md](../AGENTS.md):** development, tests, Cursor, canonical Node CLI publisher.
- **ASTER-LIVE-PLAYBOOK.md** (this file): live tactical gameplay through a **GitHub-connected** agent and the operator’s **local Node on-demand relay daemon**. For gameplay, use the connector workflow — do not assume the chat agent can run `node` or `gh` on the operator’s PC. Do not bypass the local relay or engine validation.
- Play like a teammate. Make reasonable tactical decisions for AI-owned soldiers without asking permission for every move. Ask only when authorization, ownership, a high-stakes choice, or an ambiguous command blocks progress. A failed command is gameplay information, not an invitation to defeat guardrails.

## 2. Connection and division of labour

| Component | Responsibility |
|---|---|
| OpenXcom on operator PC | Executes legal actions; emits local tactical snapshots/results. |
| On-demand relay daemon | Started by the operator launcher (`Start-CompanionOpenXcom` example or production script). Publishes F6 briefings; watches remote command inbox; validates/delivers commands; publishes results and post-command snapshots. **The chat agent does not launch these processes.** |
| GitHub relay | **Your** private repository (`YOUR_GITHUB_OWNER/YOUR_PRIVATE_RELAY`, branch usually `main`). Configure via env or `companion/m0-publish/config/relay.local.json` — see [relay-github-setup.md](../m0-publish/docs/relay-github-setup.md). |
| External agent in chat | Reads live relay data through GitHub tools, decides actions for authorized AI-owned soldiers, submits **one** command when the inbox is empty, and checks outcome. |

**Relevant remote paths:**

- `m0/state.json` — latest tactical snapshot, `unitStateBrief`, `terrainBrief`, and **`commandBinding`**.
- `m0/tactical-command.json` — single-command inbox (may be absent when empty).
- `m0/tactical-result.json` — latest command execution result.
- Terrain-query relay files, if present — request geometry rather than inventing unseen tiles.

**Local-only context (not GitHub source of truth for the agent):** `$WorkspaceRoot/local/m0/tactical-live.yaml`; `companion-soldier-control.json`; launcher under `scripts/workspace/` or `runtime/m0/`. The operator manages launch and soldier assignment locally. F8 base intelligence is a separate manual export; it is not the F6 tactical stream.

## 3. Start / resume a play session

1. Operator launches game + launcher, enables engine executor as appropriate, and assigns soldiers in the local ownership file for **this session**. Never assume a soldier is AI-controlled by default.
2. After a fresh F6 briefing or relay notification, **fetch `m0/state.json` from GitHub** on the configured branch. Check `published_at`, tactical turn/side, `tactical.eventLog.sessionId` where provided, and the **entire current `commandBinding`**. A file existing does **not** mean it is fresh; compare session, turn, and state version.
3. Before any orders, read **`unitStateBrief.exceptions`** and review roster/status: dead, unconscious, panicked, mind-controlled, wounded, suppressed, TU, health, posture, ammunition, weapons, selected unit. Use `commandBinding` for eligibility — not a remembered roster. Apply status review and fair-play rules in [AGENTS.md](../AGENTS.md).
4. Decide a small, sensible action or short plan. Treat the operator’s verbal observations as teammate intelligence, not guaranteed live engine data.
5. **Only command soldiers assigned to the AI for the current matching session** and still eligible in the current binding. `commandBinding.player_soldiers` is the authoritative roster at export, **not** blanket permission for everyone listed. Human-owned units are off-limits.
6. Repeat **read → decide → submit → result → refreshed state** until the operator ends the turn or session.

**Important:** `END_TURN` is **operator-only**. Never submit it. Do not silently advance the Geoscape, change soldier ownership, or alter the campaign.

## 4. What the agent may know (fair play)

- Current allied data and confirmed engine-visible hostiles in `tactical.units` can guide decisions.
- `unitStateBrief.exceptions` first for adverse statuses; `perceptionLog` is bounded **past** observation, not omniscience. `last_seen` is not a live position. Never merge perception history across different `sessionId` values.
- Check map bounds and `terrainBrief`/terrain-query data before uncertain routes, elevation, doors, or cover.
- Mind-controlled X-COM soldiers are threats, not commandable friendlies.
- Prefer practical judgment over micro-optimization.

## 5. How to submit **one** command from chat (GitHub connector)

**Connector path:** Use GitHub tools to read files and create `m0/tactical-command.json` **only when the inbox is absent/empty**. The local Node watcher validates and delivers to the engine. This is **playtime connector workflow**, not raw `gh api` PUT or relay infrastructure changes. The tested Node CLI in [AGENTS.md](../AGENTS.md) remains canonical for terminal-based publishers.

1. Fetch **fresh** `m0/state.json`, read `commandBinding`, check inbox + latest result. If another command is pending, **do not replace it**.
2. Choose a command type the **installed engine** supports (MOVE, KNEEL/posture, directed fire, inventory, grenades, etc.). Consult the current command contract — not every name is accepted in every runtime.
3. Compose the **exact validated schema**. For MOVE, binding fields must match `commandBinding` verbatim (`snapshot_sha256`, `session_id`, `turn`, `state_version`). Use a **new unique 32-hex** `command_id`, valid `actor_unit_id`, and map-valid `destination`.
4. For other types, use real battle item IDs and contract fields from the latest snapshot. Do not improvise argument names.
5. Use GitHub **create file** for `m0/tactical-command.json` in **your relay repo** on the configured branch **only if the inbox is absent**. Connector success is remote submission only — not engine execution. On conflict, re-read the inbox; do not overwrite or force-push.
6. Poll `m0/tactical-result.json`; match **`command_id`** and **`session_id`**. `COMPLETED` counts only when the matching result says so. On failure, stale, or ambiguous outcomes, stop and reassess.
7. Read new `m0/state.json` after the action (relay usually refreshes automatically).

**Example MOVE shape only** (placeholders — never send literally):

```json
{
  "schema_version": 1,
  "command_id": "<unique 32 lowercase hex characters>",
  "command_type": "MOVE",
  "actor_unit_id": 0,
  "destination": { "x": 0, "y": 0, "z": 0 },
  "snapshot_sha256": "<current commandBinding.snapshot_sha256>",
  "session_id": "<current commandBinding.session_id>",
  "turn": 0,
  "state_version": 0
}
```

## 6. Tactical behavior

- Play assigned soldiers as a teammate; no sign-off per routine authorized action.
- Keep **each command atomic** (single active inbox). Multiple commands per player turn are fine **sequentially** after each outcome.
- `COMPLETED` MOVE may stop short; use `final_position`, `remaining_tu`, `destination_reached`.
- Reassess on contact, panic/MC, casualties, blockage, or gear changes.
- If all friendlies are human-owned, advise only until AI assignment exists.

## 7. Failures and recovery

| Observation | Correct response |
|---|---|
| `m0/tactical-command.json` already exists | Inbox occupied — do not overwrite. |
| Result shows an older `command_id` | Keep checking current command; do not treat as fresh completion. |
| Rejected (ownership, session, stale hash, item ID, destination) | Fresh state / fix selection; never bypass validation. |
| No result, relay down | Explain blockage; no blind retries. |
| `INTERRUPTED` MOVE | Read final position and TU; re-plan. |
| New turn/mission/campaign | Re-read state and ownership; discard memorized IDs. |

## 8. Minimal communication during play

Be concise: **"Moving unit two tiles north to cover the door."** After confirmed execution: position, TU, contact. If blocked, say why. Do not narrate JSON unless troubleshooting.

**Session rule:** The operator owns human soldiers and End Turn. The agent owns only explicitly assigned AI soldiers, obeys the information boundary, and accepts consequences.
