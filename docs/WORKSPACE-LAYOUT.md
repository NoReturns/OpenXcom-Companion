# Workspace layout (OpenXcom + Companion)

Companion M1 assumes a **parent workspace directory** that contains two separate Git clones plus local play directories. This repository (`companion/`) is only one piece; you also need a patched engine build, legal X-COM data, and your own private GitHub relay.

Replace `$WorkspaceRoot` with any path on your machine (examples use POSIX-style names only).

## Required directory tree

```text
$WorkspaceRoot/
  companion/                    ← clone https://github.com/NoReturns/OpenXcom-Companion.git
    m0-publish/                 ← Node daemons, CLIs, relay libraries
    scripts/workspace/          ← example launcher/deploy templates (copy or run in place)
  engine/
    OpenXcom/                   ← clone https://github.com/NoReturns/OpenXcom.git (branch aster/m0)
      build-isolated-m1-23e/
        bin/Release/openxcom.exe  ← verified isolated Win32 Release build output
  local/
    m0/
      user/                       ← OpenXcom -user / -config (saves, options)
      tactical-live.yaml          ← engine tactical snapshot (F6 / SEND DATA)
      tactical-command.json       ← local command journal (executor)
      tactical-result.json        ← local execution result
      companion-soldier-control.json  ← optional AI/human soldier ownership (gitignore locally)
      backups/                    ← quarantine archives for stale inbox files
  runtime/
    m0/
      bin/
        openxcom.exe              ← deployed play binary (copied from engine build)
        *.dll                     ← SDL / yaml-cpp runtime DLLs beside the exe
        standard/                 ← X-COM data (UFO/TFTD assets you own legally)
        openxcom.deploy-manifest.json  ← written by deploy script
```

You may keep production launchers under `runtime/m0/` (as in a full operator workspace) or run the **example** scripts from `companion/scripts/workspace/` with `-WorkspaceRoot`.

## Git repositories

| Clone into | Remote | Branch (M1) |
|------------|--------|-------------|
| `$WorkspaceRoot/companion` | `https://github.com/NoReturns/OpenXcom-Companion.git` | `main` |
| `$WorkspaceRoot/engine/OpenXcom` | `https://github.com/NoReturns/OpenXcom.git` | `aster/m0` |

Engine and Companion are **independent** Git repos. The workspace root is **not** a Git repository unless you create one for your own convenience.

Pin for M1 closeout: engine tag `m1-lifecycle-closeout-2026-11-08` on `aster/m0`.

## Node.js and GitHub CLI

On the game PC:

1. **Node.js** ≥ 22 — install dependencies from `companion/m0-publish/`:
   ```bash
   cd companion/m0-publish
   npm ci
   ```
2. **GitHub CLI** (`gh`) on `PATH`:
   ```powershell
   gh auth login
   gh auth status --hostname github.com
   ```
   Use a token with `repo` scope for your **private relay**. Never commit tokens.

Preflight (no game, no daemon start required for basic checks):

```powershell
cd companion\m0-publish
node companion-relay-launcher-cli.cjs --preflight
```

## External relay configuration

Companion **fails closed** until a relay destination is set. Use **your** private empty GitHub repo — not another operator’s.

**Option A — environment**

```powershell
$env:OPENXCOM_COMPANION_RELAY_REPO = 'YOUR_GITHUB_OWNER/YOUR_PRIVATE_RELAY'
$env:OPENXCOM_COMPANION_RELAY_BRANCH = 'main'   # optional
```

**Option B — gitignored local file**

```powershell
Copy-Item companion\m0-publish\config\relay.local.example.json companion\m0-publish\config\relay.local.json
# Edit "repo" and optional "branch" — never commit relay.local.json
```

Precedence: `OPENXCOM_COMPANION_RELAY_REPO` overrides `relay.local.json`. Optional path override: `OPENXCOM_COMPANION_RELAY_CONFIG`.

The example launcher loads `relay.local.json` into the environment when the env var is unset (same as production `Start-CompanionOpenXcom.ps1`).

Remote paths on your relay branch (defaults): `m0/state.json`, `m0/tactical-command.json`, `m0/tactical-result.json`, optional terrain and rules-reference files. See [m0-publish/docs/relay-github-setup.md](../m0-publish/docs/relay-github-setup.md).

## Game assets

- Companion and the engine fork **do not** ship X-COM/ufo data.
- Place legal UFO/TFTD (or OpenXcom `standard`) assets under `$WorkspaceRoot/runtime/m0/bin/standard/` (or paths your OpenXcom build expects).
- Point the launcher at `$WorkspaceRoot/local/m0/user` for saves via OpenXcom `-user` / `-config`.

## Engine build

1. Clone **OpenXcom** into `$WorkspaceRoot/engine/OpenXcom` and check out **`aster/m0`**.
2. Build the **isolated Win32 Release** tree documented for M1 (output directory name in this milestone: `build-isolated-m1-23e/bin/Release/openxcom.exe`).
3. On Windows, use MSBuild / Visual Studio per engine docs in the fork. Build the smallest failing test target first when iterating; link full `openxcom` when ready.

Companion code resolves build and runtime paths via `companion/m0-publish/lib/companion-canonical-runtime.cjs` → `companionRuntimeLayout(workspaceRoot)`.

## Deploy verified executable

After a successful isolated Release build:

1. Ensure `VERIFIED_BUILD_SHA256` in `companion/m0-publish/lib/companion-canonical-runtime.cjs` matches the **lowercase SHA-256** of your verified `openxcom.exe` (update and commit in the Companion repo when you promote a new binary).
2. Copy required DLLs next to the runtime exe (`SDL.dll`, `SDL_image.dll`, `SDL_mixer.dll`, `SDL_gfx.dll`, `yaml-cpp.dll`, `zlib1.dll`).
3. Run deploy (production script on disk, or example template):

   ```powershell
   # Production (if you use runtime/m0/ in workspace):
   & "$WorkspaceRoot\runtime\m0\deploy-openxcom.ps1"

   # Or example from Companion repo:
   & "$WorkspaceRoot\companion\scripts\workspace\deploy-openxcom.example.ps1" -WorkspaceRoot $WorkspaceRoot
   ```

Deploy refuses to run while OpenXcom is running, verifies build hash against the pin, checks DLLs in `runtime/m0/bin`, backs up the previous exe, and writes `openxcom.deploy-manifest.json`.

## Launch (game + on-demand relay)

```powershell
& "$WorkspaceRoot\companion\scripts\workspace\Start-CompanionOpenXcom.example.ps1" -WorkspaceRoot $WorkspaceRoot
```

Optional: copy the example to `$WorkspaceRoot/runtime/m0/Start-CompanionOpenXcom.ps1` and adjust only paths if you prefer the production layout.

The launcher:

- Runs inbox quarantine (`quarantine-tactical-inbox.cjs`) unless `-SkipInboxQuarantine`.
- Verifies `runtime/m0/bin/openxcom.exe` SHA-256 against `VERIFIED_BUILD_SHA256` unless `-SkipDeployVerify`.
- Loads relay config, sets `OPENXCOM_COMPANION_SNAPSHOT_PATH`, `OPENXCOM_COMPANION_COMMAND_EXECUTOR=1`.
- Stops legacy continuous relay sidecars, starts session-scoped on-demand daemon, starts OpenXcom, waits for exit, shuts down daemons.

Switch `-EnableTerrainFullAsciiRelay` sets `OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII=1`.

## Environment variables (summary)

| Variable | Purpose |
|----------|---------|
| `OPENXCOM_COMPANION_WORKSPACE_ROOT` | Optional default for example PowerShell scripts |
| `OPENXCOM_COMPANION_RELAY_REPO` | `owner/repo` for relay (overrides local JSON) |
| `OPENXCOM_COMPANION_RELAY_BRANCH` | Relay branch (default `main`) |
| `OPENXCOM_COMPANION_RELAY_CONFIG` | Path to relay JSON config file |
| `OPENXCOM_COMPANION_SNAPSHOT_PATH` | Set by launcher to `local/m0/tactical-live.yaml` |
| `OPENXCOM_COMPANION_COMMAND_EXECUTOR` | `1` enables in-game command executor |
| `OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII` | `1` optional full ASCII terrain relay |
| `COMPANION_RELAY_ISOLATION_CONFIG` | Isolated e2e / non-production relay only |

## Executable SHA verification

Single pin: `VERIFIED_BUILD_SHA256` in `companion-canonical-runtime.cjs`. The deploy script compares the **build tree** exe to the pin; the launch script compares **runtime** exe to the pin. Do not weaken these checks for convenience.

Current M1 closeout pin (update when you promote a new verified build):

`08442e36b745f9dd91e756291d62f556a58f4a395fa8bd67d0fc9257233f6cd9`

## local/m0 operator files

| File | Role |
|------|------|
| `tactical-live.yaml` | Live battlescape snapshot export |
| `companion-soldier-control.json` | Human vs AI soldier ownership for cooperative play |
| `tactical-command.json` / `tactical-result.json` | Local executor journal |
| `companion-rules-reference.json` | Optional Ctrl+Shift+R rules export (see runtime docs in repo) |

Keep saves, ownership, and `relay.local.json` **out of public Git**.

## Reproducibility checklist

A new operator with two clones can reach cooperative play when they:

1. Create the workspace tree above.
2. Configure relay (`relay.local.json` or env) and `gh auth`.
3. Build engine on `aster/m0`, align `VERIFIED_BUILD_SHA256`, deploy to `runtime/m0/bin`.
4. Install X-COM data into runtime `bin`.
5. Create `local/m0/user` and start a mission; use F6 / SEND DATA and on-demand relay buttons.

Further reading: [AGENTS.md](../AGENTS.md), [ASTER-LIVE-PLAYBOOK.md](ASTER-LIVE-PLAYBOOK.md), [m0-publish/docs/relay-github-setup.md](../m0-publish/docs/relay-github-setup.md).
