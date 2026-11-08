# M1-34E — Isolated GitHub end-to-end validation

## Purpose

Prove the M1-34B single-RETRIEVE lifecycle against **real GitHub publish and retirement**, without touching:

- Production cooperative GitHub (configured `OPENXCOM_COMPANION_RELAY_REPO` @ `main`, default `m0/*` paths)
- Production sidecar journal (`companion/m0-publish/.command-relay-sidecar-state/`)
- Production `local/m0/` relay files or live daemon (PID 16048)

## Setup (Strategy A)

1. Create a **private test repository** (empty is fine).
2. Copy `config/m1-34e-relay-isolation.example.json` to  
   `config/m1-34e-relay-isolation.local.json` (gitignored).
3. Set `repo` / `branch` / `content_paths` / `state_path` in that file.  
   Do **not** use production `main` or production `m0/tactical-command.json` paths.

## Run

```powershell
$env:COMPANION_M134E_RELAY_ISOLATION_CONFIG = "E:\Open X-Com Companion\companion\m0-publish\config\m1-34e-relay-isolation.local.json"
node "E:\Open X-Com Companion\companion\m0-publish\scripts\run-m1-34e-isolated-e2e.cjs"
```

Or pass the config path as the first argument.

## Guards (fail-closed)

- `relay-isolation-config.cjs` aborts before any GitHub mutation if the config matches production cooperative surfaces.
- Isolated daemon is spawned with `--command-relay-state-dir`, `--relay-isolation-config`, and `disableLiveDaemonReuse: true`.
- Production integrity: sidecar journal SHA-256, watched `local/m0` JSON files, and production GitHub command/result SHAs are fingerprinted before and after.

## Engine paths

The harness copies a **verify-user** tree into the temp workspace and asserts `-user` / `-config` / snapshot paths are **not** production `local/m0`.  
Optional live OpenXcom execution uses the same isolated `-user` directory; the default harness simulates the engine terminal **FAILED** result (with `destination_reached: true`) after local delivery.

## Acceptance mapping

| Criterion | Harness check |
|-----------|----------------|
| Real GitHub publish + retire | Isolated repo; remote command cleared; result present |
| FAILED preserved | Engine + remote result status `FAILED` |
| UI `COMPLETED` only when relay done | `phase: completed`, `retrieve_tx.publishedResult` + `retiredRemote` |
| No duplicate delivery | Sidecar journal single delivery record |
| Production unchanged | Before/after fingerprints |
