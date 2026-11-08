# Manual upload fallback (M1 P3)

Two independent fallback paths write **read-only** battlefield intelligence when automatic GitHub transport cannot carry the full payload. Neither path grants tactical **command authority**; live `commandBinding` remains tied to the on-disk tactical snapshot SHA only.

## Paths and reason codes

| Path | Producer | Reason code | Upload necessity |
|------|----------|-------------|------------------|
| **Engine (F6 export)** | `engine` | `ENGINE_V5_OVERSIZE` | **Optional** — automatic export stays on schema **v4** within the 256 KiB cap; relay/SEND can still use the live snapshot. |
| **Node (relay publish)** | `node` | `RELAY_SHRINK_EXHAUSTED` | **Required** for GitHub delivery — adaptive shrink exhausted; no automatic publish. |

Full schema **v5** terrain can exceed **256 KiB early in a mission** (large maps, dense v5 terrain). The engine still writes a v4 automatic snapshot for transport; the manual JSON holds the full v5 YAML for partners who want complete terrain.

## On-disk layout (snapshot directory)

All paths are sibling to the live tactical snapshot (`OPENXCOM_COMPANION_SNAPSHOT_PATH` parent):

- `companion-manual-upload-notice.json` — shared notice (engine or node; ownership/precedence rules apply).
- `manual-exports/*.json` — self-contained manual intelligence artifacts (`engine-v5_*` or `relay-manual_*`).
- `companion-tactical-send-marker.json` — session/turn binding for in-game HUD freshness (read-only consumer).

Optional override: `OPENXCOM_COMPANION_MANUAL_EXPORT_DIR` (engine only) redirects artifact output; notice path stays beside the snapshot.

## In-game HUD wording

- `ENGINE_V5_OVERSIZE` → **FULL TERRAIN EXPORT AVAILABLE** (detail: optional upload; v4 automatic path OK).
- `RELAY_SHRINK_EXHAUSTED` → **MANUAL UPLOAD REQUIRED** (detail: relay delivery unavailable).

The relay status strip may still show `Manual upload required` during Node terminal phases; that is separate from the notice HUD line.

## Notice lifecycle

- **Active** (`active: true`, valid `artifact_path`) → HUD shows when session/turn match `companion-tactical-send-marker.json`.
- **Engine** notice cleared when a later F6 export produces v5 under the automatic cap (`cleared_reason: automatic_v5_export`).
- **Node** notice cleared after successful relay publish (`clearNodeManualUploadNotice`, `cleared_reason: relay_published`).
- **Precedence**: Node does not replace an active **engine** notice; engine does not replace an active **node** notice.

## Artifact retention

After each successful artifact write, a bounded cleanup runs in `manual-exports/`:

- **Never delete** the artifact referenced by the active notice.
- **Never delete** the file just written (even if notice replace was skipped).
- **Retain** the protected set plus **3** additional newest eligible files (`engine-v5_*.json`, `relay-manual_*.json`).
- Does not touch unrelated snapshot, relay, journal, or campaign files.

## Redundant engine exports

If an active **engine** notice already matches the same `session_id`, `turn`, and `snapshot_id` (v5 content id), a repeat F6 does **not** write another artifact. Node relay attempts may still produce multiple timestamped files when shrink fails again with updated payload; retention pruning limits disk use.

## Command authority

Manual artifacts include `command_authority.authoritative: false`. Do not publish tactical commands from manual JSON or notice fields.

## Step 6 isolated validation (harness)

Engine (`build-wp8-isolated/bin/Release`):

- `companion_manual_upload_integration_test.exe` — v4/v5 oversize, HUD labels, dedup, retention, 4 MiB cap
- `companion_manual_v5_export_test.exe` — includes missing-artifact dedup guard
- `companion_manual_upload_hud_test.exe`, `companion_manual_export_retention_test.exe`

Node (`companion/m0-publish`):

- `node --test test/manual-upload-p3-step6-integration.test.cjs` — relay shrink path, retention, cap, malformed notice (temp dirs only; production journal fingerprint asserted)

Disposable trees: `companion_manual_upload_integration_test_tmp/`, `companion_manual_v5_export_test_tmp/`, OS temp `m0-p3-step6-*`.

Full link: `MSBuild ...\\build-wp8-isolated\\src\\openxcom.vcxproj /p:Configuration=Release` (does **not** replace `runtime/m0/bin/openxcom.exe`).
