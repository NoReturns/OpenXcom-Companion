# M1-20 live MOVE preparation (do not execute until owner approves)

This checklist prepares the first authorized cooperative MOVE. **Do not publish live GitHub commands or enable the executor until you explicitly approve each step.**

## Preconditions

- GitHub CLI authenticated (`gh auth status`) for relay read/write.
- Tactical snapshot on disk matches the battle you will load (typically `local/m0/tactical-live.yaml` via F6 export).
- `m0/command.json` ping contract unchanged; this workflow uses **`m0/tactical-command.json`** and **`m0/tactical-result.json`** only.

## Owner workflow

1. **Launch staged executable**  
   Use the Release Win32 build you validated for this milestone (not an ad-hoc debug build unless intentionally chosen). Do not use this doc to pick a hardcoded destination or soldier id.

2. **Start sidecars** (separate terminals)  
   - Briefing/snapshot relay (existing):  
     `node companion/m0-publish/publish-tactical-once.cjs --briefing-watch --publish`  
   - Command + terrain query relay (M1-20):  
     `node companion/m0-publish/publish-tactical-once.cjs --command-relay-watch --publish --path <absolute-path-to-tactical-live.yaml>`

3. **Load tactical save** in OpenXcom and enter the intended battle.

4. **Obtain battle session ID**  
   From the latest F6 tactical export / relay payload: `eventLog.sessionId` (32 lowercase hex). Confirm it matches `briefing-request.json` / local snapshot.

5. **Assign one soldier to AI control locally**  
   Edit **`companion-soldier-control.json`** beside the tactical YAML (same directory as `OPENXCOM_COMPANION_SNAPSHOT_PATH`):

   ```json
   {
     "schema_version": 1,
     "session_id": "<battle session id>",
     "assignments": { "<soldier unit id>": "ai" }
   }
   ```

   Default for all soldiers is human. **Remote commands cannot change this file.**

6. **Export fresh tactical snapshot (F6)**  
   Review units, TU, turn, and terrain in the new YAML before choosing any destination.

7. **Enable executor explicitly (owner only)**  
   Set environment variable **`OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`** together with existing **`OPENXCOM_COMPANION_SNAPSHOT_PATH`** pointing at the tactical YAML file.

8. **Authorize one MOVE command**  
   After reviewing the snapshot, publish exactly one `m0/tactical-command.json` with:
   - `snapshot_sha256` = SHA-256 of on-disk tactical YAML bytes
   - `session_id` / `turn` matching the snapshot
   - `actor_unit_id` = locally AI-assigned soldier
   - `destination` reachable under player knowledge (use terrain query relay if needed)

9. **Read result via GitHub**  
   Sidecar mirrors local `tactical-result.json` to **`m0/tactical-result.json`**. Wait for terminal status (`COMPLETED`, `FAILED`, `INTERRUPTED`, or `REJECTED`). `EXECUTING` is not terminal.

10. **Disable executor immediately**  
    Unset `OPENXCOM_COMPANION_COMMAND_EXECUTOR` (or set to anything other than `1`) before continuing manual play.

## Verification status labels

| Step | Status after M1-20 automated work |
|------|-----------------------------------|
| Sidecar poll/deliver/publish | **AUTOMATED TESTED** (fixtures) |
| Engine MOVE execution | **AUTOMATED TESTED** (core tests); **NOT LIVE VERIFIED** |
| End-to-end GitHub MOVE | **IMPLEMENTED**; **NOT LIVE VERIFIED** |

## Explicitly out of scope for first live MOVE

- FIRE, KNEEL, or remote ownership assignment
- Automatic command retries
- Running the game inside this milestone automation
