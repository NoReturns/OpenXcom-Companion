# Open X-Com Companion

Open X-Com Companion is experimental tooling that connects a **patched OpenXcom engine** to a **GitHub-hosted tactical relay**. A Node.js sidecar watches local snapshot exports, publishes battle briefings, polls a remote command inbox, and reports results—so an external agent (or your own automation) can cooperate on battlescape decisions within engine-enforced rules.

**Status:** Milestone **M1** (lifecycle closeout). APIs, defaults, and operator workflows are still evolving. Expect breaking changes between milestones.

## Public engine fork

Companion M1 targets the NoReturns OpenXcom fork, branch **`aster/m0`**, with checkpoint tag `m1-lifecycle-closeout-2026-11-08` on the engine repository:

- **Engine:** [https://github.com/NoReturns/OpenXcom](https://github.com/NoReturns/OpenXcom)
- **Development branch:** `aster/m0`

You must build and deploy that engine yourself. This repository does **not** ship game binaries.

## Architecture

| Piece | Repository / location | Role |
|--------|------------------------|------|
| **Engine** | [NoReturns/OpenXcom](https://github.com/NoReturns/OpenXcom) (`aster/m0`) | Battlescape execution, validated snapshots, local command journal, on-demand relay HUD |
| **Companion (this repo)** | `companion/` Node packages | Relay daemons, GitHub publish/retrieve, terrain and briefing processing, tests |
| **GitHub relay** | **Your** private or dedicated GitHub repo | Holds `m0/state.json`, tactical inbox/result, terrain query files—shared between engine PC and agents |

Engine and Companion are **separate Git repositories** on purpose: the engine is a GPLv3 fork of OpenXcom; Companion is the Node orchestration layer that operators run beside the game.

Typical data flow:

1. Engine writes a tactical snapshot (YAML/JSON) to a path you configure (`OPENXCOM_COMPANION_SNAPSHOT_PATH`).
2. Companion daemons publish briefing/state to your relay repo via the GitHub CLI (`gh`).
3. An authorized agent submits **one** `m0/tactical-command.json` inbox payload; Companion retrieves it, validates binding fields, and the engine executes.
4. Results and refreshed snapshots are published back to the relay.

## GitHub relay requirement

**You must supply your own private GitHub repository.** Companion will **not** publish anywhere until a relay destination is configured. A fresh clone cannot target another operator’s relay.

### Configure the relay (pick one)

1. **Environment variable (recommended for CI and scripts)**  
   `OPENXCOM_COMPANION_RELAY_REPO=your-github-user/your-private-relay`  
   Optional: `OPENXCOM_COMPANION_RELAY_BRANCH=main`

2. **Gitignored local file (recommended for daily play on one PC)**  
   Copy `m0-publish/config/relay.local.example.json` → `m0-publish/config/relay.local.json` (never commit `relay.local.json`).  
   Daemons and CLIs load this automatically when the env var is unset.

Override the local file path with `OPENXCOM_COMPANION_RELAY_CONFIG` if needed.

### Authentication

- Run `gh auth login` on the game machine. Tokens stay in the GitHub CLI credential store — **never** commit tokens, `.env`, or `relay.local.json`.
- The GitHub user needs **push** access to your relay repo on the configured branch.

Full setup (schemas, validation, assistant handoff): **[m0-publish/docs/relay-github-setup.md](m0-publish/docs/relay-github-setup.md)**.

### Isolated testing

Use `m0-publish/config/m1-34e-relay-isolation.example.json` with `COMPANION_RELAY_ISOLATION_CONFIG` for e2e harnesses on **non-production** paths (separate repo or `m0-e2e/*` prefixes).

## Requirements

- **Node.js** ≥ 22 (`m0-publish/package.json`)
- **GitHub CLI** (`gh`) on the PATH for relay publish/retrieve
- **Patched OpenXcom** from the fork above, plus a legitimate **X-COM** data installation (UFO/TFTD assets are **not** included here or in the engine repo)

Install Node dependencies from `m0-publish/`:

```bash
cd m0-publish
npm ci
npm test
```

### Test baseline (M1 closeout)

Full suite: `npm test` → `scripts/run-all-node-tests.cjs` (all `test/*.test.cjs`, synthetic relay env via `test/helpers/synthetic-relay-env.cjs`).

The runner passes **`--test-concurrency=1`** to Node’s test runner so **only one test file runs at a time**. That is intentional on this repo: many harnesses spawn real `companion-on-demand-relay-daemon.cjs` children and wait up to ~15s for live startup verification. When Node runs test files in parallel (the default when concurrency is unset), concurrent subprocess spawns contend for CPU and process discovery; readiness often misses the deadline even though isolated runs pass. Serial test-file execution is the **deterministic baseline** for the canonical `npm test` command. A full run typically takes on the order of **several minutes** (often roughly 4–5 minutes on Windows with the current 813-test count); runtime varies by machine load.

This does **not** imply that every OS must use serial execution forever — only that **this** runner opts into serial test-file scheduling so integration coverage stays stable while still exercising live daemon reuse inside each file (`COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE` is cleared for the suite).

With the M1 repair batches (A–D) applied, expect **813** tests and **813** passing when run via `npm test` in a clean `m0-publish/` tree — no active game or live relay required beyond what individual tests spawn in dry-run/isolated state dirs.

## Repository layout

```
companion/
  LICENSE              # GPLv3 (Companion source)
  README.md            # this file
  AGENTS.md            # agent / Cursor conventions (tactical relay, builds)
  docs/                # M1 design notes + workspace & live-play guides
  scripts/workspace/   # example deploy + launch PowerShell (monorepo workspace)
  contrib/cursor/rules/# optional Cursor M1 tactical briefing rule
  m0-ping/             # lightweight GitHub connectivity worker
  m0-publish/          # daemons, libraries, CLIs, tests, runbooks
    lib/                 # relay, terrain, command, daemon logic
    test/                # Node test harnesses and YAML fixtures
    scripts/             # operator and CI helpers
    docs/                # tactical-command and relay runbooks
    config/              # example configs (*.example.json); never commit *.local.json
```

## Workspace setup (monorepo)

Clone this repo into `companion/` beside `engine/OpenXcom`, `local/m0/`, and `runtime/m0/` under a parent workspace directory. Full layout, build/deploy, relay env vars, and SHA verification:

- **[docs/WORKSPACE-LAYOUT.md](docs/WORKSPACE-LAYOUT.md)** — directory tree, engine branch, deploy, launch
- **[scripts/workspace/](scripts/workspace/)** — `deploy-openxcom.example.ps1`, `Start-CompanionOpenXcom.example.ps1` (`-WorkspaceRoot` or `OPENXCOM_COMPANION_WORKSPACE_ROOT`)
- **[docs/ASTER-LIVE-PLAYBOOK.md](docs/ASTER-LIVE-PLAYBOOK.md)** — cooperative play via GitHub relay (external agent)
- **[AGENTS.md](AGENTS.md)** — tactical publishing and development conventions

## Current limitations (M1)

- **Monorepo layout:** `companion-canonical-runtime.cjs` resolves paths from a workspace root containing `engine/`, `local/`, and `runtime/`. Standalone clones need that parent tree or future path overrides (see WORKSPACE-LAYOUT).
- **Relay is operator-supplied:** Missing `OPENXCOM_COMPANION_RELAY_REPO` (and missing `relay.local.json`) causes a clear configuration error instead of silent publishes.
- **Human-only actions:** `END_TURN` and human-assigned soldiers remain outside agent authority (see [AGENTS.md](AGENTS.md)).
- **No npm package:** `package.json` is marked `"private": true`; this project is published as **source on GitHub**, not as a registry package.

## Legal and attribution

- **OpenXcom** is developed by independent contributors; **Open X-Com Companion is not affiliated with, endorsed by, or maintained by the original OpenXcom project maintainers.**
- The engine fork remains under **GNU GPLv3**. Companion source is offered under **GNU GPLv3** as well (see `LICENSE`).
- **X-COM** game data and assets are proprietary; you must own a legal copy. Nothing in this repository redistributes FIRAXIS/2K content.
- Third-party dependencies (for example the `yaml` npm package, **ISC**) are installed via npm and are not vendored in this tree; comply with their licenses when distributing binaries you build yourself.

## Further reading

- [docs/WORKSPACE-LAYOUT.md](docs/WORKSPACE-LAYOUT.md) — reproduce the full workspace
- [AGENTS.md](AGENTS.md) — agent conventions for tactical relay and builds
- [docs/ASTER-LIVE-PLAYBOOK.md](docs/ASTER-LIVE-PLAYBOOK.md) — external co-op agent workflow
- [m0-publish/docs/relay-github-setup.md](m0-publish/docs/relay-github-setup.md) — create and validate your relay repo
- [m0-publish/docs/tactical-command-m1-20b.md](m0-publish/docs/tactical-command-m1-20b.md) — operator runbook for tactical publishing
