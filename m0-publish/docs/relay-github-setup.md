# GitHub relay setup (M1)

Companion uses a **private GitHub repository** as a tactical bus between the game PC and an external agent. No relay repo is embedded in the public source tree.

## 1. Create the repository

1. Create a **private** empty repository on GitHub (for example `your-user/OpenXcom-Companion-Relay`).
2. Use branch **`main`** unless you configure another branch.
3. Grant your GitHub account (and any automation account) permission to read and write repository contents on that branch.

Companion expects these **remote paths** on the configured branch (defaults):

| Path | Purpose |
|------|---------|
| `m0/state.json` | Latest tactical briefing / snapshot relay |
| `m0/tactical-command.json` | Single-command inbox |
| `m0/tactical-result.json` | Latest command execution result |
| `m0/terrain-query.json` | Optional terrain query request |
| `m0/terrain-query-result.json` | Optional terrain query response |
| `m0/rules-reference.json` | Optional rules reference upload |

Files may be absent until the first publish; Companion creates them via the GitHub Contents API.

## 2. Authenticate the GitHub CLI

On the machine that runs Companion:

```powershell
gh auth login
gh auth status --hostname github.com
```

Use a token with `repo` scope for a private relay. **Do not** store tokens in this repository.

## 3. Point Companion at your relay

**Option A — environment (scripts / CI)**

```powershell
$env:OPENXCOM_COMPANION_RELAY_REPO = 'your-user/your-private-relay'
$env:OPENXCOM_COMPANION_RELAY_BRANCH = 'main'   # optional
```

**Option B — gitignored local file (daily play)**

```powershell
Copy-Item m0-publish\config\relay.local.example.json m0-publish\config\relay.local.json
# Edit relay.local.json — set "repo" and optional "branch"
```

`relay.local.json` is listed in `.gitignore`. Never commit it.

**Precedence:** `OPENXCOM_COMPANION_RELAY_REPO` wins over `relay.local.json`. Daemons and CLIs call `applyRelayEnvFromLocalConfig()` before resolving the relay.

Optional override for the local file path: `OPENXCOM_COMPANION_RELAY_CONFIG`.

## 4. Monorepo launcher (optional)

If you use `runtime/m0/Start-CompanionOpenXcom.ps1` in the full workspace, it loads `companion/m0-publish/config/relay.local.json` into the process environment when `OPENXCOM_COMPANION_RELAY_REPO` is not already set.

## 5. Validate configuration (read-only)

```powershell
cd companion\m0-publish
node companion-relay-launcher-cli.cjs --preflight
```

Preflight checks Node, `gh` auth, snapshot path, **relay configuration**, and local/remote inbox safety without starting sidecars.

Dry-run a snapshot publish (no GitHub write):

```powershell
node publish-tactical-once.cjs --dry-run --path <path-to-tactical.yaml>
```

The printed **Target** URL must show **your** `owner/repo`, not a third party.

## 6. Hand off to another GPT or coding assistant

Provide:

1. Relay repo name and branch (not tokens).
2. Confirmation that `gh auth status` succeeds on the game PC.
3. `OPENXCOM_COMPANION_SNAPSHOT_PATH` or the path to `tactical-live.yaml` beside `local/m0/`.
4. Links to `m0/state.json` and inbox/result paths in **your** repo.
5. Soldier ownership file (`companion-soldier-control.json`) location relative to the snapshot directory.

The assistant should read `m0/state.json` and respect `commandBinding` — see `AGENTS.md` / `lib/tactical-briefing-ai-workflow.cjs`.

## 7. Isolated / CI testing

For harnesses that must not touch a live cooperative relay, use `config/m1-34e-relay-isolation.example.json` and set:

`COMPANION_RELAY_ISOLATION_CONFIG` → path to your isolated JSON config (separate repo or non-`m0/` prefixes).

## 8. Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `RELAY_CONFIG_MISSING` | Set env var or create `relay.local.json` |
| `GitHub authentication failed` | Run `gh auth login`; check `repo` scope |
| `RATE_LIMIT` | Shared rate-limit gate; wait for reset (HUD may show quota) |
| Preflight `Relay destination` shows wrong repo | Env var overrides local file — inspect `OPENXCOM_COMPANION_RELAY_REPO` |
| `403` on private repo | Grant your GitHub user access to the relay repo |
